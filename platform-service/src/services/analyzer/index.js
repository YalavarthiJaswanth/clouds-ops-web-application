const path = require('path');
const fs = require('fs');
const { analyzeNode } = require('./node.analyzer');
const { analyzePackageManager } = require('./packageManager.analyzer');
const { analyzeFramework } = require('./framework.analyzer');
const { analyzeEntryPoint } = require('./entrypoint.analyzer');
const { analyzePort } = require('./port.analyzer');
const { analyzeDevops } = require('./devops.analyzer');
const { analyzeSecurity } = require('./security.analyzer');

/**
 * Detects required environment variables from template or code files
 */
function analyzeEnvironmentRequirements(projectDir) {
  const envFiles = ['.env.example', '.env.template', '.env.sample', 'env.example', '.env.defaults'];
  const requiredEnvVars = [];

  for (const f of envFiles) {
    const p = path.join(projectDir, f);
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            const eqIdx = trimmed.indexOf('=');
            const key = eqIdx > 0 ? trimmed.substring(0, eqIdx).trim() : trimmed;
            if (key && !requiredEnvVars.includes(key)) {
              requiredEnvVars.push(key);
            }
          }
        }
      } catch {}
    }
  }

  return requiredEnvVars;
}

/**
 * Scans subdirectories for multi-service or monorepo architectures
 */
function scanSubServices(projectDir) {
  const potentialDirs = ['frontend', 'backend', 'client', 'server', 'ui', 'api', 'services', 'app', 'web'];
  const services = [];

  try {
    const entries = fs.readdirSync(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !['node_modules', '.git', 'dist', 'build', 'temporary'].includes(entry.name)) {
        const subPath = path.join(projectDir, entry.name);
        const subNode = analyzeNode(subPath);
        const hasPython = fs.existsSync(path.join(subPath, 'requirements.txt'));
        const hasDocker = fs.existsSync(path.join(subPath, 'Dockerfile'));

        if (subNode.isNode || hasPython || hasDocker) {
          const subEntryPoint = analyzeEntryPoint(subPath, subNode);
          const subPort = analyzePort(subPath, subEntryPoint);
          const subFramework = analyzeFramework(subNode);

          let role = 'service';
          const nameLower = entry.name.toLowerCase();
          if (['frontend', 'client', 'ui', 'web'].includes(nameLower)) role = 'frontend';
          else if (['backend', 'server', 'api'].includes(nameLower)) role = 'backend';

          services.push({
            name: entry.name,
            role,
            path: entry.name,
            runtime: subNode.isNode ? 'Node.js' : (hasPython ? 'Python' : 'Docker-Native'),
            framework: subFramework.name || 'Web Service',
            port: (subPort.value && subPort.value !== 'unknown') ? Number(subPort.value) : (role === 'frontend' ? 5173 : 5000),
            hasDockerfile: hasDocker
          });
        }
      }
    }
  } catch {}

  return services;
}

/**
 * Orchestrates full static analysis on an extracted project directory.
 * Purely static inspection — NO code is executed.
 * @param {string} projectDir 
 * @returns {object} structured analysis report
 */
