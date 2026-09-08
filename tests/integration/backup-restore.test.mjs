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
  cp,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openDatabase } from '../../src/db/database.mjs';
import { migrate } from '../../src/db/migrate.mjs';
import { backupDatabase } from '../../deploy/release-db.mjs';

const root = new URL('../../', import.meta.url);
function run(tool, args, toolRoot = root) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL(`tools/${tool}.mjs`, toolRoot)), ...args],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    output: result.stdout.trim(),
    error: result.stderr,
  };
}

test('recovery commands run from a checkout path containing spaces and non-ASCII characters', async (t) => {
  const f = await fixture(t);
  const checkout = path.join(f.directory, 'recovery tools 测试');
  await cp(
    new URL('../../tools/', import.meta.url),
    path.join(checkout, 'tools'),
    { recursive: true },
  );
  await cp(
    new URL('../../src/db/', import.meta.url),
    path.join(checkout, 'src/db'),
    { recursive: true },
  );
  const result = run(
    'backup-sqlite',
    ['--database', f.source, '--directory', f.backups],
    pathToFileURL(`${checkout}${path.sep}`),
  );
  assert.equal(
    result.status,
    0,
    'backup command must resolve the actual filesystem path',
  );
  const backup = path.join(f.backups, JSON.parse(result.output).backup);
  const toolRoot = pathToFileURL(`${checkout}${path.sep}`);
  assert.equal(run('verify-backup', ['--backup', backup], toolRoot).status, 0);
  const target = path.join(f.directory, '恢复 database.db');
  assert.equal(
    run(
      'restore-sqlite',
      [
        '--backup',
        backup,
        '--database',
        target,
        '--app-stopped',
        '--confirm-target',
        target,
      ],
      toolRoot,
    ).status,
    0,
  );
});

