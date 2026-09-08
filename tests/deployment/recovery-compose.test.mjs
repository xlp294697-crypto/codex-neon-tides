import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inquiry, event } from '../fixtures/storage.mjs';

const exec = promisify(execFile);
// Explicit opt-in: this test creates only its uniquely named local Compose
// project and synthetic volume, then removes those exact resources in cleanup.
test(
  'local Compose recovers synthetic imports and every SQLite table through Caddy and authenticated smoke',
  { skip: !process.env.RECOVERY_IMAGE, timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'jy-compose-recovery-'),
    );
    const project = `jy-recovery-${randomBytes(6).toString('hex')}`;
    const composeFile = path.join(directory, 'compose.json');
    const password = `Synthetic-${randomBytes(24).toString('base64url')}!`;
    const salt = randomBytes(18).toString('base64url');
    const passwordHash = `scrypt.${salt}.${scryptSync(password, Buffer.from(salt, 'base64url'), 64).toString('base64url')}`;
    let stage = 'setup';
    async function command(executable, args, options = {}) {
      try {
        return (
          await exec(executable, args, {
            timeout: 90000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            ...options,
          })
        ).stdout.trim();
      } catch {
        throw new Error(`Synthetic rehearsal failed at ${stage}`);
      }
    }
    const compose = (args) =>
      command('docker', ['compose', '-p', project, '-f', composeFile, ...args]);
    const helper = (args) =>
      compose(['run', '--rm', '--no-deps', '-T', 'app', ...args]);
    t.after(async () => {
      // Project is a generated literal, never a user supplied production name.
      stage = 'cleanup';
      try {
        await compose(['down', '--volumes', '--remove-orphans']);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    const imageId = await command('docker', [
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      process.env.RECOVERY_IMAGE,
    ]);
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    await writeFile(
      path.join(directory, 'synthetic.json'),
      JSON.stringify({
        version: 1,
        inquiries: [inquiry('synthetic-1'), inquiry('synthetic-2')],
        events: [
          event('synthetic-event-1'),
          event('synthetic-event-2'),
          event('synthetic-event-3'),
        ],
      }),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(directory, 'Caddyfile'),
      ':8080 {\n reverse_proxy app:3002\n}\n',
    );
    await writeFile(
      composeFile,
      JSON.stringify({
        services: {
          app: {
            image: imageId,
            pull_policy: 'never',
            environment: {
              NODE_ENV: 'production',
              HOST: '0.0.0.0',
              PORT: '3002',
              DATA_PATH: '/app/data/site.db',
              COOKIE_SECURE: 'true',
              TRUST_PROXY: 'true',
              SESSION_SECRET: randomBytes(32).toString('hex'),
              ADMIN_PASSWORD_HASH: passwordHash,
            },
            volumes: [
              'recovery_data:/app/data',
              `${path.join(directory, 'synthetic.json')}:/synthetic.json:ro`,
            ],
            read_only: true,
            tmpfs: ['/tmp:size=16m,mode=1777'],
            cap_drop: ['ALL'],
            security_opt: ['no-new-privileges:true'],
          },
          caddy: {
            image:
              'caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648',
            user: '1000:1000',
            command: [
              'caddy',
              'run',
              '--config',
              '/etc/caddy/Caddyfile',
              '--adapter',
              'caddyfile',
            ],
            ports: ['127.0.0.1::8080'],
            volumes: [
              `${path.join(directory, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`,
            ],
            read_only: true,
            tmpfs: ['/tmp:size=16m,mode=1777'],
            cap_drop: ['ALL'],
            cap_add: ['NET_BIND_SERVICE'],
            security_opt: ['no-new-privileges:true'],
          },
        },
        volumes: { recovery_data: {} },
      }),
      { mode: 0o600 },
    );
    stage = 'import';
    const imported = JSON.parse(
      await helper([
        'node',
        'tools/import-json-data.mjs',
        '--source',
        '/synthetic.json',
        '--database',
        '/app/data/site.db',
      ]),
    );
    assert.deepEqual(imported, {
      dryRun: false,
      inquiries: { source: 2, imported: 2, skipped: 0 },
      events: { source: 3, imported: 3, skipped: 0 },
    });
    const repeated = JSON.parse(
      await helper([
        'node',
        'tools/import-json-data.mjs',
        '--source',
        '/synthetic.json',
        '--database',
        '/app/data/site.db',
        '--dry-run',
      ]),
    );
    assert.equal(repeated.inquiries.skipped, 2);
    assert.equal(repeated.events.skipped, 3);
    stage = 'seed audit and session';
    await helper([
      'node',
      '--input-type=module',
      '-e',
      `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/app/data/site.db'); db.prepare('INSERT INTO admin_sessions(token_hash,csrf_token_hash,created_at,expires_at) VALUES (?,?,?,?)').run('a'.repeat(64),'b'.repeat(64),Date.now(),Date.now()+3600000); db.exec("INSERT INTO audit_logs(id,created_at,action,inquiry_id) VALUES ('synthetic-audit','2026-09-08T00:00:00Z','inquiry_deleted','synthetic-deleted')"); db.close();`,
    ]);
    const snapshotCode = `import {DatabaseSync} from 'node:sqlite'; import {createHash} from 'node:crypto'; const db=new DatabaseSync('/app/data/site.db'); console.log(JSON.stringify(['inquiries','analytics_events','admin_sessions','schema_migrations','audit_logs'].map(table=>{ const rows=db.prepare('SELECT * FROM '+table+' ORDER BY 1').all(); return {table,count:rows.length,digest:createHash('sha256').update(JSON.stringify(rows)).digest('hex')}; }))); db.close();`;
    stage = 'start';
    await compose(['up', '-d', '--wait', '--wait-timeout', '60']);
    const binding = await compose(['port', 'caddy', '8080']);
    assert.match(binding, /^127\.0\.0\.1:\d+$/);
    const origin = `http://${binding}`;
    stage = 'smoke before recovery';
    await command(
      process.execPath,
      [
        fileURLToPath(new URL('../../deploy/smoke-test.mjs', import.meta.url)),
        origin,
        'staging',
      ],
      { env: { ...process.env, SMOKE_ADMIN_PASSWORD: password } },
    );
    const before = JSON.parse(
      await compose([
        'exec',
        '-T',
        'app',
        'node',
        '--input-type=module',
        '-e',
        snapshotCode,
      ]),
    );
    assert.deepEqual(
      before.map((row) => row.count),
      [2, 3, 1, 1, 3],
    );
    stage = 'online backup';
    const backed = JSON.parse(
      await compose([
        'exec',
        '-T',
        'app',
        'node',
        'tools/backup-sqlite.mjs',
        '--database',
        '/app/data/site.db',
        '--directory',
        '/app/data/backups',
      ]),
    );
    const backup = `/app/data/backups/${backed.backup}`;
    assert.match(backed.backup, /^jiuyue-[a-zA-Z0-9-]+\.db$/);
    stage = 'stop and preserve missing database scenario';
    await compose(['stop', 'app']);
    // Faithful data-loss simulation preserves the synthetic original for recovery.
    await helper([
      'node',
      '--input-type=module',
      '-e',
      `import {rename,lstat} from 'node:fs/promises'; for(const suffix of ['-wal','-shm','-journal']) { try { await lstat('/app/data/site.db'+suffix); throw new Error('sidecar remains'); } catch(e) { if(e.code!=='ENOENT') throw e; } } await rename('/app/data/site.db','/app/data/synthetic-before-loss.db');`,
    ]);
    stage = 'restore missing database';
    await helper([
      'node',
      'tools/restore-sqlite.mjs',
      '--backup',
      backup,
      '--database',
      '/app/data/site.db',
      '--app-stopped',
      '--confirm-target',
      '/app/data/site.db',
    ]);
    const recovered = JSON.parse(
      await helper(['node', '--input-type=module', '-e', snapshotCode]),
    );
    assert.deepEqual(recovered, before);
    stage = 'restart and smoke after recovery';
    await compose(['up', '-d', '--wait', '--wait-timeout', '60', 'app']);
    await command(
      process.execPath,
      [
        fileURLToPath(new URL('../../deploy/smoke-test.mjs', import.meta.url)),
        origin,
        'staging',
      ],
      { env: { ...process.env, SMOKE_ADMIN_PASSWORD: password } },
    );
    stage = 'Linux recovery integration';
    await compose(['stop', 'app']);
    await helper([
      'node',
      'tools/restore-sqlite.mjs',
      '--backup',
      backup,
      '--database',
      '/app/data/site.db',
      '--app-stopped',
      '--confirm-target',
      '/app/data/site.db',
    ]);
    await helper([
      'node',
      '--input-type=module',
      '-e',
      `import {stat,readdir} from 'node:fs/promises'; import {verifyBackup} from './tools/verify-backup.mjs'; const s=await stat('/app/data/site.db'); if((s.mode&511)!==384 || s.uid!==1000) throw new Error('permissions'); const names=(await readdir('/app/data/pre-restore-backups')).filter(n=>n.endsWith('.db')); if(names.length!==1) throw new Error('safety backup'); await verifyBackup('/app/data/pre-restore-backups/'+names[0]);`,
    ]);
    t.diagnostic(
      `Synthetic Compose recovery passed; image ${imageId}; table counts 2 inquiries, 3 events, 1 session, 1 migration, 3 audits before recovery. Local HTTP proxy only; public TLS is not verified.`,
    );
  },
);
