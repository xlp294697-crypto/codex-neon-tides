import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { httpFixture } from './fixtures/http-app.mjs';
import { openDatabase } from '../src/db/database.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function composeList(service, key) {
  const blocks = [
    ...service.matchAll(
      new RegExp(`^    ${key}:\\r?\\n((?:      - .+\\r?\\n)+)`, 'gm'),
    ),
  ];
  assert.equal(blocks.length, 1, `Expected one explicit ${key} list`);
  return blocks[0][1]
    .trim()
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .slice(2)
        .replace(/^["']|["']$/g, ''),
    )
    .sort();
}

test('runtime image installs locked production packages and excludes delivery tooling', async () => {
  const dockerfile = await readFile(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /FROM node:24-alpine[\d.]*@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /COPY[^\n]*package-lock.json/);
  assert.match(dockerfile, /COPY[^\n]*src \.\/src/);
  assert.match(dockerfile, /COPY[^\n]*public \.\/public/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /HEALTHCHECK[^]*deploy\/healthcheck.mjs/);
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s/);
  const ignored = await readFile(path.join(root, '.dockerignore'), 'utf8');
  assert.match(ignored, /^\*\*$/m);
  assert.match(ignored, /^!src\/\*\*$/m);
});

test('generated SQLite snapshots are ignored at any depth and tracked artifacts are guarded', async () => {
  const candidates = [
    'nested/recovery/site.db',
    'data/site.db-wal',
    'runtime/release-backups/release.db',
    'runtime/pre-restore-backups/safety.db-shm',
    'nested/snapshots/site.sqlite-wal',
  ];
  const ignored = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: root,
    input: candidates.join('\n'),
    encoding: 'utf8',
  });
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.deepEqual(
    ignored.stdout.trim().split(/\r?\n/).sort(),
    candidates.sort(),
  );
  const guard = spawnSync(
    process.execPath,
    ['tools/check-tracked-artifacts.mjs'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.equal(guard.status, 0, guard.stderr);
});

test('clean-checkout launcher loads .env and the development command enables watch mode', async (t) => {
  const packageJson = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  );
  assert.equal(
    packageJson.scripts.start,
    'node --env-file-if-exists=.env server.mjs',
  );
  assert.equal(
    packageJson.scripts.dev,
    'node --watch --env-file-if-exists=.env server.mjs',
  );
  const versionCheck = spawnSync(
    process.execPath,
    ['tools/require-node-24.mjs'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.equal(versionCheck.status, 0, versionCheck.stderr);

  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const environmentPath = path.join(root, '.env');
  try {
    await writeFile(
      environmentPath,
      [
        'NODE_ENV=test',
        'HOST=127.0.0.1',
        `PORT=${port}`,
        'DATA_PATH=./data/dev-launch-test.db',
        `${'ADMIN'}_PASSWORD=Synthetic!Launcher934Key`,
        'SESSION_SECRET=synthetic-launcher-secret-at-least-thirty-two-characters',
        'COOKIE_SECURE=false',
      ].join('\n'),
      { flag: 'wx' },
    );
  } catch (error) {
    if (error.code === 'EEXIST') {
      t.skip('Existing local .env is never overwritten by the launcher test');
      return;
    }
    throw error;
  }
  const childEnvironment = { ...process.env };
  for (const key of [
    'NODE_ENV',
    'HOST',
    'PORT',
    'DATA_PATH',
    'ADMIN_PASSWORD',
    'ADMIN_PASSWORD_HASH',
    'SESSION_SECRET',
    'COOKIE_SECURE',
  ])
    delete childEnvironment[key];
  const child = spawn(
    process.execPath,
    ['--env-file-if-exists=.env', 'server.mjs'],
    { cwd: root, env: childEnvironment, stdio: 'ignore' },
  );
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    await unlink(environmentPath).catch(() => undefined);
    for (const suffix of ['', '-wal', '-shm'])
      await unlink(
        path.join(root, 'data', `dev-launch-test.db${suffix}`),
      ).catch(() => undefined);
  });
  const deadline = Date.now() + 8000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
      if (ready) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    ready,
    true,
    '.env values must start a ready development server',
  );
});

