import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase, closeDatabase } from '../../src/db/database.mjs';
import { migrate } from '../../src/db/migrate.mjs';

async function databaseFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jy-migrations-'));
  let db;
  t.after(async () => {
    if (db?.isOpen) closeDatabase(db);
    await rm(directory, { recursive: true, force: true });
  });
  db = openDatabase(path.join(directory, 'nested', 'site.sqlite'));
  return { db, directory };
}

test('a fresh database migrates to version 1 and repeated migration preserves it', async (t) => {
  const { db } = await databaseFixture(t);
  assert.equal(migrate(db), 1);
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, [
    'admin_sessions',
    'analytics_events',
    'audit_logs',
    'inquiries',
    'schema_migrations',
  ]);
  assert.equal(migrate(db), 1);
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count,
    1,
  );
});

test('connections configure durable file storage and close releases the database', async (t) => {
  const { db, directory } = await databaseFixture(t);
  for (const [pragma, expected] of [
    ['journal_mode', 'wal'],
    ['foreign_keys', 1],
    ['busy_timeout', 5000],
    ['synchronous', 1],
  ]) {
    assert.equal(
      Object.values(db.prepare(`PRAGMA ${pragma}`).get())[0],
      expected,
    );
  }
  migrate(db);
  closeDatabase(db);
  assert.equal(db.isOpen, false);
  const reopened = openDatabase(path.join(directory, 'nested', 'site.sqlite'));
  try {
    assert.equal(migrate(reopened), 1);
  } finally {
    closeDatabase(reopened);
  }
});

async function migrationFixture(directory) {
  const copy = path.join(directory, 'db');
  await cp(new URL('../../src/db/', import.meta.url), copy, {
    recursive: true,
  });
  return {
    migrateCopy: (
      await import(pathToFileURL(path.join(copy, 'migrate.mjs')).href)
    ).migrate,
    sqlPath: path.join(copy, 'migrations', '001-initial-schema.sql'),
    copy,
  };
}

test('a changed applied SQL file is rejected without modifying migration history', async (t) => {
  const { db, directory } = await databaseFixture(t);
  const { migrateCopy, sqlPath } = await migrationFixture(directory);
  migrateCopy(db);
  const history = db.prepare('SELECT * FROM schema_migrations').all();
  assert.match(history[0].checksum, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(history[0].applied_at)));
  await writeFile(sqlPath, `${await readFile(sqlPath, 'utf8')}\n-- changed\n`);
  assert.throws(() => migrateCopy(db), /checksum/i);
  assert.deepEqual(
    db.prepare('SELECT * FROM schema_migrations').all(),
    history,
  );
});

test('a missing applied migration is rejected', async (t) => {
  const { db, directory } = await databaseFixture(t);
  const { migrateCopy, sqlPath } = await migrationFixture(directory);
  migrateCopy(db);
  await rm(sqlPath);
  assert.throws(() => migrateCopy(db), /missing/i);
});

test('a failed migration rolls back schema and migration history and can be retried', async (t) => {
  const { db, directory } = await databaseFixture(t);
  const { migrateCopy, sqlPath, copy } = await migrationFixture(directory);
  const original = await readFile(sqlPath, 'utf8');
  await writeFile(
    sqlPath,
    `${original}\nINSERT INTO table_that_does_not_exist VALUES (1);`,
  );
  assert.throws(() => migrateCopy(db), /no such table/i);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all(),
    [],
  );
  await writeFile(sqlPath, original);
  assert.equal(migrateCopy(db), 1);
  const nextPath = path.join(copy, 'migrations', '002-next.sql');
  await writeFile(
    nextPath,
    'CREATE TABLE next_table (id INTEGER); INSERT INTO missing_table VALUES (1);',
  );
  assert.throws(() => migrateCopy(db), /no such table/i);
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count,
    1,
  );
  assert.equal(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'next_table'")
      .get(),
    undefined,
  );
  await writeFile(nextPath, 'CREATE TABLE next_table (id INTEGER);');
  assert.equal(migrateCopy(db), 2);
  assert.equal(migrateCopy(db), 2);
});

test('duplicate migration versions are rejected before any schema is applied', async (t) => {
  const { db, directory } = await databaseFixture(t);
  const { migrateCopy, copy } = await migrationFixture(directory);
  await writeFile(
    path.join(copy, 'migrations', '001-duplicate.sql'),
    'CREATE TABLE duplicate_table (id INTEGER);',
  );
  assert.throws(() => migrateCopy(db), /duplicate|order/i);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all(),
    [],
  );
});

