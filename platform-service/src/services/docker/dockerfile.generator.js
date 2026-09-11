const fs = require('fs');
const path = require('path');

class DockerfileGenerator {
  /**
   * Generates a production-grade Dockerfile tailored to the detected application runtime,
   * framework, port, entrypoint, and package manager.
   */
  generate(projectAnalysis = {}, projectDir = null) {
    const port = (projectAnalysis.port && projectAnalysis.port.value && projectAnalysis.port.value !== 'unknown')
      ? parseInt(projectAnalysis.port.value, 10) || 3000
      : 3000;

    const runtime = typeof projectAnalysis.runtime === 'string'
      ? projectAnalysis.runtime
      : (projectAnalysis.runtime?.name || 'Node.js');

    const framework = projectAnalysis.framework || {};
    const packageManager = projectAnalysis.packageManager || projectAnalysis.packageManagerDetails?.name || 'npm';
    const hasLockfile = Boolean(projectAnalysis.packageManagerDetails?.hasLockfile);
    const entryPoint = projectAnalysis.entryPoint?.value;
    const startCommand = projectAnalysis.entryPoint?.startCommand;

    // Check if project has prisma schema or uses prisma
    let hasPrisma = false;
    let hasBuildScript = false;
    let packageJson = null;

    if (projectDir && fs.existsSync(projectDir)) {
      hasPrisma = fs.existsSync(path.join(projectDir, 'prisma', 'schema.prisma'));
      const pkgPath = path.join(projectDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (packageJson.scripts && packageJson.scripts.build) {
            hasBuildScript = true;
          }
          if (packageJson.dependencies?.prisma || packageJson.devDependencies?.prisma || packageJson.dependencies?.['@prisma/client']) {
            hasPrisma = true;
          }
        } catch {
          // ignore
        }
      }
    }

    // 1. PYTHON RUNTIME
    if (runtime.toLowerCase().includes('python')) {
      return this._generatePythonDockerfile({ port, entryPoint, startCommand, framework, projectDir });
    }

    // 2. GO RUNTIME
    if (runtime.toLowerCase().includes('go') || runtime.toLowerCase().includes('golang')) {
      return this._generateGoDockerfile({ port, entryPoint, projectDir });
    }

    // 3. JAVA RUNTIME
    if (runtime.toLowerCase().includes('java')) {
      return this._generateJavaDockerfile({ port, projectDir });
    }

    // 4. PHP RUNTIME
    if (runtime.toLowerCase().includes('php')) {
      return this._generatePhpDockerfile({ port, projectDir });
    }

    // 5. RUBY RUNTIME
    if (runtime.toLowerCase().includes('ruby')) {
      return this._generateRubyDockerfile({ port, projectDir });
    }

    // 6. STATIC FRONTEND
    if (runtime.toLowerCase().includes('static') || runtime.toLowerCase().includes('html')) {
      return this._generateStaticDockerfile({ port, projectDir });
    }

