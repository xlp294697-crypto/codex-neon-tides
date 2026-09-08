import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  readdir,
  copyFile,
  stat,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/db/database.mjs';
import { migrate } from '../../src/db/migrate.mjs';
import { backupDatabase } from '../../deploy/release-db.mjs';

const root = new URL('../../', import.meta.url);
function run(tool, args) {
  const result = spawnSync(
    process.execPath,
    [
      new URL(`tools/${tool}.mjs`, root).pathname.replace(/^\/(\w:)/, '$1'),
      ...args,
    ],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    output: result.stdout.trim(),
    error: result.stderr,
  };
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jy-recovery-'));
  const source = path.join(directory, 'site.db');
  const backups = path.join(directory, 'backups');
  const db = openDatabase(source);
  migrate(db);
  db.exec(`INSERT INTO inquiries (id,created_at,parent_name,phone,grade,course,privacy_notice_version,privacy_consent_at) VALUES ('synthetic-inquiry','2026-09-08T00:00:00Z','Synthetic parent','synthetic-phone','synthetic-grade','synthetic-course','v1','2026-09-08T00:00:00Z');
    INSERT INTO analytics_events (id,created_at,event_type,page,visitor_id,analytics_consent_at,analytics_notice_version) VALUES ('synthetic-event','2026-09-08T00:00:00Z','page_view','/','synthetic-visitor','2026-09-08T00:00:00Z','v1');
    INSERT INTO audit_logs (id,created_at,action,inquiry_id) VALUES ('synthetic-audit','2026-09-08T00:00:00Z','inquiry_deleted','synthetic-deleted');`);
  db.prepare(
    'INSERT INTO admin_sessions(token_hash,csrf_token_hash,created_at,expires_at) VALUES (?,?,1,9999999999999)',
  ).run('a'.repeat(64), 'b'.repeat(64));
  t.after(async () => {
    if (db.isOpen) db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, source, backups, db };
}
function snapshot(db) {
  return [
    'inquiries',
    'analytics_events',
    'admin_sessions',
    'schema_migrations',
    'audit_logs',
  ].map((table) =>
    JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()),
  );
}
async function makeBackup(f) {
  const result = run('backup-sqlite', [
    '--database',
    f.source,
    '--directory',
    f.backups,
  ]);
  assert.equal(result.status, 0, result.error);
  const files = (await readdir(f.backups)).filter((name) =>
    name.endsWith('.db'),
  );
  assert.equal(files.length, 1);
  return path.join(f.backups, files[0]);
}
test('online backup captures committed WAL records and portable verified restore preserves every table', async (t) => {
  const f = await fixture(t);
  const expected = snapshot(f.db);
  const backup = await makeBackup(f);
  const bytes = await readFile(backup);
  const sidecar = await readFile(`${backup}.sha256.txt`, 'utf8');
  assert.equal(
    sidecar,
    `${createHash('sha256').update(bytes).digest('hex')}  ${path.basename(backup)}\n`,
  );
  const moved = path.join(f.directory, path.basename(backup));
  await copyFile(backup, moved);
  await copyFile(`${backup}.sha256.txt`, `${moved}.sha256.txt`);
  assert.equal(run('verify-backup', ['--backup', moved]).status, 0);
  const target = path.join(f.directory, 'restored.db');
  assert.equal(
    run('restore-sqlite', [
      '--backup',
      moved,
      '--database',
      target,
      '--app-stopped',
      '--confirm-target',
      target,
    ]).status,
    0,
  );
  const restored = new DatabaseSync(target);
  try {
    assert.deepEqual(snapshot(restored), expected);
  } finally {
    restored.close();
  }
  if (process.platform !== 'win32')
    assert.equal((await stat(target)).mode & 0o777, 0o600);
});
test('restore requires stop confirmation and refuses an active WAL database before replacement', async (t) => {
  const f = await fixture(t);
  const backup = await makeBackup(f);
  const before = snapshot(f.db);
  for (const extra of [[], ['--app-stopped', '--confirm-target', f.source]]) {
    const result = run('restore-sqlite', [
      '--backup',
      backup,
      '--database',
      f.source,
      ...extra,
    ]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(
      result.output + result.error,
      /synthetic-phone|Synthetic parent/,
    );
  }
  assert.deepEqual(snapshot(f.db), before);
});
test('replacement first creates a verified safety recovery point containing the newer state', async (t) => {
  const f = await fixture(t);
  const backup = await makeBackup(f);
  const old = snapshot(f.db);
  f.db.exec("UPDATE inquiries SET status='Contacted'");
  const current = snapshot(f.db);
  f.db.close();
  const result = run('restore-sqlite', [
    '--backup',
    backup,
    '--database',
    f.source,
    '--app-stopped',
    '--confirm-target',
    f.source,
  ]);
  assert.equal(result.status, 0, result.error);
  const safetyDir = path.join(f.directory, 'pre-restore-backups');
  const safety = path.join(
    safetyDir,
    (await readdir(safetyDir)).find((name) => name.endsWith('.db')),
  );
  assert.equal(run('verify-backup', ['--backup', safety]).status, 0);
  for (const [file, expected] of [
    [safety, current],
    [f.source, old],
  ]) {
    const db = new DatabaseSync(file);
    try {
      assert.deepEqual(snapshot(db), expected);
    } finally {
      db.close();
    }
  }
});
test('missing or corrupt hash and incompatible migrations fail before touching the target', async (t) => {
  const f = await fixture(t);
  const backup = await makeBackup(f);
  f.db.close();
  const original = await readFile(f.source);
  const sidecar = await readFile(`${backup}.sha256.txt`);
  for (const value of [null, `${'0'.repeat(64)}  ${path.basename(backup)}\n`]) {
    if (value === null) await rm(`${backup}.sha256.txt`);
    else await writeFile(`${backup}.sha256.txt`, value);
    assert.equal(
      run('restore-sqlite', [
        '--backup',
        backup,
        '--database',
        f.source,
        '--app-stopped',
        '--confirm-target',
        f.source,
      ]).status,
      1,
    );
    assert.deepEqual(await readFile(f.source), original);
  }
  await writeFile(`${backup}.sha256.txt`, sidecar);
  const db = new DatabaseSync(backup);
  db.exec(`UPDATE schema_migrations SET checksum='${'c'.repeat(64)}'`);
  db.close();
  await writeFile(
    `${backup}.sha256.txt`,
    `${createHash('sha256')
      .update(await readFile(backup))
      .digest('hex')}  ${path.basename(backup)}\n`,
  );
  assert.equal(
    run('restore-sqlite', [
      '--backup',
      backup,
      '--database',
      f.source,
      '--app-stopped',
      '--confirm-target',
      f.source,
    ]).status,
    1,
  );
  assert.deepEqual(await readFile(f.source), original);
});
test('integrity and foreign key violations reject backups even with a matching hash', async (t) => {
  const f = await fixture(t);
  const backup = await makeBackup(f);
  const db = new DatabaseSync(backup);
  db.exec(
    'PRAGMA foreign_keys=OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (9);',
  );
  db.close();
  for (const corrupt of [false, true]) {
    if (corrupt) await writeFile(backup, 'synthetic invalid SQLite');
    await writeFile(
      `${backup}.sha256.txt`,
      `${createHash('sha256')
        .update(await readFile(backup))
        .digest('hex')}  ${path.basename(backup)}\n`,
    );
    assert.equal(run('verify-backup', ['--backup', backup]).status, 1);
  }
});
test('retention removes only expired generated backup pairs after a successful verified backup', async (t) => {
  const f = await fixture(t);
  const backup = await makeBackup(f);
  const expired = path.join(
    f.backups,
    `jiuyue-20000101T000000000Z-${'a'.repeat(32)}.db`,
  );
  await copyFile(backup, expired);
  await copyFile(`${backup}.sha256.txt`, `${expired}.sha256.txt`);
  await writeFile(path.join(f.backups, 'operator-recovery.db'), 'keep');
  assert.equal(
    run('backup-sqlite', ['--database', f.source, '--directory', f.backups])
      .status,
    0,
  );
  const names = await readdir(f.backups);
  assert.ok(!names.includes(path.basename(expired)));
  assert.ok(names.includes('operator-recovery.db'));
  assert.ok(names.includes(path.basename(backup)));
});

test('a WAL-bearing backup cannot pass single-file verification even if its main-file hash matches', async (t) => {
  const f = await fixture(t);
  const backup = await makeBackup(f);
  await writeFile(`${backup}-wal`, 'synthetic interrupted snapshot');
  assert.equal(run('verify-backup', ['--backup', backup]).status, 1);
});

test('release-created recovery points are accepted by the same guarded restore verifier', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.directory, 'release-point.db');
  await backupDatabase(f.source, target);
  assert.equal(run('verify-backup', ['--backup', target]).status, 0);
});

test('failed backup leaves existing recovery points intact and restore never prunes safety archives', async (t) => {
  const f = await fixture(t);
  const backup = await makeBackup(f);
  const old = `jiuyue-19000101T000000000Z-${'c'.repeat(32)}.db`;
  const safetyDirectory = path.join(f.directory, 'pre-restore-backups');
  await mkdir(safetyDirectory);
  await copyFile(backup, path.join(safetyDirectory, old));
  await copyFile(
    `${backup}.sha256.txt`,
    path.join(safetyDirectory, `${old}.sha256.txt`),
  );
  const failed = run('backup-sqlite', [
    '--database',
    path.join(f.directory, 'missing.db'),
    '--directory',
    f.backups,
  ]);
  assert.equal(failed.status, 1);
  assert.equal(run('verify-backup', ['--backup', backup]).status, 0);
  f.db.close();
  assert.equal(
    run('restore-sqlite', [
      '--backup',
      backup,
      '--database',
      f.source,
      '--app-stopped',
      '--confirm-target',
      f.source,
    ]).status,
    0,
  );
  assert.ok((await readdir(safetyDirectory)).includes(old));
});
