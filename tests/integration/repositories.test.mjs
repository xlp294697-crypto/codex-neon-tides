import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/database.mjs';
import { migrate } from '../../src/db/migrate.mjs';
import { createInquiryRepository } from '../../src/repositories/inquiry-repository.mjs';
import { createAnalyticsRepository } from '../../src/repositories/analytics-repository.mjs';
import { createSessionRepository } from '../../src/repositories/session-repository.mjs';
import { createAuditRepository } from '../../src/repositories/audit-repository.mjs';
import { inquiry, event, timestamp } from '../fixtures/storage.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jy-repositories-'));
  const db = openDatabase(path.join(directory, 'site.db'));
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  migrate(db);
  return db;
}

test('inquiries round trip public fields in newest-first order without extra personal identifiers', async (t) => {
  const repository = createInquiryRepository(await fixture(t));
  repository.create({ ...inquiry('older', { createdAt: '2026-09-07T00:00:00.000Z' }), ip: 'private', visitorId: 'private' });
  repository.create(inquiry('newer', { analyticsAttributed: true, source: 'campaign' }));
  assert.deepEqual(repository.findAll(), [inquiry('newer', { analyticsAttributed: true, source: 'campaign' }), inquiry('older', { createdAt: '2026-09-07T00:00:00.000Z' })]);
});

test('allowed statuses update timestamps and record non-personal audit history', async (t) => {
  const db = await fixture(t);
  const repository = createInquiryRepository(db);
  repository.create(inquiry('status'));
  for (const status of ['Contacted', 'Qualified', 'Won', 'Closed', 'New']) {
    assert.equal(repository.updateStatus('status', status, timestamp), true);
    assert.equal(repository.findAll()[0].status, status);
  }
  assert.throws(() => repository.updateStatus('status', 'invalid', timestamp));
  assert.equal(repository.updateStatus('absent', 'New', timestamp), false);
  assert.equal(repository.findAll()[0].updatedAt, timestamp);
  const audits = createAuditRepository(db).findAll();
  assert.equal(audits.length, 5);
  assert.deepEqual(audits[0].payload, { fromStatus: 'Closed', toStatus: 'New' });
});

test('deletion and its non-personal audit commit together, including rollback on audit failure', async (t) => {
  const db = await fixture(t);
  const repository = createInquiryRepository(db);
  repository.create(inquiry('delete'));
  db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  assert.throws(() => repository.remove('delete'), /synthetic failure/);
  assert.equal(repository.findAll().length, 1);
  db.exec('DROP TRIGGER reject_audit');
  assert.equal(repository.remove('delete'), true);
  assert.equal(repository.remove('delete'), false);
  assert.equal(repository.findAll().length, 0);
  const audits = createAuditRepository(db).findAll();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'inquiry_deleted');
  assert.equal(audits[0].inquiryId, 'delete');
  assert.deepEqual(audits[0].payload, {});
  assert.equal(JSON.stringify(audits).includes('Synthetic'), false);
});

test('invalid analytics event rolls back the complete batch', async (t) => {
  const repository = createAnalyticsRepository(await fixture(t));
  assert.throws(() => repository.insertBatch([event('valid'), event('invalid', { eventType: 'invalid' })]));
  assert.deepEqual(repository.findAll(), []);
  repository.insertBatch([event('valid')]);
  assert.deepEqual(repository.findAll(), [event('valid')]);
});

test('retention keeps cutoff boundary and newest records; inquiry capacity audits removals', async (t) => {
  const db = await fixture(t);
  const analytics = createAnalyticsRepository(db);
  analytics.insertBatch([
    event('expired', { createdAt: '2026-09-05T00:00:00.000Z' }),
    event('boundary', { createdAt: '2026-09-06T00:00:00.000Z' }),
    event('new'),
  ]);
  assert.equal(analytics.prune({ cutoff: '2026-09-06T00:00:00.000Z', maxRecords: 2 }), 1);
  assert.deepEqual(analytics.findAll().map((row) => row.id), ['boundary', 'new']);
  assert.equal(analytics.prune({ cutoff: '2026-09-06T00:00:00.000Z', maxRecords: 1 }), 1);
  assert.deepEqual(analytics.findAll().map((row) => row.id), ['new']);
  const inquiries = createInquiryRepository(db);
  inquiries.create(inquiry('old', { createdAt: '2026-09-07T00:00:00.000Z' }));
  inquiries.create(inquiry('new'));
  assert.equal(inquiries.prune(1), 1);
  assert.deepEqual(inquiries.findAll().map((row) => row.id), ['new']);
  assert.equal(createAuditRepository(db).findAll()[0].inquiryId, 'old');
});

test('session repository persists only hashes and rejects expired sessions at the boundary', async (t) => {
  const db = await fixture(t);
  const repository = createSessionRepository(db);
  const session = { tokenHash: 'a'.repeat(64), csrfTokenHash: 'b'.repeat(64), role: 'admin', createdAt: 100, expiresAt: 200 };
  repository.saveSession(session);
  assert.deepEqual(repository.findSession(session.tokenHash, 199), session);
  assert.equal(repository.findSession(session.tokenHash, 200), null);
  repository.saveSession(session);
  repository.saveSession({ ...session, tokenHash: 'c'.repeat(64), expiresAt: 300 });
  assert.equal(repository.prune(200), 1);
  assert.equal(repository.deleteSession('c'.repeat(64)), true);
  assert.equal(repository.deleteSession('c'.repeat(64)), false);
  assert.throws(() => repository.saveSession({ ...session, tokenHash: 'raw-token' }));
});