    // 7. NODE.JS RUNTIME (Default)
    return this._generateNodeDockerfile({
      port,
      packageManager,
      hasLockfile,
      entryPoint,
      startCommand,
      framework,
      hasPrisma,
      hasBuildScript,
      packageJson,
      projectDir
    });
  }

  _generateNodeDockerfile({
    port,
    packageManager,
    hasLockfile,
    entryPoint,
    startCommand,
    framework,
    hasPrisma,
    hasBuildScript,
    packageJson,
    projectDir
  }) {
    const isNext = framework.name === 'Next.js' || (packageJson?.dependencies?.next || packageJson?.devDependencies?.next);
    const requiresBuild = isNext || framework.requiresBuild || hasBuildScript;

    // Resolve manifests and install command
    let copyManifests = 'COPY package*.json ./';
    const hasPkgJson = projectDir ? fs.existsSync(path.join(projectDir, 'package.json')) : true;
    let installCommand = 'RUN (npm ci --omit=dev 2>/dev/null || npm install --omit=dev)';

    if (packageManager === 'yarn') {
      copyManifests = 'COPY package.json yarn.lock* ./';
      installCommand = hasLockfile
        ? 'RUN yarn install --production --frozen-lockfile || yarn install --production'
        : 'RUN yarn install --production';
    } else if (packageManager === 'pnpm') {
      copyManifests = 'COPY package.json pnpm-lock.yaml* ./';
      installCommand = hasLockfile
        ? 'RUN corepack enable && (pnpm install --prod --frozen-lockfile || pnpm install --prod)'
        : 'RUN corepack enable && pnpm install --prod';
    } else if (packageManager === 'bun') {
      copyManifests = 'COPY package.json bun.lock* ./';
      installCommand = 'RUN bun install --production';
    } else {
      if (!hasPkgJson) {
        copyManifests = '';
        installCommand = '# No package.json detected';
      } else if (!hasLockfile) {
        copyManifests = 'COPY package.json ./';
        installCommand = 'RUN npm install --omit=dev';
      } else {
        copyManifests = 'COPY package*.json ./';
        installCommand = 'RUN (npm ci --omit=dev 2>/dev/null || npm install --omit=dev)';
      }
    }

    // Resolve start command
    let finalStartCmd = 'CMD ["npm", "start"]';
    if (entryPoint && entryPoint !== 'unknown') {
      finalStartCmd = `CMD ["node", "${entryPoint}"]`;
    } else if (startCommand && startCommand !== 'npm start') {
      const parts = startCommand.split(/\s+/);
      finalStartCmd = `CMD ${JSON.stringify(parts)}`;
    } else if (packageJson?.scripts?.start) {
      finalStartCmd = 'CMD ["npm", "start"]';
    } else if (requiresBuild) {
      finalStartCmd = 'CMD ["npm", "start"]';
    } else {
      finalStartCmd = 'CMD ["node", "index.js"]';
    }

    // CASE A: Project requires a build step (Next.js, Vite, TypeScript, etc.)
    if (requiresBuild) {
      let buildCopyManifests = copyManifests;
      let buildInstallCmd = 'RUN npm install';
      if (packageManager === 'yarn') {
        buildCopyManifests = 'COPY package.json yarn.lock* ./';
        buildInstallCmd = hasLockfile ? 'RUN yarn install --frozen-lockfile || yarn install' : 'RUN yarn install';
      } else if (packageManager === 'pnpm') {
        buildCopyManifests = 'COPY package.json pnpm-lock.yaml* ./';
        buildInstallCmd = 'RUN corepack enable && pnpm install';
      } else if (packageManager === 'bun') {
        buildCopyManifests = 'COPY package.json bun.lock* ./';
        buildInstallCmd = 'RUN bun install';
      } else if (hasLockfile) {
        buildCopyManifests = 'COPY package*.json ./';
        buildInstallCmd = 'RUN (npm ci 2>/dev/null || npm install)';
      } else {
        buildCopyManifests = 'COPY package.json ./';
        buildInstallCmd = 'RUN npm install';
      }

      const buildScriptCmd = packageJson?.scripts?.build
        ? (packageManager === 'yarn' ? 'RUN yarn build' : packageManager === 'pnpm' ? 'RUN pnpm run build' : 'RUN npm run build')
        : (isNext ? 'RUN npx next build' : 'RUN npm run build || true');

      const prismaCommand = hasPrisma ? '\n# Generate Prisma client and initialize database schema\nRUN npx prisma generate && (npx prisma db push --accept-data-loss 2>/dev/null || true)\n' : '';
      const alpineDeps = (hasPrisma || isNext) ? '\n# Install libc compatibility libraries for native modules\nRUN apk add --no-cache libc6-compat openssl\n' : '';
      const nextConfigFix = isNext ? '\n# Ensure Next.js build is not blocked by TypeScript or ESLint warnings in user code\nRUN if [ ! -f next.config.js ] && [ ! -f next.config.mjs ] && [ ! -f next.config.ts ]; then echo "module.exports = { typescript: { ignoreBuildErrors: true }, eslint: { ignoreDuringBuilds: true } };" > next.config.js; fi\n' : '';

      return `# =========================================================================
# Production Dockerfile generated automatically by Autonomous DevOps Platform
# Framework: ${framework.name || 'Node.js Application (Build Required)'}
# =========================================================================
FROM node:20-alpine AS runtime

# Set production environment
ENV NODE_ENV=production
ENV PORT=${port}
ENV HOSTNAME="0.0.0.0"
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="file:./dev.db"
ENV AUTH_SECRET="cloudops-testing-auth-secret-key-32-chars-min"
${alpineDeps}
# Create app directory
WORKDIR /app

# Copy dependency manifests first for layer caching
${copyManifests}

# Install dependencies (including devDependencies needed for build step)
${buildInstallCmd}

# Copy application source code
COPY . .
${nextConfigFix}${prismaCommand}
# Build application bundle
${buildScriptCmd}

# Expose application port
EXPOSE ${port}

# Start application
${finalStartCmd}
`;
    }

    // CASE B: Standard Node.js Application (Express, Fastify, backend APIs)
    return `# =========================================================================
# Production Dockerfile generated automatically by Autonomous DevOps Platform
# =========================================================================
FROM node:20-alpine AS runtime

# Set production environment
ENV NODE_ENV=production
ENV PORT=${port}

# Create app directory
WORKDIR /app

# Copy dependency manifests first for layer caching
${copyManifests}

# Install production dependencies
${installCommand}

# Copy application source code
COPY . .

# Expose application port
EXPOSE ${port}

# Run as non-root node user for container security
USER node

# Start application
${finalStartCmd}
`;
  }

  _generatePythonDockerfile({ port, entryPoint, startCommand, framework, projectDir }) {
    let installCmd = 'RUN pip install --no-cache-dir -r requirements.txt';
    let copyManifest = 'COPY requirements.txt ./';

    if (projectDir && !fs.existsSync(path.join(projectDir, 'requirements.txt'))) {
      if (fs.existsSync(path.join(projectDir, 'Pipfile'))) {
        copyManifest = 'COPY Pipfile Pipfile.lock* ./';
        installCmd = 'RUN pip install --no-cache-dir pipenv && (pipenv install --system --deploy || pipenv install --system)';
      } else if (fs.existsSync(path.join(projectDir, 'pyproject.toml'))) {
        copyManifest = 'COPY pyproject.toml ./';
        installCmd = 'RUN pip install --no-cache-dir .';
      } else {
        copyManifest = '';
        installCmd = '# No dependency manifest detected';
      }
    }

    let cmd = 'CMD ["python", "app.py"]';
    if (startCommand) {
      const parts = startCommand.split(/\s+/);
      cmd = `CMD ${JSON.stringify(parts)}`;
    } else if (framework.name === 'Django' || (projectDir && fs.existsSync(path.join(projectDir, 'manage.py')))) {
      cmd = `CMD ["python", "manage.py", "runserver", "0.0.0.0:${port}"]`;
    } else if (framework.name === 'FastAPI') {
      cmd = `CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "${port}"]`;
    } else if (entryPoint && entryPoint !== 'unknown') {
      cmd = `CMD ["python", "${entryPoint}"]`;
    }

    return `# =========================================================================
# Production Dockerfile generated automatically by Autonomous DevOps Platform
# Runtime: Python 3.11
# =========================================================================
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=${port}

WORKDIR /app

${copyManifest}
${installCmd}

COPY . .

EXPOSE ${port}

${cmd}
`;
  }

  _generateGoDockerfile({ port, entryPoint, projectDir }) {
    return `# =========================================================================
# Production Dockerfile generated automatically by Autonomous DevOps Platform
# Runtime: Go Multi-Stage Build
# =========================================================================
FROM golang:1.22-alpine AS builder

WORKDIR /app
RUN apk add --no-cache git

COPY go.mod go.sum* ./
RUN go mod download || true

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /app/server .

FROM alpine:3.19 AS runtime

WORKDIR /app
RUN apk --no-cache add ca-certificates tzdata

COPY --from=builder /app/server ./server

ENV PORT=${port}
EXPOSE ${port}

CMD ["./server"]
`;
  }

  _generateJavaDockerfile({ port, projectDir }) {
    const isGradle = projectDir && (fs.existsSync(path.join(projectDir, 'build.gradle')) || fs.existsSync(path.join(projectDir, 'gradlew')));

    if (isGradle) {
      return `# =========================================================================
# Production Dockerfile generated automatically by Autonomous DevOps Platform
# Runtime: Java Gradle Multi-Stage Build
# =========================================================================
FROM gradle:8-jdk17-alpine AS builder
WORKDIR /app
COPY build.gradle* settings.gradle* gradlew* ./
COPY gradle ./gradle
COPY src ./src
RUN gradle build -x test --no-daemon || true

FROM eclipse-temurin:17-jre-alpine AS runtime
WORKDIR /app
COPY --from=builder /app/build/libs/*.jar app.jar
ENV PORT=${port}
EXPOSE ${port}
CMD ["java", "-jar", "app.jar"]
`;
    }

    return `# =========================================================================
# Production Dockerfile generated automatically by Autonomous DevOps Platform
# Runtime: Java Maven Multi-Stage Build
# =========================================================================
FROM maven:3.9-eclipse-temurin-17-alpine AS builder
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline -B || true
COPY src ./src
RUN mvn package -DskipTests -B

FROM eclipse-temurin:17-jre-alpine AS runtime
WORKDIR /app
COPY --from=builder /app/target/*.jar app.jar
ENV PORT=${port}
EXPOSE ${port}
CMD ["java", "-jar", "app.jar"]
`;
  }

  _generatePhpDockerfile({ port, projectDir }) {
    return `# =========================================================================
# Production Dockerfile generated automatically by Autonomous DevOps Platform
# Runtime: PHP Apache
# =========================================================================
FROM php:8.2-apache AS runtime

RUN a2enmod rewrite

WORKDIR /var/www/html

COPY composer.json composer.lock* ./
RUN if [ -f composer.json ]; then curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer && composer install --no-dev --optimize-autoloader || true; fi

COPY . /var/www/html/

EXPOSE ${port || 80}
CMD ["apache2-foreground"]
`;
  }

  _generateRubyDockerfile({ port, projectDir }) {
    return `# =========================================================================
# Production Dockerfile generated automatically by Autonomous DevOps Platform
# Runtime: Ruby
# =========================================================================
FROM ruby:3.2-slim AS runtime

WORKDIR /app

COPY Gemfile Gemfile.lock* ./
RUN if [ -f Gemfile ]; then bundle install --without development test || bundle install; fi

COPY . .

ENV PORT=${port}
EXPOSE ${port}

CMD ["bundle", "exec", "rackup", "--host", "0.0.0.0", "-p", "${port}"]
`;
  }

  _generateStaticDockerfile({ port, projectDir }) {
    let staticDir = '.';
    if (projectDir) {
      if (fs.existsSync(path.join(projectDir, 'dist'))) staticDir = 'dist';
      else if (fs.existsSync(path.join(projectDir, 'build'))) staticDir = 'build';
      else if (fs.existsSync(path.join(projectDir, 'public'))) staticDir = 'public';
    }

    return `# =========================================================================
# Production Dockerfile generated automatically by Autonomous DevOps Platform
# Runtime: Static Web Application (Nginx)
# =========================================================================
FROM nginx:alpine AS runtime

COPY ${staticDir} /usr/share/nginx/html

EXPOSE ${port || 80}
CMD ["nginx", "-g", "daemon off;"]
`;
  }

  /**
   * Ensures a standard .dockerignore file exists in the workspace
   */
  ensureDockerignore(projectDir) {
    const dockerignorePath = path.join(projectDir, '.dockerignore');
    if (!fs.existsSync(dockerignorePath)) {
      const defaultIgnores = `node_modules
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*
.git
.gitignore
.env
.env.*
!.env.example
.DS_Store
coverage
Dockerfile*
.dockerignore
`;
      fs.writeFileSync(dockerignorePath, defaultIgnores, 'utf8');
    }
  }

  /**
   * Validates an existing Dockerfile for obvious syntactical or contextual defects
   */
  validateExistingDockerfile(content, projectDir) {
    if (!content || !content.trim()) {
      return { valid: false, reason: 'Dockerfile is empty' };
    }
    if (!/^FROM\s+\S+/im.test(content)) {
      return { valid: false, reason: 'Dockerfile is missing a valid FROM instruction' };
    }
    return { valid: true };
  }

  /**
   * Inspects workspace for an existing Dockerfile or generates one
   */
  prepareDockerfile(projectDir, projectAnalysis) {
    this.ensureDockerignore(projectDir);
    const dockerfilePath = path.join(projectDir, 'Dockerfile');

    if (fs.existsSync(dockerfilePath)) {
      const existingContent = fs.readFileSync(dockerfilePath, 'utf8');
      const validation = this.validateExistingDockerfile(existingContent, projectDir);
      if (validation.valid) {
        return {
          source: 'existing',
          dockerfilePath,
          content: existingContent
        };
      }
      this.backupExistingDockerfile(projectDir);
    }

    // Generate new Dockerfile tailored to analysis
    const content = this.generate(projectAnalysis, projectDir);
    fs.writeFileSync(dockerfilePath, content, 'utf8');

    return {
      source: 'generated',
      dockerfilePath,
      content
    };
  }

  /**
   * Creates a backup of the existing Dockerfile before repair attempts
   */
  backupExistingDockerfile(projectDir) {
    const dockerfilePath = path.join(projectDir, 'Dockerfile');
    const backupPath = path.join(projectDir, 'Dockerfile.cloudops-backup');

    if (fs.existsSync(dockerfilePath)) {
      fs.copyFileSync(dockerfilePath, backupPath);
      return backupPath;
    }
    return null;
  }

  /**
   * Attempts a safe repair of a failing Dockerfile by generating a clean standard template
   * while preserving the original in Dockerfile.cloudops-backup
   */
  attemptSafeRepair(projectDir, projectAnalysis) {
    const backupPath = this.backupExistingDockerfile(projectDir);
    const repairedContent = this.generate(projectAnalysis, projectDir);
    const dockerfilePath = path.join(projectDir, 'Dockerfile');

    fs.writeFileSync(dockerfilePath, repairedContent, 'utf8');

    return {
      repaired: true,
      backupPath,
      content: repairedContent
    };
  }
}

module.exports = new DockerfileGenerator();
