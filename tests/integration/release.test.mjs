import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createApp } from '../../src/app.mjs';
import { loadConfig } from '../../src/config.mjs';
import { openDatabase } from '../../src/db/database.mjs';
import { migrate } from '../../src/db/migrate.mjs';
import {
  backupDatabase,
  assertExpandMigration,
} from '../../deploy/release-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shell =
  process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : 'sh';
const previous = `ghcr.io/fixture/app@sha256:${'a'.repeat(64)}`;
const candidate = `ghcr.io/fixture/app@sha256:${'b'.repeat(64)}`;

for (const [environment, failPatch] of [
  ['staging', false],
  ['production', false],
  ['staging', true],
]) {
  test(`${environment} smoke cleans its session and synthetic inquiry${failPatch ? ' after a status check failure' : ''}`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'jy-release-http-'));
    const config = loadConfig(
      {
        DATA_PATH: path.join(directory, 'site.db'),
        ADMIN_PASSWORD: 'Synthetic!Smoke934Key',
        SESSION_SECRET:
          'synthetic-session-secret-at-least-thirty-two-characters',
        COOKIE_SECURE: 'true',
      },
      root,
    );
    const app = createApp(config);
    await app.lifecycle.initialize();
    const server = createServer((req, res) => {
      if (failPatch && req.method === 'PATCH') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'synthetic-body-must-not-reach-output' }),
        );
      } else app(req, res);
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve));
      app.lifecycle.cancelScheduledEventFlush();
      app.lifecycle.closeDatabase();
      await rm(directory, { recursive: true, force: true });
    });
    const child = spawn(
      process.execPath,
      [
        'deploy/smoke-test.mjs',
        `http://127.0.0.1:${server.address().port}`,
        environment,
      ],
      {
        cwd: root,
        env: { ...process.env, SMOKE_ADMIN_PASSWORD: config.adminPassword },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    assert.equal(
      (await once(child, 'exit'))[0],
      failPatch ? 1 : 0,
      'Smoke process must complete successfully',
    );
    assert.equal(output.includes(config.adminPassword), false);
    assert.equal(
      output.includes('synthetic-body-must-not-reach-output'),
      false,
    );
    const db = openDatabase(config.dataPath);
    try {
      for (const table of ['inquiries', 'admin_sessions', 'analytics_events'])
        assert.equal(
          db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
          0,
        );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM audit_logs WHERE action = 'inquiry_deleted'",
          )
          .get().n,
        environment === 'staging' ? 1 : 0,
      );
    } finally {
      db.close();
    }
  });
}

test('online release backup preserves committed WAL data and cannot overwrite a recovery point', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jy-release-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'site.db');
  const target = path.join(directory, 'backups', 'release.db');
  const db = openDatabase(source);
  try {
    migrate(db);
    db.exec(
      'CREATE TABLE backup_fixture (value INTEGER); INSERT INTO backup_fixture VALUES (42)',
    );
    await backupDatabase(source, target);
    const copy = openDatabase(target);
    try {
      assert.equal(
        copy.prepare('SELECT value FROM backup_fixture').get().value,
        42,
      );
    } finally {
      copy.close();
    }
    assert.match(
      await readFile(`${target}.sha256`, 'utf8'),
      /^[a-f0-9]{64}\n$/,
    );
    await assert.rejects(() => backupDatabase(source, target), /EEXIST/);
  } finally {
    db.close();
  }
});

test('release migration command rejects legacy rollback and contraction, and older code opens expanded schema', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jy-release-migrate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(path.join(root, 'src/db'), path.join(directory, 'src/db'), {
    recursive: true,
  });
  const dataPath = path.join(directory, 'site.db');
  const db = openDatabase(dataPath);
  try {
    migrate(db);
    await writeFile(
      path.join(directory, 'src/db/migrations/002-expand.sql'),
      'ALTER TABLE inquiries ADD COLUMN release_note TEXT;',
    );
    const command = (compatible) =>
      spawnSync(
        process.execPath,
        [path.join(root, 'deploy/release-db.mjs'), 'migrate'],
        {
          cwd: directory,
          env: {
            ...process.env,
            DATA_PATH: dataPath,
            ROLLBACK_SCHEMA_COMPATIBLE: compatible,
          },
          encoding: 'utf8',
        },
      );
    assert.equal(command('0').status, 1);
    assert.equal(migrate(db), 1);
    assert.equal(command('1').status, 0);
    assert.equal(migrate(db), 2);
    await writeFile(
      path.join(directory, 'src/db/migrations/003-contract.sql'),
      'DROP TABLE inquiries;',
    );
    assert.equal(command('1').status, 1);
    assert.equal(migrate(db), 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM inquiries').get().n, 0);
  } finally {
    db.close();
  }
});

