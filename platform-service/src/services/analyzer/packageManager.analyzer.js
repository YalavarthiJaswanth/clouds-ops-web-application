const fs = require('fs');
const path = require('path');

/**
 * Detects package manager from lockfiles and package.json configuration.
 */
function analyzePackageManager(projectDir, nodeInfo = {}) {
  const hasNpmLock = fs.existsSync(path.join(projectDir, 'package-lock.json'));
  const hasYarnLock = fs.existsSync(path.join(projectDir, 'yarn.lock'));
  const hasPnpmLock = fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'));
  const hasBunLock = fs.existsSync(path.join(projectDir, 'bun.lockb')) || fs.existsSync(path.join(projectDir, 'bun.lock'));

  const detected = [];
  if (hasNpmLock) detected.push('npm');
  if (hasYarnLock) detected.push('yarn');
  if (hasPnpmLock) detected.push('pnpm');
  if (hasBunLock) detected.push('bun');

  if (detected.length > 1) {
    return {
      packageManager: detected[0] || 'npm',
      conflict: true,
      hasLockfile: true,
      lockfileName: hasNpmLock ? 'package-lock.json' : (hasYarnLock ? 'yarn.lock' : 'pnpm-lock.yaml'),
      detectedLockfiles: detected,
      details: `Multiple conflicting lockfiles detected: ${detected.join(', ')}`
    };
  }

  if (detected.length === 1) {
    const pm = detected[0];
    const lockfileName = pm === 'npm' ? 'package-lock.json' : (pm === 'yarn' ? 'yarn.lock' : (pm === 'pnpm' ? 'pnpm-lock.yaml' : 'bun.lockb'));
    return {
      packageManager: pm,
      hasLockfile: true,
      lockfileName,
      conflict: false,
      confidence: 'high'
    };
  }

  // Check package.json `packageManager` field (corepack / modern npm)
  if (nodeInfo && nodeInfo.packageJson && nodeInfo.packageJson.packageManager) {
    const pmStr = String(nodeInfo.packageJson.packageManager).toLowerCase();
    const pm = pmStr.startsWith('yarn') ? 'yarn' : (pmStr.startsWith('pnpm') ? 'pnpm' : 'npm');
    return {
      packageManager: pm,
      hasLockfile: false,
      lockfileName: null,
      conflict: false,
      confidence: 'medium'
    };
  }

  // Fallback if package.json exists but no lockfile
  if (nodeInfo && nodeInfo.isNode) {
    return {
      packageManager: 'npm',
      hasLockfile: false,
      lockfileName: null,
      conflict: false,
      confidence: 'medium',
      note: 'package.json found without lockfile — using standard npm install'
    };
  }

  // Python
  if (fs.existsSync(path.join(projectDir, 'requirements.txt')) || fs.existsSync(path.join(projectDir, 'Pipfile')) || fs.existsSync(path.join(projectDir, 'pyproject.toml'))) {
    return {
      packageManager: 'pip',
      hasLockfile: fs.existsSync(path.join(projectDir, 'Pipfile.lock')) || fs.existsSync(path.join(projectDir, 'poetry.lock')),
      lockfileName: fs.existsSync(path.join(projectDir, 'poetry.lock')) ? 'poetry.lock' : (fs.existsSync(path.join(projectDir, 'Pipfile.lock')) ? 'Pipfile.lock' : null),
      conflict: false,
      confidence: 'high'
    };
  }

  // Java
  if (fs.existsSync(path.join(projectDir, 'pom.xml'))) {
    return {
      packageManager: 'maven',
      hasLockfile: false,
      conflict: false,
      confidence: 'high'
    };
  }
  if (fs.existsSync(path.join(projectDir, 'build.gradle')) || fs.existsSync(path.join(projectDir, 'build.gradle.kts'))) {
    return {
      packageManager: 'gradle',
      hasLockfile: false,
      conflict: false,
      confidence: 'high'
    };
  }

  // Go
  if (fs.existsSync(path.join(projectDir, 'go.mod'))) {
    return {
      packageManager: 'go',
      hasLockfile: fs.existsSync(path.join(projectDir, 'go.sum')),
      lockfileName: fs.existsSync(path.join(projectDir, 'go.sum')) ? 'go.sum' : null,
      conflict: false,
      confidence: 'high'
    };
  }

  // PHP
  if (fs.existsSync(path.join(projectDir, 'composer.json'))) {
    return {
      packageManager: 'composer',
      hasLockfile: fs.existsSync(path.join(projectDir, 'composer.lock')),
      lockfileName: fs.existsSync(path.join(projectDir, 'composer.lock')) ? 'composer.lock' : null,
      conflict: false,
      confidence: 'high'
    };
  }

  // Ruby
  if (fs.existsSync(path.join(projectDir, 'Gemfile'))) {
    return {
      packageManager: 'bundler',
      hasLockfile: fs.existsSync(path.join(projectDir, 'Gemfile.lock')),
      lockfileName: fs.existsSync(path.join(projectDir, 'Gemfile.lock')) ? 'Gemfile.lock' : null,
      conflict: false,
      confidence: 'high'
    };
  }

  return {
    packageManager: 'none',
    hasLockfile: false,
    lockfileName: null,
    conflict: false,
    confidence: 'none'
  };
}

module.exports = {
  analyzePackageManager
};
