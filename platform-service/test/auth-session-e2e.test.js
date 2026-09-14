const assert = require('assert');
const http = require('http');
const app = require('../src/app');

async function runAuthSessionTests() {
  console.log('========================================================================');
  console.log('CLOUDOPS: PRODUCTION AUTHENTICATION & SESSION PERSISTENCE TEST SUITE');
  console.log('========================================================================\n');

  let server;
  let baseUrl;
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      process.stdout.write(`▶ Testing: ${name}... `);
      await fn();
      console.log('✔ PASS');
      passed++;
    } catch (err) {
      console.log('✖ FAIL');
      console.error(`  Error: ${err.message}`);
      if (err.stack) {
        console.error(err.stack.split('\n').slice(1, 4).join('\n'));
      }
      failed++;
    }
  }

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    let sessionCookie = null;
    let authToken = null;
    let initialSessionId = null;
    const testEmail = `auth_tester_${Date.now()}@cloudops.internal`;
    const testPassword = 'StrongPassword123!';

    // 1. Public Auth Configuration
    await test('1. GET /api/auth/config exposes Google configuration and 3-day session TTL', async () => {
      const res = await fetch(`${baseUrl}/api/auth/config`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.sessionTtlDays, 3);
      assert.ok(typeof data.googleEnabled === 'boolean');
    });

    // 2. Signup creates user, workspace, session record, and sets HttpOnly cookie
    await test('2. POST /api/auth/signup creates account, 3-day session, and sets session_token cookie', async () => {
      const res = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Production Auth Tester',
          email: testEmail,
          password: testPassword,
          organizationName: 'Testing Team'
        })
      });
      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.token, 'Session rawToken must be returned');
      assert.ok(data.sessionId, 'Session ID must be returned');
      assert.strictEqual(data.user.email, testEmail);
      assert.strictEqual(data.user.passwordHash, undefined, 'Password hash must never be returned');
      assert.strictEqual(data.user.salt, undefined, 'Salt must never be returned');

      authToken = data.token;
      initialSessionId = data.sessionId;

      const setCookie = res.headers.get('set-cookie');
      assert.ok(setCookie, 'Set-Cookie header must be present');
      assert.ok(setCookie.includes('session_token='), 'session_token cookie must be set');
      assert.ok(setCookie.toLowerCase().includes('httponly'), 'Cookie must have HttpOnly flag');
      assert.ok(setCookie.toLowerCase().includes('samesite=lax'), 'Cookie must have SameSite=lax');

      // Extract cookie value
      const match = setCookie.match(/session_token=([^;]+)/);
      assert.ok(match && match[1]);
      sessionCookie = match[1];
    });

    // 3. Duplicate email signup rejection
    await test('3. POST /api/auth/signup rejects duplicate email registration with 409 Conflict', async () => {
      const res = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Duplicate Tester',
          email: testEmail,
          password: testPassword
        })
      });
      assert.strictEqual(res.status, 409);
      const data = await res.json();
      assert.strictEqual(data.error, 'SignupError');
      assert.ok(data.message.includes('already exists'));
    });

    // 4. Session authentication via Bearer header
    await test('4. GET /api/auth/me authenticates via Authorization: Bearer header', async () => {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.user.email, testEmail);
      assert.strictEqual(data.sessionId, initialSessionId);
    });

    // 5. Session authentication via HttpOnly cookie
    await test('5. GET /api/auth/me authenticates via session_token Cookie without Authorization header', async () => {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { 'Cookie': `session_token=${sessionCookie}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.user.email, testEmail);
      assert.strictEqual(data.sessionId, initialSessionId);
    });

    // 6. Sign in with invalid password
    await test('6. POST /api/auth/login rejects invalid password with 401 Unauthorized', async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: testEmail,
          password: 'WrongPassword!'
        })
      });
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.strictEqual(data.error, 'AuthenticationError');
    });

    // 7. Sign in with valid credentials creates new session
    let secondToken;
    let secondSessionId;
    await test('7. POST /api/auth/login authenticates and creates new active session', async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: testEmail,
          password: testPassword
        })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.token);
      assert.ok(data.sessionId);
      assert.notStrictEqual(data.sessionId, initialSessionId, 'New login must create distinct sessionId');

      secondToken = data.token;
      secondSessionId = data.sessionId;
    });

    // 8. Sign Out revokes session and clears cookie
    await test('8. POST /api/auth/logout revokes session on server and clears session_token cookie', async () => {
      const res = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${secondToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);

      const setCookie = res.headers.get('set-cookie');
      assert.ok(setCookie);
      assert.ok(setCookie.includes('session_token=;') || setCookie.includes('Max-Age=0') || setCookie.includes('Expires='));
    });

    // 9. Revoked session is completely rejected
    await test('9. GET /api/auth/me rejects revoked session token with 401 Unauthorized', async () => {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${secondToken}` }
      });
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.strictEqual(data.error, 'Unauthorized');
    });

    // 10. Direct project creation via POST /api/projects
    await test('10. POST /api/projects creates project record and returns non-null projectId', async () => {
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({ name: 'cloudops-demo-app' })
      });
      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.projectId);
      assert.strictEqual(typeof data.projectId, 'string');
      assert.notStrictEqual(data.projectId, '');
      assert.strictEqual(data.project.name, 'cloudops-demo-app');
    });

    // 11. User isolation - User B cannot view User A's project
    await test('11. User B cannot access User A project (Multi-tenant isolation enforced)', async () => {
      // Create user B
      const userBRes = await fetch(`${baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'User B',
          email: `user_b_${Date.now()}@cloudops.internal`,
          password: 'Password123!',
          organizationName: "User B Workspace"
        })
      });
      const userBData = await userBRes.json();
      const userBToken = userBData.token;

      // User A created a project in test 10; fetch all projects for user B
      const listRes = await fetch(`${baseUrl}/api/projects`, {
        headers: { 'Authorization': `Bearer ${userBToken}` }
      });
      assert.strictEqual(listRes.status, 200);
      const listData = await listRes.json();
      assert.ok(Array.isArray(listData.projects));
      assert.strictEqual(listData.projects.length, 0, 'User B must not see User A projects');
    });

    // 12. Google OAuth configuration check
    await test('12. POST /api/auth/google rejects request without credentials with 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, 'BadRequest');
    });

  } finally {
    server.close();
  }

  console.log('\n========================================================================');
  console.log(`AUTH & SESSION SUITE: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runAuthSessionTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
