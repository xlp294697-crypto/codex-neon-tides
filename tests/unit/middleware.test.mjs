import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../../src/middleware/auth.mjs';
import { requireCsrf } from '../../src/middleware/csrf.mjs';
import { createRateLimiter } from '../../src/middleware/rate-limit.mjs';
import { openDatabase } from '../../src/db/database.mjs';
import { migrate } from '../../src/db/migrate.mjs';
import { createSessionRepository } from '../../src/repositories/session-repository.mjs';

function auth(t) {
  const db = openDatabase(':memory:');
  migrate(db);
  t.after(() => db.close());
  return createAuth({
    adminPassword: 'synthetic-test-only', adminPasswordHash: '',
    sessionSecret: 'synthetic-session-signing-key-not-a-real-secret',
    sessionHours: 1, cookieSecure: true,
  }, createSessionRepository(db));
}

test('signed sessions enforce CSRF binding, expiry, revocation and cookie flags', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const security = auth(t);
  const session = security.newSession();
  const req = { headers: { cookie: `other=x; jy_admin=${session.cookie}`, 'x-csrf-token': session.csrfToken } };
  assert.equal(security.verifyAdminPassword('wrong'), false);
  assert.equal(security.verifyAdminPassword('synthetic-test-only'), true);
  assert.equal(Boolean(security.requireAdmin(req)), true);
  assert.doesNotThrow(() => requireCsrf(req, session));
  assert.throws(() => requireCsrf({ headers: { 'x-csrf-token': auth(t).newSession().csrfToken } }, session), { status: 403 });
  const cookie = security.sessionCookie(session.cookie);
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=3600', 'Secure']) assert.equal(cookie.includes(flag), true);
  assert.equal(security.sessionCookie('', 0).includes('Max-Age=0'), true);
  assert.equal(security.readSession({ headers: { cookie: `jy_admin=${session.cookie}x` } }), null);
  assert.equal(auth(t).readSession(req), null);
  security.invalidateSession(session.tokenHash);
  assert.throws(() => security.requireAdmin(req), { status: 401 });
  const expiring = security.newSession();
  t.mock.timers.tick(3600000);
  assert.equal(security.readSession({ headers: { cookie: `jy_admin=${expiring.cookie}` } }), null);
});

test('rate limits allow the exact quota, reset on the window edge and isolate keys and app instances', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const limiter = createRateLimiter({ trustProxy: false });
  const bucket = limiter.buckets.events;
  assert.equal(limiter.hitRateLimit(bucket, 'a', 2, 500), false);
  assert.equal(limiter.hitRateLimit(bucket, 'a', 2, 500), false);
  assert.equal(limiter.hitRateLimit(bucket, 'a', 2, 500), true);
  assert.equal(limiter.hitRateLimit(bucket, 'b', 2, 500), false);
  t.mock.timers.tick(500);
  assert.equal(limiter.hitRateLimit(bucket, 'a', 2, 500), false);
  limiter.clearRateLimit(bucket, 'a');
  assert.equal(limiter.hitRateLimit(bucket, 'a', 1, 500), false);
  assert.equal(createRateLimiter({}).buckets.events.size, 0);
  t.mock.timers.tick(500);
  limiter.cleanupExpiredState();
  assert.equal(bucket.size, 0);
  const req = { headers: { 'x-forwarded-for': ' spoofed, proxy ' }, socket: { remoteAddress: 'socket-ip' } };
  assert.equal(limiter.getRequestIp(req), 'socket-ip');
  assert.equal(createRateLimiter({ trustProxy: true }).getRequestIp(req), 'spoofed');
});
