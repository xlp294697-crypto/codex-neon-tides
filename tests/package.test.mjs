import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
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

test('staging and production isolate state and expose only the hardened edge', async () => {
  for (const environment of ['staging', 'production']) {
    const compose = await readFile(
      path.join(root, `compose.${environment}.yaml`),
      'utf8',
    );
    assert.match(compose, new RegExp(`^name: jiuyue-${environment}$`, 'm'));
    assert.ok(compose.includes(`.env.${environment}`));
    assert.ok(compose.includes(`${environment.toUpperCase()}_DOMAIN`));
    assert.ok(compose.includes(`${environment}_data:/app/data`));
    assert.ok(compose.includes(`${environment}_caddy_data:/data`));
    assert.ok(compose.includes(`${environment}_caddy_config:/config`));
    const [app, caddy] = compose.split('  caddy:');
    for (const service of [app, caddy]) {
      assert.match(service, /read_only: true/);
      assert.deepEqual(composeList(service, 'cap_drop'), ['ALL']);
      assert.match(service, /no-new-privileges:true/);
    }
    assert.doesNotMatch(app, /ports:|build:/);
    assert.doesNotMatch(app, /cap_add:/);
    assert.match(caddy, /user: "1000:1000"/);
    assert.deepEqual(composeList(caddy, 'cap_add'), ['NET_BIND_SERVICE']);
    assert.match(app, /APP_IMAGE:\?/);
    assert.deepEqual(composeList(caddy, 'ports'), [
      '443:443/tcp',
      '443:443/udp',
      '80:80/tcp',
    ]);
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

for (const table of ['analytics_events', 'admin_sessions', 'audit_logs']) {
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
    'deploy/Caddyfile.docker',
    'deploy/Caddyfile.example',
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
  assert.ok(compose.includes('"80:80"') && compose.includes('"443:443"'));
  assert.ok(compose.includes('COOKIE_SECURE: "true"'));
  assert.ok(compose.includes('cap_drop:'));
  assert.ok(compose.includes('replace.example.com'));

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
