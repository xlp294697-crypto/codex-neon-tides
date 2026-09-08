import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openDatabase } from '../../src/db/database.mjs';
import { httpFixture } from '../fixtures/http-app.mjs';

test('signed sessions survive process restart, expire during reads, and persist only keyed hashes', async (t) => {
  const fixture = await httpFixture(t, { subprocess: true });
  const login = await fixture.login();
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Secure'])
    assert.equal(login.setCookie.includes(flag), true);
  await fixture.restart();
  const result = await fixture.request('/api/session', {
    headers: { cookie: login.cookie },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.csrfToken === login.csrfToken, true);
  const db = openDatabase(fixture.config.dataPath);
  fixture.onCleanup(() => db.close());
  const token = login.cookie.slice('jy_admin='.length).split('.')[0];
  const hash = createHmac('sha256', fixture.config.sessionSecret)
    .update(token)
    .digest('hex');
  const rows = db.prepare('SELECT * FROM admin_sessions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash === hash, true);
  assert.match(rows[0].csrf_token_hash, /^[a-f0-9]{64}$/);
  for (const secret of [
    token,
    login.csrfToken,
    login.cookie,
    fixture.config.sessionSecret,
  ]) {
    assert.equal(
      JSON.stringify(rows).includes(secret),
      false,
      'Stored session must contain no credentials',
    );
  }
  db.prepare('UPDATE admin_sessions SET expires_at = ?').run(Date.now());
  assert.equal(
    (
      await fixture.request('/api/session', {
        headers: { cookie: login.cookie },
      })
    ).response.status,
    401,
  );
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM admin_sessions').get().n,
    0,
  );
});

test('logout remains revoked after process restart', async (t) => {
  const fixture = await httpFixture(t, { subprocess: true });
  const login = await fixture.login();
  assert.equal(
    (
      await fixture.request('/api/logout', {
        method: 'POST',
        headers: { cookie: login.cookie, 'x-csrf-token': login.csrfToken },
      })
    ).response.status,
    200,
  );
  await fixture.restart();
  assert.equal(
    (
      await fixture.request('/api/session', {
        headers: { cookie: login.cookie },
      })
    ).response.status,
    401,
  );
});
