import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.mjs';
import { loadConfig } from '../../src/config.mjs';
import { openDatabase } from '../../src/db/database.mjs';
import { createSessionRepository } from '../../src/repositories/session-repository.mjs';
import { httpFixture } from '../fixtures/http-app.mjs';
import { startServer } from '../../src/server.mjs';
import { once } from 'node:events';

const inquiryPayload = {
  parentName: 'Synthetic parent',
  phone: '+1-202-555-0100',
  grade: 'test',
  course: 'test',
  privacyConsent: true,
};

test('analytics insert degradation does not fail readiness or valid inquiries', async (t) => {
  const fixture = await httpFixture(t);
  const db = openDatabase(fixture.config.dataPath);
  fixture.onCleanup(() => db.close());
  db.exec(
    "CREATE TRIGGER reject_analytics_insert BEFORE INSERT ON analytics_events BEGIN SELECT RAISE(ABORT, 'SENSITIVE_INSERT_SENTINEL /private/path'); END",
  );
  const logs = [];
  t.mock.method(console, 'error', (line) => logs.push(String(line)));
  const eventResponse = await fixture.request('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventType: 'page_view',
      page: '/',
      visitorId: 'synthetic-visitor',
      analyticsConsent: true,
      analyticsNoticeVersion: '2026-08-22',
      analyticsConsentAt: new Date().toISOString(),
    }),
  });
  assert.equal(eventResponse.response.status, 202);
  await assert.rejects(fixture.app.lifecycle.flushEventBuffer({ drain: true }));
  const healthBeforeHome = await fixture.request('/api/health');
  assert.equal(
    (await fetch(new URL('/', healthBeforeHome.response.url))).status,
    200,
  );
  assert.equal(healthBeforeHome.response.status, 200);
  assert.equal(
    (
      await fixture.request('/api/inquiries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(inquiryPayload),
      })
    ).response.status,
    201,
  );
  assert.equal(
    logs.some((line) => line.includes('SENSITIVE_INSERT_SENTINEL')),
    false,
  );
  assert.equal(
    logs.some((line) => line.includes('/private/path')),
    false,
  );
});

test('analytics retention degradation does not block the homepage or inquiries', async (t) => {
  const fixture = await httpFixture(t);
  const db = openDatabase(fixture.config.dataPath);
  fixture.onCleanup(() => db.close());
  const logs = [];
  t.mock.method(console, 'error', (line) => logs.push(String(line)));
  db.exec(`INSERT INTO analytics_events
    (id, created_at, event_type, page, visitor_id, analytics_consent_at, analytics_notice_version)
    VALUES ('expired', '2000-01-01T00:00:00.000Z', 'page_view', '/', 'synthetic',
      '2000-01-01T00:00:00.000Z', '2026-08-22')`);
  db.exec(
    "CREATE TRIGGER reject_analytics_prune BEFORE DELETE ON analytics_events BEGIN SELECT RAISE(ABORT, 'SENSITIVE_PRUNE_SENTINEL C:/private/file'); END",
  );
  await fixture.app.lifecycle.runDataMaintenance();
  const health = await fixture.request('/api/health');
  assert.equal((await fetch(new URL('/', health.response.url))).status, 200);
  assert.equal(health.response.status, 200);
  assert.equal(
    (
      await fixture.request('/api/inquiries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(inquiryPayload),
      })
    ).response.status,
    201,
  );
  assert.equal(
    logs.some((line) => /SENSITIVE_PRUNE_SENTINEL|private.file/.test(line)),
    false,
  );

  db.exec('DROP TRIGGER reject_analytics_prune');
});

test('shutdown analytics failures emit sanitized structured logs', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jy-shutdown-log-'));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const config = {
    ...loadConfig(
      {
        DATA_PATH: path.join(directory, 'site.db'),
        ADMIN_PASSWORD: 'Synthetic!Fixture934Key',
        SESSION_SECRET:
          'synthetic-session-secret-at-least-thirty-two-characters',
      },
      root,
    ),
    port: 0,
  };
  const errors = [];
  t.mock.method(console, 'error', (line) => errors.push(String(line)));
  t.mock.method(console, 'log', () => undefined);
  const server = startServer(config);
  t.after(async () => {
    if (server.listening) await server.shutdown('test-cleanup');
    process.exitCode = 0;
    await rm(directory, { recursive: true, force: true });
  });
  await server.ready;
  if (!server.listening) await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const accepted = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventType: 'page_view',
      page: '/',
      visitorId: 'synthetic-visitor',
      analyticsConsent: true,
      analyticsNoticeVersion: '2026-08-22',
      analyticsConsentAt: new Date().toISOString(),
    }),
  });
  assert.equal(accepted.status, 202);
  const db = openDatabase(config.dataPath);
  db.exec(
    "CREATE TRIGGER reject_shutdown_flush BEFORE INSERT ON analytics_events BEGIN SELECT RAISE(ABORT, 'SENSITIVE_SHUTDOWN_SENTINEL /private/site.db'); END",
  );
  db.close();
  await server.shutdown('SIGTERM');
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  assert.ok(errors.length >= 2);
  for (const line of errors) {
    const entry = JSON.parse(line);
    assert.match(entry.category, /^ANALYTICS_FLUSH_FAILED|SERVER_ANALYTICS_/);
    assert.doesNotMatch(
      line,
      /SENSITIVE_SHUTDOWN_SENTINEL|private|site\.db|Error:|\.mjs:\d+/i,
    );
  }
});

test('failed session cleanup does not escape the maintenance callback and can retry', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jy-storage-lifecycle-'));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const config = loadConfig(
    {
      DATA_PATH: path.join(directory, 'site.db'),
      ADMIN_PASSWORD: 'Synthetic!Fixture934Key',
      SESSION_SECRET: 'synthetic-session-secret-at-least-thirty-two-characters',
    },
    root,
  );
  const app = createApp(config);
  let db;
  t.after(async () => {
    db?.close();
    app.lifecycle.closeDatabase();
    await rm(directory, { recursive: true, force: true });
  });
  await app.lifecycle.initialize();
  db = openDatabase(config.dataPath);
  const sessions = createSessionRepository(db);
  const session = {
    tokenHash: 'a'.repeat(64),
    csrfTokenHash: 'b'.repeat(64),
    role: 'admin',
    createdAt: 0,
    expiresAt: 1,
  };
  sessions.saveSession(session);
  db.exec(
    "CREATE TRIGGER reject_cleanup BEFORE DELETE ON admin_sessions BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
  );
  t.mock.method(console, 'error', () => undefined);
  assert.doesNotThrow(() => app.lifecycle.cleanupExpiredState());
  assert.deepEqual(sessions.findSession(session.tokenHash, 0), session);
  db.exec('DROP TRIGGER reject_cleanup');
  app.lifecycle.cleanupExpiredState();
  assert.equal(sessions.findSession(session.tokenHash, 0), null);
});
