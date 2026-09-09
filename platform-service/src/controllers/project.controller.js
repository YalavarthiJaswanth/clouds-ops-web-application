const storageService = require('../services/storage.service');
const zipService = require('../services/zip.service');
const { analyzeProject } = require('../services/analyzer');
const auditService = require('../services/audit.service');
const db = require('../services/db/db.service');

/**
 * Handle ZIP upload, safe extraction, and static analysis under tenant ownership
 */
const uploadProject = (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
        message: "A ZIP file must be uploaded under the 'project' form field."
      });
    }

    const { originalname, buffer, size } = req.file;

    if (!originalname || !originalname.toLowerCase().endsWith('.zip')) {
      return res.status(400).json({
        success: false,
        error: 'Invalid file type',
        message: 'Only .zip archive files are accepted.'
      });
    }

    if (!size || size === 0 || !buffer || buffer.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Empty archive',
        message: 'The uploaded ZIP file is empty.'
      });
    }

    const orgId = req.organization?.id || 'org-default-dev';
    const userId = req.user?.id || 'usr-default-dev';

    // Extract explicit project name if sent in form-data
    const explicitName = (req.body?.name || req.body?.projectName || '').trim();
    const requestedProjectId = (req.body?.projectId || req.body?.id || '').trim();

    // 1. Resolve or find existing project record for this authenticated tenant/user
    let existingProject = null;
    if (requestedProjectId) {
      existingProject = db.findById('projects', requestedProjectId);
      if (existingProject) {
        // Enforce ownership: reject if project belongs to another tenant/user
        if (existingProject.organizationId && existingProject.organizationId !== 'org-default-dev' && orgId !== 'org-default-dev' && existingProject.organizationId !== orgId) {
          return res.status(403).json({
            success: false,
            error: 'Forbidden',
            message: 'Project access denied: Project belongs to another organization'
          });
        }
      }
    }

    // If not found by ID, look for existing project by explicit name belonging to this organization or user
    if (!existingProject && explicitName) {
      existingProject = db.findOne('projects', p => {
        const matchesOrg = p.organizationId === orgId || (!p.organizationId && p.createdByUserId === userId);
        const matchesName = p.name && p.name.toLowerCase() === explicitName.toLowerCase();
        return matchesOrg && matchesName;
      });
    }

    // Determine final stable projectId from MongoDB/Database
    let projectId;
    if (existingProject) {
      projectId = existingProject.id || existingProject.projectId;
      console.log(`[UPLOAD] Reusing existing project: id=${projectId}, name=${existingProject.name}, orgId=${orgId}, userId=${userId}`);
    } else {
      projectId = storageService.generateProjectId();
      const initialName = explicitName || originalname.replace(/\.zip$/i, '').trim();
      console.log(`[UPLOAD] Creating new project: id=${projectId}, name=${initialName}, orgId=${orgId}, userId=${userId}`);
      existingProject = db.insert('projects', {
        id: projectId,
        projectId,
        name: initialName,
        organizationId: orgId,
        createdByUserId: userId,
        status: 'ANALYZED',
        runtime: 'Node.js'
      });
    }

    if (!projectId) {
      return res.status(500).json({
        success: false,
        error: 'PROJECT_ID_REQUIRED',
        message: 'Failed to assign a stable project ID'
      });
    }

    // 2. Create / ensure an isolated workspace for this project under this tenant
    const workspace = storageService.createWorkspace(projectId, orgId);

    // 3. Safely extract archive with Zip Slip protection
    let extraction;
    try {
      extraction = zipService.extractSafely(buffer, workspace.extractDir);
    } catch (zipErr) {
      return res.status(400).json({
        success: false,
        error: 'Archive extraction failed',
        message: zipErr.message
      });
    }

    // 4. Perform static analysis on extracted files
    const analysisReport = analyzeProject(extraction.effectiveProjectRoot);
    const finalProjectName = explicitName || analysisReport.project?.name || existingProject?.name || originalname.replace(/\.zip$/i, '').trim();
    if (!analysisReport.project) analysisReport.project = {};
    analysisReport.project.id = projectId;
    analysisReport.project.projectId = projectId;
    analysisReport.project.name = finalProjectName;
    analysisReport.uploadMetadata = {
      filename: originalname,
      sizeBytes: size,
      checksum: extraction.checksum,
      fileCount: extraction.fileCount,
      totalUncompressedBytes: extraction.totalBytes
    };

    // 5. Persist analysis record under tenant ownership
    const savedRecord = storageService.saveAnalysis(projectId, analysisReport, orgId, userId);

    // Update database record with final analyzed name and runtime
    db.update('projects', projectId, {
      name: finalProjectName,
      status: 'ANALYZED',
      runtime: analysisReport.project?.runtime || 'Node.js'
    });

    auditService.log(projectId, 'PROJECT_UPLOAD', 'SUCCESS', {
      organizationId: orgId,
      userId,
      sizeBytes: size,
      checksum: extraction.checksum,
      filename: originalname
    });

    const projectRecord = storageService.getProject(projectId, orgId) || {
      id: projectId,
      projectId,
      name: finalProjectName,
      status: 'ANALYZED',
      runtime: analysisReport.project?.runtime || 'Node.js',
      organizationId: orgId,
      createdByUserId: userId
    };

    return res.status(201).json({
      success: true,
      projectId,
      id: projectId,
      project: {
        id: projectId,
        projectId,
        name: finalProjectName,
        status: projectRecord.status || 'ANALYZED',
        runtime: projectRecord.runtime || analysisReport.project?.runtime || 'Node.js',
        organizationId: orgId,
        createdByUserId: userId
      },
      organizationId: orgId,
      status: 'uploaded',
      checksum: extraction.checksum,
      analysis: savedRecord
    });
  } catch (err) {
    return next(err);
  }
};

/**
 * List all projects belonging to the authenticated tenant
 */
const listTenantProjects = (req, res) => {
  const orgId = req.organization?.id;
  const userId = req.user?.id;
  const projects = storageService.listProjects(orgId, userId);
  return res.status(200).json({ success: true, projects });
};

/**
 * Retrieve analysis report by project ID with IDOR protection
 */
const getProjectAnalysis = (req, res) => {
  const { projectId } = req.params;
  const orgId = req.organization?.id;

  const project = storageService.getProject(projectId);
  const analysis = storageService.getAnalysis(projectId, orgId);
  if (!analysis && !project) {
    return res.status(404).json({
      error: 'Project not found',
      message: `No analysis found for project ID '${projectId}'`
    });
  }

  return res.status(200).json({
    ...(analysis || {}),
    ...(project || {})
  });
};

/**
 * Delete / clean up project workspace
 */
const deleteProject = (req, res) => {
  const { projectId } = req.params;
  const orgId = req.organization?.id;

  const analysis = storageService.getAnalysis(projectId, orgId);
  if (!analysis) {
    return res.status(404).json({
      error: 'Project not found',
      message: `No project found with ID '${projectId}'`
    });
  }

  storageService.deleteWorkspace(projectId, orgId);

  auditService.log(projectId, 'PROJECT_DELETED', 'SUCCESS', {
    organizationId: orgId,
    userId: req.user?.id
  });

  return res.status(200).json({
    message: `Workspace for project '${projectId}' deleted successfully.`,
    projectId
  });
};

module.exports = {
  uploadProject,
  listTenantProjects,
  getProjectAnalysis,
  deleteProject
};
