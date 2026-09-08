import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { openDatabase } from '../../src/db/database.mjs';
import { migrate } from '../../src/db/migrate.mjs';
import { backupSqlite } from '../../tools/backup-sqlite.mjs';

test('monitor thresholds yield actionable stable codes without raw diagnostic values', async () => {
  const { evaluateHealth } = await import('../../deploy/monitor-health.mjs');
  const healthy = {
    homepage: true,
    readiness: true,
    diskFreeBytes: 5e9,
    containerRunning: true,
    containerRestarts: 0,
    certificateDays: 90,
    backupAgeHours: 1,
    sqlite: true,
  };
  assert.deepEqual(evaluateHealth(healthy), { ok: true, codes: [] });
  for (const [key, value, code] of [
    ['homepage', false, 'HOMEPAGE_FAILED'],
    ['readiness', false, 'READINESS_FAILED'],
    ['diskFreeBytes', 0, 'DISK_LOW'],
    ['containerRunning', false, 'CONTAINER_DOWN'],
    ['containerRestarts', 3, 'CONTAINER_RESTARTS'],
    ['certificateDays', 14, 'CERTIFICATE_EXPIRING'],
    ['backupAgeHours', 37, 'BACKUP_STALE'],
    ['sqlite', false, 'SQLITE_FAILED'],
  ]) {
    assert.deepEqual(evaluateHealth({ ...healthy, [key]: value }), {
      ok: false,
      codes: [code],
    });
  }
  for (const key of [
    'diskFreeBytes',
    'containerRestarts',
    'certificateDays',
    'backupAgeHours',
  ])
    assert.equal(evaluateHealth({ ...healthy, [key]: NaN }).ok, false);
});
test('real HTTP and SQLite probes expose outages and missing backups without leaking responses or paths', async (t) => {
  const { collectHealth } = await import('../../deploy/monitor-health.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'jy-monitor-'));
  const database = path.join(directory, 'site.db');
  const backups = path.join(directory, 'backups');
  const db = openDatabase(database);
  migrate(db);
  let ready = true;
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<html>Synthetic homepage</html>');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          ready
            ? { live: true, ready: true, database: 'ready' }
            : { secret: 'DO_NOT_LOG_SYNTHETIC' },
        ),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  await backupSqlite(database, backups);
  const config = {
    origin: `http://127.0.0.1:${server.address().port}`,
    database,
    backupDirectory: backups,
    container: 'synthetic-container',
    allowLocalHttp: true,
  };
  const result = await collectHealth(config, {
    inspectContainer: async () => ({
      running: true,
      restarting: false,
      restarts: 0,
    }),
  });
  assert.deepEqual(result, { ok: true, codes: [] });
  // Pause immediately after the filesystem publishes the final database name.
  // All HTTP/SQLite/backup checks remain real at this exact publication boundary.
  const originalRename = fs.rename;
  let observedPublication = false;
  let published;
  t.mock.method(fs, 'rename', async (source, target) => {
    await originalRename(source, target);
    if (target.endsWith('.db')) {
      observedPublication = true;
      published = target;
      assert.equal(
        (await readdir(backups))
          .filter((name) => name.endsWith('.db'))
          .sort()
          .at(-1),
        path.basename(target),
        'the boundary probe must select the newly published backup',
      );
      assert.deepEqual(
        await collectHealth(config, {
          inspectContainer: async () => ({
            running: true,
            restarting: false,
            restarts: 0,
          }),
        }),
        { ok: true, codes: [] },
      );
    }
  });
  syncBuiltinESMExports();
  try {
    await backupSqlite(database, backups);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(observedPublication, true);
  await writeFile(`${published}.sha256.txt`, 'incomplete synthetic checksum');
  const damaged = await collectHealth(config, {
    inspectContainer: async () => ({
      running: true,
      restarting: false,
      restarts: 0,
    }),
  });
  assert.ok(
    damaged.codes.includes('BACKUP_UNVERIFIED'),
    'a damaged published backup must still alert instead of falling back',
  );
  ready = false;
  await writeFile(path.join(backups, 'ignored.txt'), 'DO_NOT_LOG_SYNTHETIC');
  const failed = await collectHealth(
    { ...config, backupDirectory: path.join(directory, 'missing') },
    {
      inspectContainer: async () => {
        throw new Error('DO_NOT_LOG_SYNTHETIC');
      },
    },
  );
  assert.ok(failed.codes.includes('READINESS_FAILED'));
  assert.ok(failed.codes.includes('BACKUP_UNVERIFIED'));
  assert.ok(failed.codes.includes('CONTAINER_CHECK_FAILED'));
  assert.doesNotMatch(
    JSON.stringify(failed),
    /DO_NOT_LOG_SYNTHETIC|jy-monitor/,
  );
});
test('monitor CLI reports invalid configuration with nonzero exit and sanitized JSON', async () => {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../../deploy/monitor-health.mjs', import.meta.url)),
    '--origin',
    'https://secret:DO_NOT_LOG@example.com/',
  ]);
  let output = '';
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(output), {
    ok: false,
    codes: ['MONITOR_CONFIGURATION'],
  });
});
