import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
