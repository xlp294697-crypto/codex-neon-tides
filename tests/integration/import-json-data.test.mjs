import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../../src/db/database.mjs';
import { migrate } from '../../src/db/migrate.mjs';
import { createInquiryRepository } from '../../src/repositories/inquiry-repository.mjs';
import { createAnalyticsRepository } from '../../src/repositories/analytics-repository.mjs';
import { inquiry, event } from '../fixtures/storage.mjs';

const tool = fileURLToPath(new URL('../../tools/import-json-data.mjs', import.meta.url));

async function fixture(t, data = { version: 1, inquiries: [inquiry('a'), inquiry('b')], events: [event('a'), event('b'), event('c')] }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jy-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.json');
  const database = path.join(directory, 'site.db');
  const bytes = `${JSON.stringify(data)}\n`;
  await writeFile(source, bytes);
  return { source, database, bytes };
}

function run({ source, database }, args = []) {
  return spawnSync(process.execPath, [tool, '--source', source, '--database', database, ...args], { encoding: 'utf8' });
}

function readData(database) {
  const db = openDatabase(database);
  try { return { inquiries: createInquiryRepository(db).findAll(), events: createAnalyticsRepository(db).findAll() }; }
  finally { db.close(); }
}

test('import is idempotent by record ID, reconciles counts, and leaves source bytes untouched', async (t) => {
  const files = await fixture(t);
  const sourceMetadata = await stat(files.source);
  const first = run(files);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { dryRun: false, inquiries: { source: 2, imported: 2, skipped: 0 }, events: { source: 3, imported: 3, skipped: 0 } });
  const second = run(files);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { dryRun: false, inquiries: { source: 2, imported: 0, skipped: 2 }, events: { source: 3, imported: 0, skipped: 3 } });
  const result = readData(files.database);
  assert.equal(result.inquiries.length, 2);
  assert.equal(result.events.length, 3);
  assert.deepEqual(result.inquiries.find((row) => row.id === 'a'), inquiry('a'));
  assert.equal(await readFile(files.source, 'utf8'), files.bytes);
  assert.equal((await stat(files.source)).mtimeMs, sourceMetadata.mtimeMs);
  assert.doesNotMatch(first.stdout + first.stderr + second.stdout + second.stderr, /Synthetic|00000000000|synthetic-visitor/);
});

test('dry run validates and reconciles without creating or changing destination files', async (t) => {
  const files = await fixture(t);
  const dry = run(files, ['--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).inquiries.imported, 2);
  await assert.rejects(stat(files.database), { code: 'ENOENT' });
  assert.equal(run(files).status, 0);
  const before = await readFile(files.database);
  const repeated = run(files, ['--dry-run']);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout), { dryRun: true, inquiries: { source: 2, imported: 0, skipped: 2 }, events: { source: 3, imported: 0, skipped: 3 } });
  assert.deepEqual(await readFile(files.database), before);
});

test('invalid source records fail without printing values or importing any records', async (t) => {
  const files = await fixture(t, { version: 1, inquiries: [inquiry('a')], events: [event('a'), event('b', { eventType: 'secret-personal-field' })] });
  const result = run(files);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^IMPORT_FAILED:/m);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-personal-field|Synthetic|00000000000/);
  await assert.rejects(stat(files.database), { code: 'ENOENT' });
});

test('a destination write failure rolls back inquiries and earlier events in the import', async (t) => {
  const files = await fixture(t);
  const db = openDatabase(files.database);
  migrate(db);
  db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON analytics_events WHEN NEW.id = 'b' BEGIN SELECT RAISE(ABORT, 'private-trigger-message'); END");
  db.close();
  const result = run(files);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^IMPORT_FAILED:/m);
  assert.doesNotMatch(result.stdout + result.stderr, /private-trigger-message|Synthetic|00000000000/);
  assert.deepEqual(readData(files.database), { inquiries: [], events: [] });
});

test('duplicate source IDs reconcile as skipped and existing records are never overwritten', async (t) => {
  const files = await fixture(t, { version: 1, inquiries: [inquiry('a'), inquiry('a', { status: 'Won' })], events: [event('a'), event('a')] });
  const result = run(files);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).inquiries, { source: 2, imported: 1, skipped: 1 });
  assert.deepEqual(JSON.parse(result.stdout).events, { source: 2, imported: 1, skipped: 1 });
  assert.equal(readData(files.database).inquiries[0].status, 'New');
});

test('import strips unapproved personal identifiers and attribution without analytics consent', async (t) => {
  const files = await fixture(t, { version: 1, inquiries: [inquiry('a', { visitorId: 'private', ip: 'private', source: 'private', sourcePage: '/private', sourceSection: 'private', referrer: 'private' })], events: [event('a', { phone: 'private', ip: 'private' })] });
  assert.equal(run(files).status, 0);
  const result = readData(files.database);
  assert.deepEqual(result.inquiries[0], inquiry('a'));
  assert.deepEqual(result.events[0], event('a'));
});

test('malformed structures, invalid dates, missing consent, unsafe paths and CLI flags fail safely', async (t) => {
  for (const data of [null, {}, { version: 2, inquiries: [], events: [] }, { version: 1, inquiries: [], events: {} },
    { version: 1, inquiries: [inquiry('a', { createdAt: 'invalid' })], events: [] },
    { version: 1, inquiries: [], events: [event('a', { analyticsConsentAt: undefined })] }]) {
    const files = await fixture(t, data);
    const result = run(files);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /^IMPORT_FAILED:/m);
  }
  const files = await fixture(t);
  assert.notEqual(run(files, ['--unknown']).status, 0);
  assert.notEqual(run({ ...files, database: files.source }).status, 0);
  assert.equal(await readFile(files.source, 'utf8'), files.bytes);
});
