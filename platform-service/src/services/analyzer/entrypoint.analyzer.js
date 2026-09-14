const fs = require('fs');
const path = require('path');

/**
 * Determines application entry point based on package.json, scripts, and filesystem evidence.
 */
function analyzeEntryPoint(projectDir, nodeInfo = {}) {
  const candidates = [];

  // 1. Check package.json main field
  if (nodeInfo.main) {
    const normalizedMain = nodeInfo.main.replace(/^\.\//, '');
    if (fs.existsSync(path.join(projectDir, normalizedMain))) {
      candidates.push({
        value: normalizedMain,
        confidence: 'high',
        source: 'package.json main'
      });
    }
  }

  // 2. Check package.json scripts (start, dev)
  const scripts = nodeInfo.scripts || {};
  const startScript = scripts.start || scripts.dev || '';
  if (startScript) {
    // Look for node <path> or nodemon <path>
    const match = startScript.match(/(?:node|nodemon|ts-node|tsx)\s+(?:--[\w-]+\s+)*([\w./\\-]+\.js|\.mjs|\.cjs|\.ts)/);
    if (match && match[1]) {
      const scriptEntry = match[1].replace(/^\.\//, '');
      if (fs.existsSync(path.join(projectDir, scriptEntry))) {
        candidates.push({
          value: scriptEntry,
          confidence: 'high',
          source: 'package.json start script'
        });
      }
    }
  }

  // 3. Check common standard entry point file locations
  const commonFiles = [
    'src/server.js', 'src/index.js', 'src/main.js', 'src/app.js',
    'server.js', 'index.js', 'main.js', 'app.js',
    'app.py', 'main.py', 'server.py', 'manage.py', 'wsgi.py',
    'main.go', 'server.go', 'app.go', 'index.html'
  ];

  for (const file of commonFiles) {
    if (fs.existsSync(path.join(projectDir, file))) {
      if (!candidates.some((c) => c.value === file)) {
        candidates.push({
          value: file,
          confidence: 'medium',
          source: 'common file convention'
        });
      }
    }
  }

  // Derive startCommand
  let startCommand = null;
  if (scripts.start) {
    startCommand = 'npm start';
  } else if (candidates.length > 0) {
    const best = candidates[0].value;
    if (best.endsWith('.js') || best.endsWith('.mjs') || best.endsWith('.cjs')) {
      startCommand = `node ${best}`;
    } else if (best.endsWith('.py')) {
      if (best === 'manage.py') {
        startCommand = 'python manage.py runserver 0.0.0.0:8000';
      } else {
        startCommand = `python ${best}`;
      }
    } else if (best.endsWith('.go')) {
      startCommand = './main';
    } else if (best === 'index.html') {
      startCommand = 'nginx -g "daemon off;"';
    }
  }

  if (candidates.length > 0) {
    const best = candidates[0];
    return {
      value: best.value,
      confidence: best.confidence,
      source: best.source,
      startCommand: startCommand || 'npm start',
      candidates: candidates.map((c) => c.value)
    };
  }

  return {
    value: 'unknown',
    confidence: 'none',
    source: 'none',
    startCommand: 'npm start',
    candidates: []
  };
}

module.exports = {
  analyzeEntryPoint
};
