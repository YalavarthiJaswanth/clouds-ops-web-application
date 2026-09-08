const express = require('express');
const multer = require('multer');
const config = require('../config');
const {
  uploadProject,
  listTenantProjects,
  getProjectAnalysis,
  deleteProject
} = require('../controllers/project.controller');
const { requireAuth, requireProjectAccess } = require('../middleware/auth.middleware');
const { uploadLimiter } = require('../middleware/rateLimit.middleware');

const router = express.Router();

// Configure multer memory storage with size limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadSizeBytes,
    files: 1
  }
});

// Middleware wrapper to catch multer limit errors
const uploadMiddleware = (req, res, next) => {
  upload.single('project')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            error: 'File too large',
            message: `Uploaded file exceeds maximum allowed size of ${config.maxUploadSizeBytes / (1024 * 1024)}MB`
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({
            error: 'Too many files',
            message: 'Only one ZIP application archive may be uploaded at a time.'
          });
        }
        return res.status(400).json({
          error: 'Upload error',
          message: err.message
        });
      }
      return next(err);
    }
    next();
  });
};

const dockerRoutes = require('./docker.routes');
const awsController = require('../controllers/aws.controller');

// In development, requireAuth supports anonymous dev mode if configured
router.use(requireAuth);

router.get('/', listTenantProjects);
router.post('/upload', uploadLimiter, uploadMiddleware, uploadProject);
router.get('/:projectId', requireProjectAccess, getProjectAnalysis);
router.delete('/:projectId', requireProjectAccess, deleteProject);

// Mount Docker engine routes under /:projectId
router.use('/:projectId', requireProjectAccess, dockerRoutes);

// Deployment History & Lifecycle Routes
router.get('/:projectId/deployments', requireProjectAccess, awsController.listDeployments);
router.get('/:projectId/deployments/live', requireProjectAccess, awsController.getLiveDeployment);

// Real AWS Cloud Deployment Engine Routes
router.post('/:projectId/aws/validate', requireProjectAccess, awsController.validateProject);
router.post('/:projectId/aws/ecr', requireProjectAccess, awsController.publishECR);
router.post('/:projectId/aws/deploy', requireProjectAccess, awsController.deployProject);
router.get('/:projectId/aws/status', requireProjectAccess, awsController.getDeploymentStatus);
router.get('/:projectId/aws/logs', requireProjectAccess, awsController.getDeploymentLogs);
router.get('/:projectId/aws/resources', requireProjectAccess, awsController.getDeploymentResources);
router.post('/:projectId/aws/rollback', requireProjectAccess, awsController.rollbackDeployment);
router.post('/:projectId/aws/stop', requireProjectAccess, awsController.stopDeployment);
router.post('/:projectId/aws/restart', requireProjectAccess, awsController.restartDeployment);
router.delete('/:projectId/aws/deployment', requireProjectAccess, awsController.deleteDeployment);

module.exports = router;