test('staging and production expose only the hardened app on host loopback', async () => {
  for (const environment of ['staging', 'production']) {
    const compose = await readFile(
      path.join(root, `compose.${environment}.yaml`),
      'utf8',
    );
    assert.match(compose, new RegExp(`^name: jiuyue-${environment}$`, 'm'));
    assert.ok(compose.includes(`.env.${environment}`));
    assert.ok(compose.includes(`${environment}_data:/app/data`));
    assert.doesNotMatch(compose, /^ {2}caddy:|caddy:2|_caddy_/m);
    assert.match(compose, /read_only: true/);
    assert.deepEqual(composeList(compose, 'cap_drop'), ['ALL']);
    assert.match(compose, /no-new-privileges:true/);
    assert.match(
      compose,
      new RegExp(
        `127\\.0\\.0\\.1:\\$\\{${environment.toUpperCase()}_APP_PORT:-3002\\}:3002`,
      ),
    );
    assert.doesNotMatch(compose, /(?:^|\s)(?:80|443):(?:80|443)/m);
    assert.doesNotMatch(compose, /build:/);
    assert.doesNotMatch(compose, /cap_add:/);
    assert.match(compose, /APP_IMAGE:\?/);
  }
});

test('host Nginx terminates TLS and keeps ACME renewal and the app upstream local', async () => {
  const bootstrap = await readFile(
    path.join(root, 'deploy', 'nginx-bootstrap.conf.example'),
    'utf8',
  );
  const site = await readFile(
    path.join(root, 'deploy', 'nginx-site.conf.example'),
    'utf8',
  );
  for (const config of [bootstrap, site]) {
    assert.match(config, /server_name sports\.example\.com;/);
    assert.match(config, /location (?:\^~ )?\/\.well-known\/acme-challenge\//);
    assert.match(config, /root \/var\/www\/certbot;/);
  }
  assert.doesNotMatch(bootstrap, /ssl_certificate|proxy_pass/);
  assert.match(site, /listen 443 ssl http2;/);
  assert.match(site, /listen 443 ssl default_server;/);
  assert.match(site, /ssl_reject_handshake on;/);
  assert.match(site, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
  assert.match(site, /proxy_pass http:\/\/127\.0\.0\.1:3002;/);
  assert.match(site, /proxy_set_header Host \$host;/);
  assert.match(site, /proxy_set_header X-Forwarded-Proto \$scheme;/);
  assert.match(site, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.doesNotMatch(site, /proxy_pass http:\/\/(?!127\.0\.0\.1)/);
  assert.match(site, /return 301 https:\/\/sports\.example\.com\$request_uri;/);
  for (const config of [bootstrap, site]) {
    assert.match(config, /listen 80 default_server;/);
    assert.match(config, /server_name _;/);
    assert.match(config, /return 444;/);
  }
});

test('delivery checksums match Git-normalized file content', async () => {
  const manifest = await readFile(path.join(root, 'SHA256SUMS.txt'), 'utf8');
  const seen = new Set();
  for (const line of manifest.trim().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
    assert.ok(match, `Invalid checksum entry: ${line}`);
    const [, expected, manifestPath] = match;
    const gitPath = manifestPath.replaceAll('\\', '/');
    assert.equal(seen.has(gitPath), false, `Duplicate checksum: ${gitPath}`);
    seen.add(gitPath);
    const object = spawnSync(
      'git',
      ['hash-object', `--path=${gitPath}`, gitPath],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(object.status, 0, object.stderr);
    const blob = spawnSync('git', ['cat-file', 'blob', object.stdout.trim()], {
      cwd: root,
    });
    assert.equal(blob.status, 0, blob.stderr.toString());
    assert.equal(
      createHash('sha256').update(blob.stdout).digest('hex'),
      expected,
      `Stale checksum: ${gitPath}`,
    );
  }
});

function healthcheck(port, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['deploy/healthcheck.mjs', mode], {
      cwd: root,
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('exit', resolve);
  });
}

test('readiness recovers from a business write failure without background cleanup or persisting the failed request', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const fixture = await httpFixture(t);
  const db = openDatabase(fixture.config.dataPath);
  fixture.onCleanup(() => db.close());
  db.exec(
    "CREATE TRIGGER reject_inquiry BEFORE INSERT ON inquiries BEGIN SELECT RAISE(ABORT, 'synthetic transient business fault'); END",
  );
  const failed = await fixture.request('/api/inquiries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      parentName: 'Synthetic parent',
      phone: '+1-202-555-0100',
      grade: 'test',
      course: 'test',
      privacyConsent: true,
    }),
  });
  assert.equal(failed.response.status, 500);
  await fixture.login();
  assert.equal((await fixture.request('/api/health')).response.status, 503);
  t.mock.timers.tick(5000);
  assert.equal(
    (await fixture.request('/api/health')).response.status,
    503,
    'A live business fault must remain unready',
  );
  db.exec('DROP TRIGGER reject_inquiry');
  const history = db.prepare('SELECT * FROM schema_migrations').all();
  db.exec(
    "CREATE TRIGGER recovery_side_effect AFTER INSERT ON inquiries BEGIN UPDATE schema_migrations SET applied_at = '2099-01-01T00:00:00.000Z'; END",
  );
  assert.equal(
    (await fixture.request('/api/health')).response.status,
    503,
    'Recovery attempts must be rate bounded',
  );
  t.mock.timers.tick(5000);
  const recovered = await fixture.request('/api/health');
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.body.ready, true);
  assert.deepEqual(
    db.prepare('SELECT * FROM schema_migrations').all(),
    history,
  );
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM admin_sessions').get().count,
    1,
  );
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM inquiries').get().count,
    0,
    'Readiness must not commit the failed user request',
  );
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM audit_logs').get().count,
    0,
  );
});