test('typed inquiry and event rows enforce statuses, event types and attribution flags', async (t) => {
  const { db } = await databaseFixture(t);
  migrate(db);
  db.prepare(
    `INSERT INTO inquiries (id, created_at, status, parent_name, phone, grade, course,
    privacy_notice_version, privacy_consent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'fixture-inquiry',
    '2026-09-08T00:00:00.000Z',
    'New',
    'Fixture Parent',
    'fixture-phone',
    'fixture-grade',
    'fixture-course',
    '2026-08-22',
    '2026-09-08T00:00:00.000Z',
  );
  for (const status of ['New', 'Contacted', 'Qualified', 'Won', 'Closed']) {
    db.prepare('UPDATE inquiries SET status = ?').run(status);
  }
  assert.throws(
    () => db.exec("UPDATE inquiries SET status = 'invalid'"),
    /CHECK/,
  );
  assert.throws(
    () => db.exec('UPDATE inquiries SET analytics_attributed = 2'),
    /CHECK/,
  );
  assert.throws(
    () => db.exec("UPDATE inquiries SET analytics_attributed = 'invalid'"),
    /INTEGER/,
  );
  const insertEvent =
    db.prepare(`INSERT INTO analytics_events (id, created_at, event_type, page, visitor_id,
    analytics_consent_at, analytics_notice_version) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const eventType of [
    'page_view',
    'section_view',
    'image_open',
    'assessment_click',
    'booking_success',
  ]) {
    insertEvent.run(
      eventType,
      '2026-09-08T00:00:00.000Z',
      eventType,
      '/',
      'fixture-visitor',
      '2026-09-08T00:00:00.000Z',
      '2026-08-22',
    );
  }
  assert.throws(
    () =>
      insertEvent.run(
        'invalid',
        '2026-09-08T00:00:00.000Z',
        'invalid',
        '/',
        'fixture-visitor',
        '2026-09-08T00:00:00.000Z',
        '2026-08-22',
      ),
    /CHECK/,
  );
  for (const [table, column] of [
    ['inquiries', 'created_at'],
    ['inquiries', 'status'],
    ['analytics_events', 'created_at'],
    ['admin_sessions', 'expires_at'],
    ['audit_logs', 'created_at'],
  ]) {
    const indexed = db
      .prepare(
        `SELECT ii.name FROM pragma_index_list(?) il, pragma_index_info(il.name) ii`,
      )
      .all(table);
    assert.ok(
      indexed.some((row) => row.name === column),
      `${table}.${column} needs an index`,
    );
  }
});

test('sessions require a SHA-256 token hash and an expiry after creation', async (t) => {
  const { db } = await databaseFixture(t);
  migrate(db);
  const insert = db.prepare(
    'INSERT INTO admin_sessions (token_hash, csrf_token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)',
  );
  insert.run('a'.repeat(64), 'b'.repeat(64), 1000, 2000);
  assert.throws(
    () => insert.run('raw-fixture-token', 'b'.repeat(64), 1000, 2000),
    /CHECK/,
  );
  assert.throws(
    () => insert.run('c'.repeat(64), 'b'.repeat(64), 1000, 1000),
    /CHECK/,
  );
  assert.throws(
    () => insert.run('d'.repeat(64), 'raw-fixture-csrf', 1000, 2000),
    /CHECK/,
  );
});

test('audit payload accepts only status metadata and permits a deleted inquiry reference', async (t) => {
  const { db } = await databaseFixture(t);
  migrate(db);
  const insert = db.prepare(
    'INSERT INTO audit_logs (id, created_at, action, inquiry_id, payload) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(
    'audit-valid',
    '2026-09-08T00:00:00.000Z',
    'inquiry_status_changed',
    'deleted-inquiry',
    '{"fromStatus":"New","toStatus":"Contacted"}',
  );
  insert.run(
    'audit-deleted',
    '2026-09-08T00:00:00.000Z',
    'inquiry_deleted',
    'deleted-inquiry',
    '{}',
  );
  for (const payload of [
    '{"phone":"fixture-phone"}',
    '{"parentName":"Fixture Parent"}',
    '{"nested":{"phone":"fixture-phone"}}',
    '{"fromStatus":"personal text"}',
    '{"toStatus":{"phone":"fixture-phone"}}',
    '[]',
    'null',
    'invalid-json',
  ]) {
    assert.throws(() =>
      insert.run(
        'audit-rejected',
        '2026-09-08T00:00:00.000Z',
        'inquiry_deleted',
        'deleted-inquiry',
        payload,
      ),
    );
  }
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM audit_logs').get().count,
    2,
  );
});
