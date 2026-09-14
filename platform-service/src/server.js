const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {
  // Ignore
}
const app = require('./app');
const config = require('./config');

const port = parseInt(config.port, 10) || 4000;
const server = app.listen(port, '0.0.0.0', () => {
  process.stdout.write(`[platform-service] Platform running in ${config.nodeEnv} mode at http://localhost:${port}\n`);
  console.log(`[platform-service] Platform running in ${config.nodeEnv} mode at http://localhost:${port}`);
});

server.on('error', (err) => {
  process.stderr.write(`[platform-service] Server listen error: ${err.stack || err.message}\n`);
  console.error('[platform-service] Server listen error:', err);
});

if (require.main === module) {
  const keepAliveInterval = setInterval(() => {}, 60000);
  if (keepAliveInterval.unref) keepAliveInterval.unref();
}

process.on('uncaughtException', (err) => {
  console.error('[platform-service] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[platform-service] Unhandled rejection:', reason);
});

module.exports = server;