for (const table of ['admin_sessions', 'audit_logs']) {
  test(`recovery stays unready while ${table} rejects writes`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const fixture = await httpFixture(t);
    const db = openDatabase(fixture.config.dataPath);
    fixture.onCleanup(() => db.close());
    db.exec(
      "CREATE TRIGGER reject_session BEFORE INSERT ON admin_sessions BEGIN SELECT RAISE(ABORT, 'synthetic fault'); END",
    );
    const login = await fixture.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: fixture.config.adminPassword }),
    });
    assert.equal(login.response.status, 500);
    db.exec('DROP TRIGGER reject_session');
    db.exec(
      `CREATE TRIGGER reject_recovery BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic table fault'); END`,
    );
    assert.equal((await fixture.request('/api/health')).response.status, 503);
    db.exec('DROP TRIGGER reject_recovery');
    t.mock.timers.tick(5000);
    assert.equal((await fixture.request('/api/health')).response.status, 200);
    for (const businessTable of [
      'inquiries',
      'analytics_events',
      'admin_sessions',
      'audit_logs',
    ]) {
      assert.equal(
        db.prepare(`SELECT count(*) AS count FROM ${businessTable}`).get()
          .count,
        0,
      );
    }
  });
}

test('health probes distinguish a live process from database write readiness', async (t) => {
  const fixture = await httpFixture(t);
  const db = openDatabase(fixture.config.dataPath);
  fixture.onCleanup(() => db.close());
  const history = db.prepare('SELECT * FROM schema_migrations').all();
  db.exec(
    "CREATE TRIGGER health_rollback_marker AFTER UPDATE ON schema_migrations BEGIN UPDATE schema_migrations SET applied_at = '2099-01-01T00:00:00.000Z' WHERE version = OLD.version; END",
  );
  const healthy = await fixture.request('/api/health');
  const port = new URL(healthy.response.url).port;
  assert.equal(healthy.response.status, 200);
  assert.equal(healthy.body.live, true);
  assert.equal(healthy.body.ready, true);
  assert.equal(healthy.body.database, 'ready');
  assert.equal(await healthcheck(port, 'readiness'), 0);
  assert.deepEqual(
    db.prepare('SELECT * FROM schema_migrations').all(),
    history,
  );
  db.exec('DROP TRIGGER health_rollback_marker');
  db.exec(
    "CREATE TRIGGER reject_health_write BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END",
  );
  assert.equal((await fixture.request('/api/health')).response.status, 503);
  assert.equal(await healthcheck(port, 'readiness'), 1);
  const alive = await fixture.request('/api/health/live');
  assert.equal(alive.response.status, 200);
  assert.equal(alive.body.live, true);
  assert.equal(await healthcheck(port, 'liveness'), 0);
  db.exec('DROP TRIGGER reject_health_write');
  assert.equal(await healthcheck(port, 'readiness'), 0);
  fixture.app.lifecycle.closeDatabase();
  assert.equal(await healthcheck(port, 'readiness'), 1);
  assert.equal(await healthcheck(port, 'liveness'), 0);
  assert.equal(await healthcheck(port, 'unknown'), 1);
});