function analyzeProject(projectDir) {
  // Check for multi-service monorepo structure
  const subServices = scanSubServices(projectDir);

  // 1. Node runtime & manifest analysis
  const nodeInfo = analyzeNode(projectDir);

  // 2. Package manager detection
  const packageManagerInfo = analyzePackageManager(projectDir, nodeInfo);

  // 3. Framework detection
  let frameworkInfo = analyzeFramework(nodeInfo);

  // 4. Entrypoint detection
  const entryPointInfo = analyzeEntryPoint(projectDir, nodeInfo);

  // 5. Port detection
  const portInfo = analyzePort(projectDir, entryPointInfo, frameworkInfo);

  // 6. Existing DevOps configuration detection
  const devopsInfo = analyzeDevops(projectDir);

  // 7. Security & secret inspection
  const securityInfo = analyzeSecurity(projectDir);

  // 8. Environment variable templates
  const envRequirements = analyzeEnvironmentRequirements(projectDir);

  // Multi-runtime detection
  let runtime = 'Unknown';
  let language = 'Unknown';
  let isSupported = false;

  if (nodeInfo.isNode) {
    runtime = 'Node.js';
    language = 'JavaScript';
    const hasTsConfig = fs.existsSync(path.join(projectDir, 'tsconfig.json'));
    const hasTsDeps =
      (nodeInfo.devDependencies && (nodeInfo.devDependencies.typescript || nodeInfo.devDependencies['ts-node'])) ||
      (nodeInfo.dependencies && (nodeInfo.dependencies.typescript || nodeInfo.dependencies['ts-node']));
    if (hasTsConfig || hasTsDeps) {
      language = 'TypeScript';
    }
    isSupported = true;
  } else if (fs.existsSync(path.join(projectDir, 'requirements.txt')) || fs.existsSync(path.join(projectDir, 'Pipfile')) || fs.existsSync(path.join(projectDir, 'pyproject.toml'))) {
    runtime = 'Python';
    language = 'Python';
    isSupported = true;
    if (fs.existsSync(path.join(projectDir, 'requirements.txt'))) {
      const reqs = fs.readFileSync(path.join(projectDir, 'requirements.txt'), 'utf8');
      if (reqs.includes('fastapi')) frameworkInfo = { name: 'FastAPI', confidence: 'high' };
      else if (reqs.includes('flask')) frameworkInfo = { name: 'Flask', confidence: 'high' };
      else if (reqs.includes('django')) frameworkInfo = { name: 'Django', confidence: 'high' };
    }
  } else if (fs.existsSync(path.join(projectDir, 'pom.xml')) || fs.existsSync(path.join(projectDir, 'build.gradle')) || fs.existsSync(path.join(projectDir, 'build.gradle.kts'))) {
    runtime = 'Java';
    language = 'Java';
    isSupported = true;
    frameworkInfo = { name: 'Spring Boot', confidence: 'medium' };
  } else if (fs.existsSync(path.join(projectDir, 'go.mod'))) {
    runtime = 'Go';
    language = 'Go';
    isSupported = true;
    frameworkInfo = { name: 'Go HTTP', confidence: 'medium' };
  } else if (fs.existsSync(path.join(projectDir, 'composer.json')) || fs.existsSync(path.join(projectDir, 'index.php'))) {
    runtime = 'PHP';
    language = 'PHP';
    isSupported = true;
    frameworkInfo = { name: 'PHP Web', confidence: 'medium' };
  } else if (fs.existsSync(path.join(projectDir, 'Gemfile'))) {
    runtime = 'Ruby';
    language = 'Ruby';
    isSupported = true;
    frameworkInfo = { name: 'Ruby Application', confidence: 'medium' };
  } else if (fs.existsSync(path.join(projectDir, 'index.html')) || fs.existsSync(path.join(projectDir, 'dist/index.html')) || fs.existsSync(path.join(projectDir, 'build/index.html')) || fs.existsSync(path.join(projectDir, 'public/index.html'))) {
    runtime = 'Static Frontend';
    language = 'HTML/CSS/JavaScript';
    isSupported = true;
    frameworkInfo = { name: 'Static HTML', confidence: 'high' };
  } else if (subServices.length > 0) {
    runtime = subServices.map(s => s.runtime).join(' / ');
    language = 'Polyglot';
    isSupported = true;
    frameworkInfo = { name: subServices.map(s => s.framework).join(' + '), confidence: 'high' };
  } else if (devopsInfo.docker.hasDockerfile) {
    runtime = 'Docker-Native';
    language = 'Dockerfile';
    isSupported = true;
    frameworkInfo = { name: 'Custom Container', confidence: 'high' };
  }

  // Determine readiness status
  let status = 'ready_for_dockerization';
  if (!isSupported) {
    status = 'unsupported_runtime';
  } else if (securityInfo.possibleSecretsDetected) {
    status = 'security_review_required';
  }

  return {
    project: {
      name: nodeInfo.name || path.basename(projectDir),
      language,
      runtime,
      version: nodeInfo.version || '1.0.0'
    },
    runtime: {
      name: runtime,
      version: nodeInfo.version || '1.0.0'
    },
    topology: {
      type: subServices.length > 1 ? 'monorepo' : 'single-service',
      serviceCount: subServices.length || 1,
      services: subServices.length > 0 ? subServices : [
        {
          name: nodeInfo.name || 'main',
          role: 'monolith',
          path: '.',
          runtime,
          framework: frameworkInfo.name || 'Generic Web Application',
          port: portInfo.value || 3000,
          hasDockerfile: devopsInfo.docker.hasDockerfile
        }
      ]
    },
    framework: {
      name: frameworkInfo.name || 'Generic Web Application',
      confidence: frameworkInfo.confidence || 'low',
      version: frameworkInfo.version || undefined
    },
    packageManager: packageManagerInfo.packageManager || (runtime === 'Python' ? 'pip' : (runtime === 'Java' ? 'maven' : 'standard')),
    packageManagerDetails: packageManagerInfo,
    entryPoint: {
      value: entryPointInfo.value || (runtime === 'Python' ? 'app.py' : (runtime === 'Java' ? 'Application.java' : 'index.js')),
      confidence: entryPointInfo.confidence || 'low',
      source: entryPointInfo.source || 'default',
      startCommand: entryPointInfo.startCommand || (runtime === 'Python' ? 'python app.py' : (nodeInfo.isNode ? 'npm start' : null))
    },
    port: {
      value: portInfo.value || 3000,
      source: portInfo.source || 'default'
    },
    dependencies: {
      production: nodeInfo.productionCount || 0,
      development: nodeInfo.developmentCount || 0,
      productionList: nodeInfo.productionList || [],
      developmentList: nodeInfo.developmentList || []
    },
    devops: {
      docker: devopsInfo.docker,
      kubernetes: devopsInfo.kubernetes,
      helm: devopsInfo.helm,
      cicd: devopsInfo.cicd,
      terraform: devopsInfo.terraform,
      details: devopsInfo.details
    },
    environmentVariables: {
      required: envRequirements,
      detectedCount: envRequirements.length
    },
    security: {
      possibleSecretsDetected: securityInfo.possibleSecretsDetected,
      findings: securityInfo.findings
    },
    status
  };
}

module.exports = {
  analyzeProject,
  analyzeEnvironmentRequirements,
  scanSubServices
};
