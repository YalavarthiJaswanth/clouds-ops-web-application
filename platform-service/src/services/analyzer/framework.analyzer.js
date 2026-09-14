/**
 * Detects application web framework based on declared dependencies and imports.
 */
function analyzeFramework(nodeInfo = {}) {
  const deps = {
    ...(nodeInfo.dependencies || {}),
    ...(nodeInfo.devDependencies || {})
  };

  if (deps['@nestjs/core'] || deps['@nestjs/common']) {
    return {
      name: 'NestJS',
      version: deps['@nestjs/core'] || deps['@nestjs/common'],
      confidence: 'high'
    };
  }

  if (deps['express']) {
    return {
      name: 'Express',
      version: deps['express'],
      confidence: 'high'
    };
  }

  if (deps['fastify']) {
    return {
      name: 'Fastify',
      version: deps['fastify'],
      confidence: 'high'
    };
  }

  if (deps['koa']) {
    return {
      name: 'Koa',
      version: deps['koa'],
      confidence: 'high'
    };
  }

  if (deps['hono']) {
    return {
      name: 'Hono',
      version: deps['hono'],
      confidence: 'high'
    };
  }

  if (deps['next']) {
    return {
      name: 'Next.js',
      version: deps['next'],
      requiresBuild: true,
      confidence: 'high'
    };
  }

  if (deps['@angular/core']) {
    return {
      name: 'Angular',
      version: deps['@angular/core'],
      requiresBuild: true,
      confidence: 'high'
    };
  }

  if (deps['nuxt'] || deps['nuxt3']) {
    return {
      name: 'Nuxt',
      version: deps['nuxt'] || deps['nuxt3'],
      requiresBuild: true,
      confidence: 'high'
    };
  }

  if (deps['@remix-run/react'] || deps['@remix-run/node']) {
    return {
      name: 'Remix',
      version: deps['@remix-run/react'] || deps['@remix-run/node'],
      requiresBuild: true,
      confidence: 'high'
    };
  }

  if (deps['react'] || deps['react-dom']) {
    return {
      name: deps['vite'] ? 'React (Vite)' : 'React',
      version: deps['react'] || deps['react-dom'],
      requiresBuild: Boolean(deps['vite'] || nodeInfo.scripts?.build),
      confidence: 'high'
    };
  }

  if (deps['vue']) {
    return {
      name: deps['vite'] ? 'Vue (Vite)' : 'Vue.js',
      version: deps['vue'],
      requiresBuild: Boolean(deps['vite'] || nodeInfo.scripts?.build),
      confidence: 'high'
    };
  }

  if (deps['svelte'] || deps['@sveltejs/kit']) {
    return {
      name: 'Svelte',
      version: deps['svelte'] || deps['@sveltejs/kit'],
      requiresBuild: true,
      confidence: 'high'
    };
  }

  if (deps['astro']) {
    return {
      name: 'Astro',
      version: deps['astro'],
      requiresBuild: true,
      confidence: 'high'
    };
  }

  return {
    name: nodeInfo.isNode ? 'Node.js Application' : 'Generic Application',
    version: null,
    requiresBuild: Boolean(nodeInfo.scripts?.build),
    confidence: nodeInfo.isNode ? 'medium' : 'none'
  };
}

module.exports = {
  analyzeFramework
};