async function inventory(directory, relative = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // Local dependencies and generated diagnostics are not delivery sources.
    if (
      entry.isDirectory() &&
      [
        'node_modules',
        '.git',
        '.superpowers',
        '.worktrees',
        '.cache',
        '.codex-log',
        'test-results',
        'playwright-report',
        'coverage',
      ].includes(entry.name)
    )
      continue;
    const relativePath = path.join(relative, entry.name);
    const absolutePath = path.join(directory, entry.name);
    const information = await lstat(absolutePath);
    assert.equal(
      information.isSymbolicLink(),
      false,
      `交付包不得包含符号链接：${relativePath}`,
    );
    if (entry.isDirectory())
      result.push(...(await inventory(absolutePath, relativePath)));
    else result.push(relativePath);
  }
  return result;
}

test('交付包不含凭据、原始资料、日志或本机路径', async () => {
  const files = await inventory(root);
  assert.equal(
    files.some((file) => path.basename(file) === '.env'),
    false,
    '不得交付真实 .env',
  );
  for (const extension of [
    '.docx',
    '.doc',
    '.pdf',
    '.ndjson',
    '.log',
    '.zip',
    '.db',
    '.db-wal',
    '.db-shm',
    '.sqlite',
    '.sqlite-wal',
    '.sqlite-shm',
    '.sqlite3',
    '.sqlite3-wal',
    '.sqlite3-shm',
  ]) {
    assert.equal(
      files.some((file) => file.toLowerCase().endsWith(extension)),
      false,
      `不得包含 ${extension} 文件`,
    );
  }

  const textExtensions = new Set([
    '.md',
    '.txt',
    '.mjs',
    '.js',
    '.html',
    '.css',
    '.json',
    '.yaml',
    '.yml',
    '.ps1',
    '.sh',
    '.cmd',
    '.example',
    '.dockerignore',
    '.gitignore',
  ]);
  const localPathPatterns = [
    /[A-Za-z]:\\Users\\[^\\\r\n]+\\/i,
    /\/(?:home|Users)\/[^/\r\n]+\//,
    /Documents[\\/]Codex/i,
  ];
  const plainAdminPasswordPattern = new RegExp(
    `ADMIN_${'PASSWORD'}=(?!HASH|\\s*$).+`,
    'im',
  );
  for (const file of files) {
    if (
      !textExtensions.has(path.extname(file).toLowerCase()) &&
      !['.dockerignore', '.gitignore'].includes(path.basename(file))
    )
      continue;
    const text = await readFile(path.join(root, file), 'utf8');
    assert.equal(
      localPathPatterns.some((pattern) => pattern.test(text)),
      false,
      `发现制作电脑绝对路径：${file}`,
    );
    assert.equal(
      plainAdminPasswordPattern.test(text),
      false,
      `发现明文后台密码：${file}`,
    );
  }
});