test('automatic migration policy accepts limited expansions and rejects destructive or constraining SQL', () => {
  for (const sql of [
    'CREATE TABLE release_fixture (value TEXT) STRICT;',
    'CREATE INDEX sample_index ON inquiries (created_at);',
    'ALTER TABLE inquiries ADD COLUMN note TEXT;',
  ])
    assert.doesNotThrow(() => assertExpandMigration(sql));
  for (const sql of [
    'DROP TABLE inquiries;',
    'DELETE FROM inquiries;',
    'ALTER TABLE inquiries DROP COLUMN concern;',
    'ALTER TABLE inquiries ADD COLUMN note TEXT NOT NULL;',
    'CREATE UNIQUE INDEX sample ON inquiries (phone);',
    'CREATE TRIGGER sample AFTER INSERT ON inquiries BEGIN DELETE FROM inquiries; END;',
    'PRAGMA writable_schema=ON;',
    "CREATE TABLE test (value TEXT DEFAULT '--'); DROP TABLE inquiries;",
  ])
    assert.throws(() => assertExpandMigration(sql));
});

// The Docker boundary is replaced because these tests must never deploy a server.
// The real shell script must order operations and persist its own state correctly.
for (const failure of [
  '',
  'backup',
  'migrate',
  'readiness',
  'smoke',
  'rollback',
]) {
  test(`production release ${failure ? `rolls back on ${failure} failure` : 'backs up before replacement and records the digest'}`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'jy-release-shell-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bin = path.join(directory, 'bin');
    await mkdir(bin);
    if (process.platform === 'win32')
      await writeFile(path.join(bin, 'flock'), '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });
    await writeFile(
      path.join(directory, '.env.production'),
      'PRODUCTION_DOMAIN=fixture.invalid\n',
    );
    await writeFile(
      path.join(bin, 'docker'),
      `#!/bin/sh
printf '%s|%s\\n' "$APP_IMAGE" "$*" >> "$SIM_LOG"
case "$*" in
  *'ps -q app'*) printf 'fixture-container\\n';;
  'inspect --format {{.Config.Image}} fixture-container') printf '%s\\n' "$SIM_PREVIOUS";;
  *'release-db.mjs backup'*) [ "$SIM_FAILURE" != backup ];;
  *'release-db.mjs migrate'*) [ "$SIM_FAILURE" != migrate ];;
  *'up -d --wait'*) [ "$SIM_FAILURE" != rollback ] && { [ "$SIM_FAILURE" != readiness ] || [ "$APP_IMAGE" = "$SIM_PREVIOUS" ]; };;
esac
`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(bin, 'node'),
      '#!/bin/sh\n[ "$SIM_FAILURE" != smoke ]\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      shell,
      [path.join(root, 'deploy/deploy-release.sh'), 'production'],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          RELEASE_ROOT: directory,
          APP_IMAGE: candidate,
          SMOKE_BASE_URL: 'https://fixture.invalid',
          SMOKE_ADMIN_PASSWORD: 'Synthetic!Smoke934Key',
          SIM_LOG: path.join(directory, 'calls'),
          SIM_PREVIOUS: previous,
          SIM_FAILURE: failure,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(
      result.status,
      failure ? 1 : 0,
      `Release exit must reflect the requested check result: ${result.stderr}`,
    );
    const calls = await readFile(path.join(directory, 'calls'), 'utf8');
    assert.ok(
      calls.indexOf('release-db.mjs backup') < calls.indexOf('stop app') ||
        failure === 'backup',
    );
    assert.equal(
      await readFile(
        path.join(directory, '.release-state/production/previous-image'),
        'utf8',
      ),
      `${previous}\n`,
    );
    if (failure && failure !== 'backup') {
      assert.ok(
        calls
          .split('\n')
          .some(
            (line) =>
              line.startsWith(`${previous}|compose`) &&
              line.includes('up -d --wait'),
          ),
      );
      if (failure !== 'rollback')
        assert.equal(
          await readFile(
            path.join(directory, '.release-state/production/current-image'),
            'utf8',
          ),
          `${previous}\n`,
        );
      assert.match(result.stderr, /database was not reverted/i);
      if (failure === 'rollback')
        assert.match(
          result.stderr,
          /rollback failed; operator recovery required/i,
        );
    }
    if (failure === 'backup') assert.equal(calls.includes('stop app'), false);
    if (!failure)
      assert.equal(
        await readFile(
          path.join(directory, '.release-state/production/current-image'),
          'utf8',
        ),
        `${candidate}\n`,
      );
  });
}
