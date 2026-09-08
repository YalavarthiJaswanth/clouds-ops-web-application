const dns = require('node:dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}
const assert = require('node:assert/strict');
const http = require('node:http');
const AdmZip = require('adm-zip');
const app = require('../src/app');
const db = require('../src/services/db/db.service');
const storageService = require('../src/services/storage.service');

function createSampleZipBuffer() {
  const zip = new AdmZip();
  const pkg = {
    name: 'cloudops-sample-test-app',
    version: '1.0.0',
    main: 'server.js',
    scripts: { start: 'node server.js' },
    dependencies: { express: '^4.18.2' }
  };
  const code = `
    const express = require('express');
    const app = express();
    const port = process.env.PORT || 3000;
    app.get('/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));
    app.get('/', (req, res) => res.json({ message: 'CloudOps Test Application Live!' }));
    app.listen(port, () => console.log('Listening on ' + port));
  `;
  zip.addFile('package.json', Buffer.from(JSON.stringify(pkg, null, 2)));
  zip.addFile('server.js', Buffer.from(code));
  return zip.toBuffer();
}

async function runCloudOpsPlatformTests() {
  console.log('========================================================================');
  console.log('CLOUDOPS: APPLICATION TESTING & DEPLOYMENT PLATFORM TEST SUITE');
  console.log('========================================================================\n');

  // Start ephemeral server
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      console.log(`▶ Testing: ${name}...`);
      await fn();
      console.log(`✔ PASS: ${name}\n`);
      passed++;
    } catch (err) {
      console.error(`✖ FAIL: ${name}`);
      console.error(`  Error: ${err.message}\n`);
      failed++;
    }
  }

  let authToken = null;
  let tenantOrgId = null;
  let createdProjectId = null;
  let connectionId = null;

  try {
    // 1. Health Probe
    await test('1. GET /health returns healthy status', async () => {
      const res = await fetch(`${baseUrl}/health`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.status, 'healthy');
      assert.strictEqual(data.service, 'platform-service');
    });

    // 2. Auth Config Probe
    await test('2. GET /api/auth/config returns Google Client ID & 3-day session TTL', async () => {
      const res = await fetch(`${baseUrl}/api/auth/config`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.sessionTtlDays, 3);
      assert.strictEqual(typeof data.googleEnabled, 'boolean');
      assert.ok(data.googleClientId, 'Google Client ID should be present');
    });

    // 3. Signup Flow
    await test('3. POST /api/auth/signup creates user, tenant workspace, and returns 3-day session', async () => {
      const email = `dev_${Date.now()}_${Math.random().toString(36).substring(2)}@example.com`;
      const res = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Testing Developer',
          email,
          password: 'Password123!',
          organizationName: 'Dev Testing Workspace'
        })
      });
      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.ok(data.token, 'Token should be returned');
      assert.ok(data.user, 'User object should be returned');
      assert.strictEqual(data.user.email, email);
      assert.ok(data.organization, 'Organization should be created');

      authToken = data.token;
      tenantOrgId = data.organization.id;

      // Verify session cookie was set
      const cookie = res.headers.get('set-cookie');
      assert.ok(cookie && cookie.includes('session_token'), 'Session cookie must be set');
    });

    // 4. Session Persistence via /api/auth/me
    await test('4. GET /api/auth/me validates Bearer token and returns user profile', async () => {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.user);
      assert.strictEqual(data.organization.id, tenantOrgId);
      assert.strictEqual(data.membership.role, 'OWNER');
    });

    // 5. AWS Connection Creation (Vault Encryption)
    await test('5. POST /api/connections securely stores encrypted AWS credentials without leaking secret', async () => {
      const res = await fetch(`${baseUrl}/api/connections`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
          provider: 'AWS',
          name: 'Production AWS Testing Account',
          credentials: {
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            region: 'ap-south-1'
          },
          metadata: { region: 'ap-south-1' }
        })
      });
      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.ok(data.connection);
      assert.strictEqual(data.connection.provider, 'AWS');
      assert.strictEqual(data.connection.secretReference, undefined, 'Secret reference must not be returned');
      assert.strictEqual(data.connection.metadata.secretAccessKey, undefined, 'Secret key must never be exposed');
      assert.ok(data.connection.metadata.maskedAccessKey.includes('****'));

      connectionId = data.connection.id;
    });

    // 6. Test AWS Connection (Real STS Failure for Mock Keys)
    await test('6. POST /api/connections/:id/test performs real STS check and surfaces real error without faking success', async () => {
      const res = await fetch(`${baseUrl}/api/connections/${connectionId}/test`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      // Mock credentials must fail real STS check with status 400
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, 'ConnectionVerificationFailed');
      assert.ok(data.message.length > 0, 'Real error message must be returned');
    });

    // 7. Invalid ZIP Upload Rejection
    await test('7. POST /api/projects/upload rejects invalid non-zip files', async () => {
      const boundary = '----WebKitFormBoundaryTest' + Date.now();
      const body = `--${boundary}\r\nContent-Disposition: form-data; name="project"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nHello world\r\n--${boundary}--\r\n`;

      const res = await fetch(`${baseUrl}/api/projects/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Authorization': `Bearer ${authToken}`
        },
        body
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, 'Invalid file type');
    });

    // 8. Real ZIP Upload, Extraction & Analysis
    await test('8. POST /api/projects/upload accepts valid ZIP, extracts safely, and performs static analysis', async () => {
      const zipBuffer = createSampleZipBuffer();
      const boundary = '----WebKitFormBoundaryTest' + Date.now();
      const header = `--${boundary}\r\nContent-Disposition: form-data; name="project"; filename="sample-app.zip"\r\nContent-Type: application/zip\r\n\r\n`;
      const footer = `\r\n--${boundary}--\r\n`;

      const body = Buffer.concat([
        Buffer.from(header, 'utf8'),
        zipBuffer,
        Buffer.from(footer, 'utf8')
      ]);

      const res = await fetch(`${baseUrl}/api/projects/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Authorization': `Bearer ${authToken}`
        },
        body
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.ok(data.projectId);
      assert.strictEqual(data.status, 'uploaded');
      assert.ok(data.checksum, 'SHA-256 checksum must be present');
      assert.ok(data.analysis);
      assert.strictEqual(data.analysis.project.name, 'cloudops-sample-test-app');

      createdProjectId = data.projectId;
    });

    // 9. Project Retrieval
    await test('9. GET /api/projects/:projectId returns project analysis and deployment status', async () => {
      const res = await fetch(`${baseUrl}/api/projects/${createdProjectId}`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.projectId, createdProjectId);
      assert.ok(data.uploadMetadata);
      assert.strictEqual(data.uploadMetadata.filename, 'sample-app.zip');
    });

    // 10. List Projects
    await test('10. GET /api/projects lists tenant projects', async () => {
      const res = await fetch(`${baseUrl}/api/projects`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.projects));
      assert.ok(data.projects.some(p => p.projectId === createdProjectId));
    });

    // 11. AWS Deployment Preflight Validation
    await test('11. POST /api/projects/:projectId/aws/validate validates port and project name', async () => {
      // First ensure project has docker state mock or real
      storageService.updateProject(createdProjectId, {
        dockerState: {
          image: { tag: 'cloudops/test-app:latest' }
        }
      });

      const res = await fetch(`${baseUrl}/api/projects/${createdProjectId}/aws/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.valid, true);
      assert.strictEqual(data.port, 3000);
    });

    // 12. Deployment Stop & Restart Endpoints
    await test('12. POST /api/projects/:projectId/aws/stop returns error when no EC2 container is live', async () => {
      const res = await fetch(`${baseUrl}/api/projects/${createdProjectId}/aws/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        }
      });
      // Because no real EC2 instance is connected to this project yet, it should gracefully reject with 500/400
      assert.ok(res.status >= 400);
      const data = await res.json();
      assert.ok(data.message.includes('No active deployment environment found'));
    });

    // 13. Frontend UI Assets Verification
    await test('13. Frontend HTML, CSS, and JS serve with 200 OK and correct titles', async () => {
      const htmlRes = await fetch(`${baseUrl}/`);
      assert.strictEqual(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.ok(html.includes('CloudOps — Cloud-Based Application Testing & Deployment Platform'));
      assert.ok(html.includes('id="deployment-stepper"'));
      assert.ok(html.includes('id="deployment-terminal-logs"') || html.includes('id="terminal-log-output"'));

      const cssRes = await fetch(`${baseUrl}/style.css`);
      assert.strictEqual(cssRes.status, 200);
      const css = await cssRes.text();
      assert.ok(css.includes('--bg-dark-950'));
      assert.ok(css.includes('.deployment-stepper'));

      const jsRes = await fetch(`${baseUrl}/app.js`);
      assert.strictEqual(jsRes.status, 200);
      const js = await jsRes.text();
      assert.ok(js.includes('triggerDeploy'));
      assert.ok(js.includes('handleFileUpload'));
    });

    // 14. Logout Flow
    await test('14. POST /api/auth/logout revokes session token', async () => {
      const res = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      assert.strictEqual(res.status, 200);

      // Attempting to access /me with revoked token should fail with 401
      const meRes = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      assert.strictEqual(meRes.status, 401);
    });

  } finally {
    server.close();
  }

  console.log('========================================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runCloudOpsPlatformTests().catch((err) => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
