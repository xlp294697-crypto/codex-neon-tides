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
  'local Compose recovers synthetic imports and every SQLite table through the loopback app port and authenticated smoke',
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
        const { input, ...processOptions } = options;
        const execution = exec(executable, args, {
          timeout: 90000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          ...processOptions,
        });
        if (input !== undefined) execution.child.stdin.end(input);
        return (await execution).stdout.trim();
      } catch {
        throw new Error(`Synthetic rehearsal failed at ${stage}`);
      }
    }
    const compose = (args, options) =>
      command(
        'docker',
        ['compose', '-p', project, '-f', composeFile, ...args],
        options,
      );
    const helper = (args, options) =>
      compose(['run', '--rm', '--no-deps', '-T', 'app', ...args], options);
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
    const syntheticInput = JSON.stringify({
      version: 1,
      inquiries: [inquiry('synthetic-1'), inquiry('synthetic-2')],
      events: [
        event('synthetic-event-1'),
        event('synthetic-event-2'),
        event('synthetic-event-3'),
      ],
    });
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
            volumes: ['recovery_data:/app/data'],
            ports: ['127.0.0.1::3002'],
            read_only: true,
            tmpfs: ['/tmp:size=16m,mode=1777'],
            cap_drop: ['ALL'],
            security_opt: ['no-new-privileges:true'],
          },
        },
        volumes: { recovery_data: {} },
      }),
      { mode: 0o600 },
    );
    stage = 'deliver private fixture';
    // Pipe data through stdin and create it as the app UID inside its volume.
    // No host-owned fixture bind mount or host UID assumption is involved.
    await helper(
      [
        'node',
        '--input-type=module',
        '-e',
        "import {writeFile} from 'node:fs/promises'; let input=''; for await (const chunk of process.stdin) input+=chunk; await writeFile('/app/data/synthetic.json',input,{flag:'wx',mode:0o600});",
      ],
      { input: syntheticInput },
    );
    stage = 'fixture permissions';
    await helper([
      'node',
      '--input-type=module',
      '-e',
      "import {stat,readFile} from 'node:fs/promises'; const metadata=await stat('/app/data/synthetic.json'); if(process.getuid()!==1000 || metadata.uid!==1000 || (metadata.mode&511)!==384) throw new Error('fixture must be private to the application UID'); JSON.parse(await readFile('/app/data/synthetic.json','utf8'));",
    ]);
    await compose([
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--user',
      '1001:1001',
      'app',
      'node',
      '--input-type=module',
      '-e',
      "import {readFile} from 'node:fs/promises'; try { await readFile('/app/data/synthetic.json'); process.exitCode=1; } catch(error) { if(error.code!=='EACCES') throw error; }",
    ]);
    stage = 'import';
    const imported = JSON.parse(
      await helper([
        'node',
        'tools/import-json-data.mjs',
        '--source',
        '/app/data/synthetic.json',
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
        '/app/data/synthetic.json',
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
    const binding = await compose(['port', 'app', '3002']);
    assert.match(binding, /^127\.0\.0\.1:\d+$/);
    let origin = `http://${binding}`;
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
    stage = 'restart after recovery';
    await compose(['up', '-d', '--wait', '--wait-timeout', '60', 'app']);
    const rebound = await compose(['port', 'app', '3002']);
    assert.match(rebound, /^127\.0\.0\.1:\d+$/);
    origin = `http://${rebound}`;
    stage = 'smoke after recovery';
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
      `Synthetic Compose recovery passed; image ${imageId}; table counts 2 inquiries, 3 events, 1 session, 1 migration, 3 audits before recovery. Local loopback HTTP only; host Nginx and public TLS are not verified.`,
    );
  },
);