test('部署入口和安全示例齐全', async () => {
  const required = [
    'README.md',
    '开始部署.txt',
    'DEPLOYMENT-CHECKLIST.md',
    'SECURITY.md',
    '.env.example',
    'Dockerfile',
    'compose.yaml',
    'compose.app-only.yaml',
    'Start-Windows.ps1',
    'start-linux.sh',
    '启动网站.cmd',
    'deploy/nginx-bootstrap.conf.example',
    'deploy/nginx-site.conf.example',
    'deploy/jiuyue-sports.service.example',
    'deploy/jiuyue-backup.service.example',
    'deploy/jiuyue-backup.timer.example',
    'tools/Initialize-Config.ps1',
    'tools/initialize-config.sh',
    'tools/Backup-Data.ps1',
    'tools/backup-data.sh',
    'tools/Backup-Docker-Data.ps1',
    'tools/backup-docker-data.sh',
    'tools/Restore-Data.ps1',
    'tools/restore-data.sh',
    'tools/Restore-Docker-Data.ps1',
    'tools/restore-docker-data.sh',
    'tools/Install-Windows-Autostart.ps1',
    'tools/Uninstall-Windows-Autostart.ps1',
  ].map((item) => item.replaceAll('/', path.sep));
  const files = await inventory(root);
  for (const requiredFile of required)
    assert.ok(files.includes(requiredFile), `缺少部署文件：${requiredFile}`);

  const compose = await readFile(path.join(root, 'compose.yaml'), 'utf8');
  assert.ok(compose.includes('restart: unless-stopped'));
  assert.ok(compose.includes('${APP_BIND_IP:-127.0.0.1}:${PORT:-3002}:3002'));
  assert.ok(compose.includes('COOKIE_SECURE: "true"'));
  assert.ok(compose.includes('cap_drop:'));
  assert.doesNotMatch(compose, /caddy|"80:80"|"443:443"/i);

  const environmentExample = await readFile(
    path.join(root, '.env.example'),
    'utf8',
  );
  assert.ok(
    environmentExample.includes('ADMIN_PASSWORD_HASH=请使用初始化工具生成'),
  );
  assert.ok(environmentExample.includes('COOKIE_SECURE=true'));
  assert.ok(environmentExample.includes('EVENT_RETENTION_DAYS=180'));
  assert.ok(environmentExample.includes('BACKUP_RETENTION_DAYS=90'));
  assert.ok(environmentExample.includes('REPORT_TIME_ZONE=Asia/Shanghai'));

  const appOnlyCompose = await readFile(
    path.join(root, 'compose.app-only.yaml'),
    'utf8',
  );
  assert.ok(
    appOnlyCompose.includes('${APP_BIND_IP:-127.0.0.1}:${PORT:-3002}:3002'),
  );

  const windowsAutostart = await readFile(
    path.join(root, 'tools', 'Install-Windows-Autostart.ps1'),
    'utf8',
  );
  assert.ok(windowsAutostart.includes('-LogonType S4U -RunLevel Limited'));
  assert.ok(windowsAutostart.includes('Resolve-NodeExecutable'));
  assert.equal(windowsAutostart.includes("-UserId 'SYSTEM'"), false);

  for (const restoreScript of [
    'Restore-Docker-Data.ps1',
    'restore-docker-data.sh',
  ]) {
    const restoreText = await readFile(
      path.join(root, 'tools', restoreScript),
      'utf8',
    );
    for (const capability of ['CHOWN', 'FOWNER', 'DAC_OVERRIDE']) {
      assert.ok(
        restoreText.includes(capability),
        `${restoreScript} 缺少 Docker 恢复所需最小 capability：${capability}`,
      );
    }
    assert.ok(
      /skip-?hash-?check/i.test(restoreText),
      `${restoreScript} 必须显式标识跳过哈希校验的高风险选项`,
    );
  }

  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert.ok(
    readme.includes('Docker Desktop') && readme.includes('Windows Server'),
  );
  assert.ok(readme.includes('S4U') && readme.includes('Limited'));
  assert.ok(readme.includes('90 天'));
});
