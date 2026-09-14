const fs = require('fs');
const path = require('path');

/**
 * Statically detects application port from code files and configuration templates.
 */
function analyzePort(projectDir, entryPointInfo = {}, frameworkInfo = {}) {
  // 1. Check existing Dockerfile EXPOSE first
  const dockerfilePath = path.join(projectDir, 'Dockerfile');
  if (fs.existsSync(dockerfilePath)) {
    try {
      const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
      const exposeMatch = dockerfileContent.match(/^\s*EXPOSE\s+(\d{2,5})/mi);
      if (exposeMatch && exposeMatch[1]) {
        const portNum = parseInt(exposeMatch[1], 10);
        if (portNum > 0 && portNum <= 65535) {
          return {
            value: portNum,
            source: 'Dockerfile EXPOSE',
            confidence: 'high'
          };
        }
      }
    } catch {}
  }

  // 2. Candidate files to search in order of relevance
  const candidateFiles = [];

  if (entryPointInfo.value && entryPointInfo.value !== 'unknown') {
    candidateFiles.push(entryPointInfo.value);
  }

  // Add other likely files
  const searchFiles = [
    'src/server.js', 'src/app.js', 'src/index.js', 'src/main.js',
    'server.js', 'app.js', 'index.js', 'main.js',
    'app.py', 'main.py', 'server.py', 'manage.py', 'wsgi.py',
    'main.go', 'server.go', 'app.go',
    'src/main/resources/application.properties', 'src/main/resources/application.yml',
    'vite.config.js', 'vite.config.ts', 'vite.config.mjs',
    'next.config.js', 'next.config.mjs', 'next.config.ts',
    '.env.example', '.env.sample', '.env.template',
    'config.js', 'src/config/index.js', 'src/config.js'
  ];

  for (const f of searchFiles) {
    if (!candidateFiles.includes(f)) {
      candidateFiles.push(f);
    }
  }

  // Regex patterns to detect port declarations in source code (Node, Python, Go, Java)
  const codePatterns = [
    // const PORT = process.env.PORT || 3000;
    /(?:PORT|port)\s*=\s*(?:process\.env\.PORT\s*\|\|\s*|parseInt\([^)]+\)\s*\|\|\s*)(\d{2,5})/i,
    // process.env.PORT || 3000
    /process\.env\.PORT\s*\|\|\s*(\d{2,5})/,
    // app.listen(3000) or .listen(process.env.PORT || 3000)
    /\.listen\(\s*(?:process\.env\.PORT\s*\|\|\s*|['"]?)(\d{2,5})/i,
    // fastify.listen({ port: 5000 }) or { port: process.env.PORT || 5000 }
    /\.listen\(\s*\{\s*(?:.*?\s*)?port\s*:\s*(?:process\.env\.PORT\s*\|\|\s*)?(\d{2,5})/i,
    // Python uvicorn.run(..., port=8000) or app.run(port=5000)
    /(?:uvicorn\.run|app\.run)\s*\([^)]*port\s*=\s*(\d{2,5})/i,
    // Go http.ListenAndServe(":8080", ...)
    /http\.ListenAndServe\s*\(\s*["']:(\d{2,5})["']/i,
    // Spring Boot server.port=8080
    /server\.port\s*[=:]\s*(\d{2,5})/i,
    // port: 5000 in config or options
    /\bport\s*:\s*(\d{2,5})\b/i
  ];

  // Check code files first
  for (const relFile of candidateFiles) {
    const fullPath = path.join(projectDir, relFile);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch (e) {
      continue;
    }

    for (const pattern of codePatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        const portNum = parseInt(match[1], 10);
        if (portNum > 0 && portNum <= 65535) {
          return {
            value: portNum,
            source: `application source (${relFile})`,
            confidence: 'high'
          };
        }
      }
    }
  }

  // Check .env.example / .env.sample / .env.template
  const envFiles = ['.env.example', '.env.sample', '.env.template', '.env.defaults'];
  for (const envFile of envFiles) {
    const fullPath = path.join(projectDir, envFile);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const match = content.match(/^PORT\s*=\s*(\d{2,5})/m);
        if (match && match[1]) {
          const portNum = parseInt(match[1], 10);
          if (portNum > 0 && portNum <= 65535) {
            return {
              value: portNum,
              source: `configuration template (${envFile})`,
              confidence: 'high'
            };
          }
        }
      } catch (e) {
        // ignore
      }
    }
  }

  // 3. Fallback to framework conventions
  const fwName = (frameworkInfo.name || '').toLowerCase();
  if (fwName.includes('next')) {
    return { value: 3000, source: 'framework convention (Next.js)', confidence: 'medium' };
  }
  if (fwName.includes('vite')) {
    return { value: 5173, source: 'framework convention (Vite)', confidence: 'medium' };
  }
  if (fwName.includes('django') || fwName.includes('fastapi')) {
    return { value: 8000, source: `framework convention (${frameworkInfo.name})`, confidence: 'medium' };
  }
  if (fwName.includes('flask')) {
    return { value: 5000, source: 'framework convention (Flask)', confidence: 'medium' };
  }
  if (fwName.includes('spring')) {
    return { value: 8080, source: 'framework convention (Spring Boot)', confidence: 'medium' };
  }

  // Default web convention
  return {
    value: 3000,
    source: 'default web convention',
    confidence: 'low'
  };
}

module.exports = {
  analyzePort
};
