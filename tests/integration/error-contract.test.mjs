import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/database.mjs';
import { httpFixture } from '../fixtures/http-app.mjs';

const inquiry = { parentName: 'Synthetic parent', phone: '+1-202-555-0100', grade: 'test', course: 'test', privacyConsent: true };
const post = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
function contract(result, status, code, secrets = []) {
  assert.equal(result.response.status, status);
  assert.deepEqual(Object.keys(result.body), ['error']);
  assert.deepEqual(Object.keys(result.body.error).sort(), ['code', 'message', 'requestId']);
  assert.equal(result.body.error.code, code);
  assert.equal(typeof result.body.error.message, 'string');
  assert.match(result.body.error.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(result.response.headers.get('x-request-id'), result.body.error.requestId);
  for (const value of ['stack', 'SELECT ', 'INSERT ', 'SQLITE', 'node_modules', ...secrets]) {
    assert.equal(JSON.stringify(result.body).includes(value), false, 'Error envelope leaked internal details');
  }
}

test('validation, authentication, CSRF and rate-limit errors have stable safe codes and unique request IDs', async (t) => {
  const fixture = await httpFixture(t);
  const cases = [
    ['/api/inquiries', post('{'), 400, 'INVALID_JSON'],
    ['/api/inquiries', post({ ...inquiry, phone: 'invalid' }), 422, 'INVALID_INQUIRY'],
    ['/api/inquiries', post({ ...inquiry, privacyConsent: false }), 422, 'PRIVACY_CONSENT_REQUIRED'],
    ['/api/events', post({}), 422, 'INVALID_ANALYTICS_CONSENT'],
    ['/api/session', {}, 401, 'UNAUTHENTICATED'],
  ];
  const ids = new Set();
  for (const [url, options, status, code] of cases) {
    const result = await fixture.request(url, options);
    contract(result, status, code);
    ids.add(result.body.error.requestId);
  }
  const login = await fixture.login();
  contract(await fixture.request('/api/logout', { method: 'POST', headers: { cookie: login.cookie } }), 403, 'CSRF_FAILED', [login.cookie]);
  for (let i = 0; i < 5; i++) contract(await fixture.request('/api/login', post({ password: 'synthetic-wrong' })), 401, 'INVALID_CREDENTIALS');
  contract(await fixture.request('/api/login', post({ password: 'synthetic-wrong' })), 429, 'RATE_LIMITED');
  assert.equal(ids.size, cases.length);
  const success = await fixture.request('/api/catalog', { headers: { 'x-request-id': 'untrusted-client-value' } });
  assert.match(success.response.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
});

test('unexpected SQLite failure hides internal details and logs only request ID and category', async (t) => {
  const fixture = await httpFixture(t);
  const db = openDatabase(fixture.config.dataPath);
  fixture.onCleanup(() => db.close());
  db.exec("CREATE TRIGGER reject_inquiry BEFORE INSERT ON inquiries BEGIN SELECT RAISE(ABORT, 'SQLITE synthetic-sensitive-path password cookie'); END");
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const result = await fixture.request('/api/inquiries', post(inquiry));
  contract(result, 500, 'INTERNAL_ERROR', [fixture.config.dataPath, fixture.config.adminPassword, 'synthetic-sensitive-path', 'password', 'cookie']);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].includes(result.body.error.requestId), true);
  assert.equal(logs[0].includes('INTERNAL_ERROR'), true);
  assert.equal(logs[0].includes('synthetic-sensitive-path'), false);
  contract(await fixture.request('/api/health'), 503, 'SERVICE_UNAVAILABLE');
});

test('failed session persistence never returns a login cookie and recovers after storage is repaired', async (t) => {
  const fixture = await httpFixture(t);
  const db = openDatabase(fixture.config.dataPath);
  fixture.onCleanup(() => db.close());
  db.exec("CREATE TRIGGER reject_session BEFORE INSERT ON admin_sessions BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  t.mock.method(console, 'error', () => undefined);
  const result = await fixture.request('/api/login', post({ password: fixture.config.adminPassword }));
  contract(result, 500, 'INTERNAL_ERROR', [fixture.config.adminPassword, fixture.config.sessionSecret]);
  assert.equal(result.response.headers.get('set-cookie'), null);
  db.exec('DROP TRIGGER reject_session');
  const login = await fixture.login();
  assert.equal((await fixture.request('/api/session', { headers: { cookie: login.cookie } })).response.status, 200);
});