test('backup and live checks accept forward-compatible rollback while retained backups accept an older prefix', async (t) => {
  const f = await fixture(t);
  const before = await makeBackup(f);
  const { checkDatabase } = await import('../../tools/sqlite-operations.mjs');
  const { verifyBackup } = await import('../../tools/verify-backup.mjs');
  const newer = path.join(f.directory, 'newer-image');
  await cp(
    new URL('../../tools/', import.meta.url),
    path.join(newer, 'tools'),
    { recursive: true },
  );
  await cp(
    new URL('../../src/db/', import.meta.url),
    path.join(newer, 'src/db'),
    { recursive: true },
  );
  await writeFile(
    path.join(newer, 'src/db/migrations/002-expand.sql'),
    'ALTER TABLE inquiries ADD COLUMN release_note TEXT;',
  );
  await mkdir(path.join(newer, 'deploy'));
  await copyFile(
    new URL('../../deploy/monitor-health.mjs', import.meta.url),
    path.join(newer, 'deploy/monitor-health.mjs'),
  );
  const nextMigrate = (
    await import(pathToFileURL(path.join(newer, 'src/db/migrate.mjs')).href)
  ).migrate;
  const nextCheck = (
    await import(
      pathToFileURL(path.join(newer, 'tools/sqlite-operations.mjs')).href
    )
  ).checkDatabase;
  const nextVerify = (
    await import(
      pathToFileURL(path.join(newer, 'tools/verify-backup.mjs')).href
    )
  ).verifyBackup;
  const nextMonitor = (
    await import(
      pathToFileURL(path.join(newer, 'deploy/monitor-health.mjs')).href
    )
  ).collectHealth;
  const { collectHealth } = await import('../../deploy/monitor-health.mjs');
  const server = createServer((req, res) => {
    res.setHeader(
      'content-type',
      req.url === '/' ? 'text/html' : 'application/json',
    );
    res.end(
      req.url === '/'
        ? '<html>Synthetic readiness</html>'
        : JSON.stringify({ live: true, ready: true, database: 'ready' }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const monitorConfig = {
    origin: `http://127.0.0.1:${server.address().port}`,
    database: f.source,
    backupDirectory: f.backups,
    container: 'synthetic',
    allowLocalHttp: true,
  };
  const monitorAdapters = {
    inspectContainer: async () => ({
      running: true,
      restarting: false,
      restarts: 0,
    }),
  };
  // The old recovery point is still valid after the next image is deployed.
  assert.equal((await nextVerify(before)).migrationVersion, 1);
  await assert.rejects(() => nextCheck(f.source), /MIGRATION_INCOMPATIBLE/);
  nextMigrate(f.db);
  assert.equal(
    migrate(f.db),
    2,
    'old application supports this expanded history',
  );
  assert.equal((await checkDatabase(f.source)).migrationVersion, 2);
  assert.equal((await nextCheck(f.source)).migrationVersion, 2);
  assert.deepEqual(
    await collectHealth(monitorConfig, monitorAdapters),
    { ok: true, codes: [] },
    'old monitor must remain healthy after supported application rollback',
  );
  assert.deepEqual(
    await nextMonitor(monitorConfig, monitorAdapters),
    { ok: true, codes: [] },
    'new monitor must accept the pre-deployment backup',
  );
  assert.equal(
    run('backup-sqlite', [
      '--database',
      f.source,
      '--directory',
      path.join(f.directory, 'rollback-backups'),
    ]).status,
    0,
  );
  const expandedBackup = path.join(
    f.directory,
    'rollback-backups',
    (await readdir(path.join(f.directory, 'rollback-backups'))).find((name) =>
      name.endsWith('.db'),
    ),
  );
  assert.equal((await verifyBackup(expandedBackup)).migrationVersion, 2);
  await assert.rejects(
    () => verifyBackup(expandedBackup, { schemaMode: 'restore' }),
    /MIGRATION_INCOMPATIBLE/,
  );
  assert.equal(
    (await verifyBackup(before, { schemaMode: 'restore' })).migrationVersion,
    1,
  );
  await assert.rejects(
    () => nextVerify(before, { schemaMode: 'restore' }),
    /MIGRATION_INCOMPATIBLE/,
  );
  f.db.exec('DELETE FROM schema_migrations WHERE version=1');
  await assert.rejects(() => checkDatabase(f.source), /MIGRATION_INCOMPATIBLE/);
  await assert.rejects(() => nextCheck(f.source), /MIGRATION_INCOMPATIBLE/);
  f.db
    .prepare(
      'INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (1,?,?)',
    )
    .run('0'.repeat(64), '2026-09-08T00:00:00Z');
  await assert.rejects(() => checkDatabase(f.source), /MIGRATION_INCOMPATIBLE/);
  await assert.rejects(() => nextCheck(f.source), /MIGRATION_INCOMPATIBLE/);
});
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

test('README restore command follows the real CLI confirmation contract', async (t) => {
  const f = await fixture(t);
  const backup = await makeBackup(f);
  const readme = await readFile(
    new URL('../../README.md', import.meta.url),
    'utf8',
  );
  const documented = readme
    .split(/\r?\n/)
    .find((line) => line.startsWith('node tools/restore-sqlite.mjs '));
  assert.ok(documented, 'README must contain one runnable restore command');
  const tokens = documented.split(/\s+/);
  const databaseIndex = tokens.indexOf('--database');
  const confirmationIndex = tokens.indexOf('--confirm-target');
  assert.ok(tokens.includes('--app-stopped'));
  assert.ok(databaseIndex > 1 && confirmationIndex > databaseIndex);
  assert.equal(path.isAbsolute(tokens[databaseIndex + 1]), true);
  assert.equal(tokens[confirmationIndex + 1], tokens[databaseIndex + 1]);

  const target = path.join(f.directory, 'documented-restore.db');
  const args = tokens.slice(2);
  args[args.indexOf('--backup') + 1] = backup;
  args[args.indexOf('--database') + 1] = target;
  args[args.indexOf('--confirm-target') + 1] = target;
  const result = run('restore-sqlite', args);
  assert.equal(result.status, 0, result.error);
});
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
