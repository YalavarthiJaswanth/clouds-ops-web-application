const path = require('path');
const express = require('express');
const helmet = require('helmet');

const app = express();

// Security headers with relaxed CSP for local static scripts, inline handlers, and Google Identity Services
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com'],
        scriptSrcAttr: ["'unsafe-inline'"],
        frameSrc: ["'self'", 'https://accounts.google.com'],
        connectSrc: ["'self'", 'https://accounts.google.com'],
        imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com', 'https://lh3.googleusercontent.com'],
        upgradeInsecureRequests: null
      }
    }
  })
);

// Standard parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Lightweight cookie parser
app.use((req, res, next) => {
  req.cookies = req.cookies || {};
  if (req.headers.cookie) {
    req.headers.cookie.split(';').forEach(c => {
      const [key, ...v] = c.trim().split('=');
      if (key) req.cookies[key] = decodeURIComponent(v.join('='));
    });
  }
  next();
});

// Initialize optional MongoDB connection in background and sync collections
const mongodbService = require('./services/db/mongodb.service');
const db = require('./services/db/db.service');
mongodbService.connect().then(async (connected) => {
  if (connected) {
    await db.syncFromMongoDB();
  }
}).catch(() => {});

// Google OAuth callback interceptor on root if redirected with ?code=...
app.get('/', (req, res, next) => {
  if (req.query.code || req.query.error) {
    const authController = require('./controllers/auth.controller');
    return authController.googleCallback(req, res);
  }
  next();
});

// Serve static frontend UI
app.use(express.static(path.join(__dirname, 'public')));

// Platform Health Check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'platform-service',
    timestamp: new Date().toISOString()
  });
});

const distRoutes = require('./routes/dist.routes');
const authRoutes = require('./routes/auth.routes');
const connectionRoutes = require('./routes/connection.routes');
const organizationRoutes = require('./routes/organization.routes');
const agentRoutes = require('./routes/agent.routes');
const awsRoutes = require('./routes/aws.routes');
const projectRoutes = require('./routes/project.routes');

// Mount Distribution & Installer routes (for Docker agent installer)
app.use(distRoutes);

// Mount core platform API routes
app.use('/api/auth', authRoutes);
app.use('/api/connections', connectionRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/aws', awsRoutes);
app.use('/api/projects', projectRoutes);

// 404 handler for unmatched API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl
  });
});

// SPA fallback for client-side navigation (e.g. /login, /signup)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/health')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Central error handling middleware
app.use((err, req, res, next) => {
  console.error(`[Platform-Error] ${err.message}`, err.stack || '');

  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    error: statusCode === 400 ? 'Bad Request' : 'Internal Server Error',
    message: err.message || 'An unexpected error occurred'
  });
});

module.exports = app;
