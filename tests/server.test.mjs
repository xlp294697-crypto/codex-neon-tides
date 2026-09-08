import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const adminPassword = 'Cobalt!River7Quartz#2026';
const sessionSecret = 'test-session-secret-that-is-longer-than-thirty-two-characters-2026';
const analyticsNoticeVersion = '2026-08-22';
const shanghaiDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
let temporaryDirectory;
let dataPath;
let port;
let child;
let childOutput = '';
let boundaryTimestamp;
let boundaryDate;

function shanghaiDateKey(value) {
  const parts = Object.fromEntries(
    shanghaiDateFormatter.formatToParts(new Date(value))
      .filter((part) => ['year', 'month', 'day'].includes(part.type))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const selected = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

async function startServer(environmentOverrides = {}, entrypoint = 'server.mjs') {
  childOutput = '';
  child = spawn(process.execPath, [entrypoint], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_PATH: dataPath,
      ADMIN_PASSWORD: adminPassword,
      ADMIN_PASSWORD_HASH: '',
      SESSION_SECRET: sessionSecret,
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'false',
      ENABLE_HSTS: 'false',
      EVENT_RETENTION_DAYS: '',
      REPORT_TIME_ZONE: '',
      MAX_BODY_BYTES: '65536',
      ICP_NUMBER: '苏ICP备测试号',
      ...environmentOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { childOutput += chunk.toString(); });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务器提前退出：\n${childOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`服务器启动超时：\n${childOutput}`);
}

async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  let timeout;
  await Promise.race([
    exited,
    new Promise((resolve) => { timeout = setTimeout(resolve, 6000); timeout.unref(); }),
  ]);
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function jsonRequest(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body };
}

async function login(password = adminPassword) {
  const result = await jsonRequest('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const setCookie = result.response.headers.get('set-cookie');
  return {
    csrfToken: result.body.csrfToken,
    cookie: setCookie.split(';')[0],
    setCookie,
  };
}

test.before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'jiuyue-production-test-'));
  dataPath = path.join(temporaryDirectory, 'site-data.json');
  port = await availablePort();

  const now = new Date();
  boundaryTimestamp = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2, 16, 30, 0,
  )).toISOString();
  boundaryDate = shanghaiDateKey(boundaryTimestamp);
  assert.notEqual(boundaryDate, boundaryTimestamp.slice(0, 10), '测试种子必须跨过上海时区午夜');
  const expiredTimestamp = new Date(Date.now() - 181 * 86400000).toISOString();
  const seededData = {
    version: 1,
    events: [
      { id: 'expired-event', createdAt: expiredTimestamp, eventType: 'page_view', page: '/', visitorId: 'visitor-expired' },
      { id: 'boundary-event', createdAt: boundaryTimestamp, eventType: 'page_view', page: '/', visitorId: 'visitor-boundary' },
    ],
    inquiries: [],
  };
  await writeFile(dataPath, `${JSON.stringify(seededData, null, 2)}\n`, 'utf8');
  await startServer();
});

test.after(async () => {
  await stopServer();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test('完整生产接口、安全控制、隐私口径、时区、留存与会话流程', async () => {
  const analyticsConsentAt = new Date().toISOString();
  const analyticsConsent = { analyticsConsent: true, analyticsNoticeVersion, analyticsConsentAt };

  let result = await jsonRequest('/api/health');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(result.response.headers.get('x-frame-options'), 'DENY');
  assert.ok(result.response.headers.get('content-security-policy').includes("default-src 'self'"));

  const cleanedAtStartup = JSON.parse(await readFile(dataPath, 'utf8'));
  assert.equal(cleanedAtStartup.events.some((event) => event.id === 'expired-event'), false, '默认 180 天留存应在启动时清理过期事件');
  assert.equal(cleanedAtStartup.events.some((event) => event.id === 'boundary-event'), true);

  const home = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(home.status, 200);
  const homeText = await home.text();
  assert.ok(homeText.includes('氿悦体育'));
  assert.ok(homeText.includes('苏ICP备测试号'));
  assert.ok(homeText.includes('https://beian.miit.gov.cn/'));
  const privacy = await fetch(`http://127.0.0.1:${port}/privacy`);
  assert.equal(privacy.status, 200);
  assert.ok((await privacy.text()).includes('预约信息处理告知'));
  const robots = await fetch(`http://127.0.0.1:${port}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.ok((await robots.text()).includes('Disallow: /admin'));
  const media = await fetch(`http://127.0.0.1:${port}/assets/media/business-license.jpg`);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'image/jpeg');
  assert.ok((await media.arrayBuffer()).byteLength > 1000);
  assert.equal((await fetch(`http://127.0.0.1:${port}/server.mjs`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/assets/media/%2e%2e%2findex.html`)).status, 404);

  result = await jsonRequest('/api/events', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(result.response.status, 415);
  result = await jsonRequest('/api/events', {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}',
  });
  assert.equal(result.response.status, 403);
  result = await jsonRequest('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
  assert.equal(result.response.status, 400);
  result = await jsonRequest('/api/events', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventType: 'page_view', page: '/', visitorId: 'visitor-no-consent' }),
  });
  assert.equal(result.response.status, 422);

  result = await jsonRequest('/api/events', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventType: 'page_view', page: '/', visitorId: 'visitor-test-1',
      referrer: 'https://ref.example/path?private=value', utm: { source: 'test-campaign' }, device: 'desktop',
      ...analyticsConsent,
    }),
  });
  assert.equal(result.response.status, 202);
  result = await jsonRequest('/api/events', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventType: 'booking_success', page: '/', visitorId: 'visitor-test-1', section: 'assessment', ...analyticsConsent }),
  });
  assert.equal(result.response.status, 202);

  const rejectedAnalyticsInquiry = {
    parentName: '测试家长', phone: '18061736378', grade: '小学', course: '啦啦操专项',
    concern: '测试预约，不含敏感信息', preferredTime: '周末', privacyConsent: true,
    sourcePage: '/should-not-store', sourceSection: 'assessment', visitorId: 'visitor-should-not-store',
    referrer: 'https://ref.example/private?token=secret', utm: { source: 'should-not-store' }, analyticsConsent: false,
  };
  result = await jsonRequest('/api/inquiries', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...rejectedAnalyticsInquiry, privacyConsent: false }),
  });
  assert.equal(result.response.status, 422);
  result = await jsonRequest('/api/inquiries', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rejectedAnalyticsInquiry),
  });
  assert.equal(result.response.status, 201);
  const inquiryId = result.body.id;
  result = await jsonRequest('/api/inquiries', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rejectedAnalyticsInquiry),
  });
  assert.equal(result.response.status, 429);

  result = await jsonRequest('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password-value' }),
  });
  assert.equal(result.response.status, 401);
  const firstSession = await login();
  assert.ok(firstSession.setCookie.includes('HttpOnly'));
  assert.ok(firstSession.setCookie.includes('SameSite=Strict'));

  result = await jsonRequest('/api/dashboard', { headers: { cookie: firstSession.cookie } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.reportTimeZone, 'Asia/Shanghai');
  assert.equal(result.body.metrics.visits, 2);
  assert.equal(result.body.metrics.visitors, 2);
  assert.equal(result.body.metrics.enquiries, 1);
  assert.equal(result.body.metrics.attributedEnquiries, 0);
  assert.equal(result.body.metrics.trackedConversions, 1);
  assert.equal(result.body.metrics.conversion, 50, '转化率必须使用同一统计事件窗口的唯一访客口径');
  const boundaryDay = result.body.daily.find((day) => day.date === boundaryDate);
  assert.ok(boundaryDay, `最近七天中缺少上海日期 ${boundaryDate}`);
  assert.equal(boundaryDay.visits, 1, 'UTC 16:30 应计入次日的上海日期');
  assert.equal(result.body.daily.reduce((sum, day) => sum + day.enquiries, 0), 1);
  assert.equal(result.body.daily.reduce((sum, day) => sum + day.trackedConversions, 0), 1);

  result = await jsonRequest('/api/inquiries', { headers: { cookie: firstSession.cookie } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.inquiries[0].id, inquiryId);
  assert.equal(result.body.inquiries[0].analyticsAttributed, false);
  assert.equal(result.body.inquiries[0].source, '');
  assert.equal(result.body.inquiries[0].sourcePage, '');
  assert.equal(result.body.inquiries[0].referrer, '');
  assert.equal('visitorId' in result.body.inquiries[0], false, '实名询盘不得保存随机访客标识');
  assert.equal('ip' in result.body.inquiries[0], false);
  assert.equal(result.body.inquiries[0].privacyNoticeVersion, analyticsNoticeVersion);

  result = await jsonRequest(`/api/inquiries/${inquiryId}`, {
    method: 'PATCH', headers: { cookie: firstSession.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'Contacted' }),
  });
  assert.equal(result.response.status, 403);
  result = await jsonRequest(`/api/inquiries/${inquiryId}`, {
    method: 'PATCH',
    headers: { cookie: firstSession.cookie, 'content-type': 'application/json', 'x-csrf-token': firstSession.csrfToken },
    body: JSON.stringify({ status: 'Contacted' }),
  });
  assert.equal(result.response.status, 200);

  const storedBeforeRestart = JSON.parse(await readFile(dataPath, 'utf8'));
  assert.equal(storedBeforeRestart.inquiries[0].status, 'Contacted');
  const storedPageView = storedBeforeRestart.events.find((event) => event.visitorId === 'visitor-test-1' && event.eventType === 'page_view');
  assert.equal(storedPageView.referrer, 'https://ref.example');
  assert.equal(storedPageView.analyticsNoticeVersion, analyticsNoticeVersion);
  assert.equal('ip' in storedPageView, false);

  await stopServer();
  await startServer();
  result = await jsonRequest('/api/inquiries', { headers: { cookie: firstSession.cookie } });
  assert.equal(result.response.status, 401, '进程重启后旧内存会话必须失效');
  const secondSession = await login();
  result = await jsonRequest('/api/inquiries', { headers: { cookie: secondSession.cookie } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.inquiries[0].status, 'Contacted');

  result = await jsonRequest(`/api/inquiries/${inquiryId}`, { method: 'DELETE', headers: { cookie: secondSession.cookie } });
  assert.equal(result.response.status, 403);
  result = await jsonRequest(`/api/inquiries/${inquiryId}`, {
    method: 'DELETE', headers: { cookie: secondSession.cookie, 'x-csrf-token': secondSession.csrfToken },
  });
  assert.equal(result.response.status, 200);

  result = await jsonRequest('/api/logout', {
    method: 'POST', headers: { cookie: secondSession.cookie, 'x-csrf-token': secondSession.csrfToken },
  });
  assert.equal(result.response.status, 200);
  result = await jsonRequest('/api/dashboard', { headers: { cookie: secondSession.cookie } });
  assert.equal(result.response.status, 401, '注销前的真实 Cookie 不得继续访问后台');

  result = await jsonRequest('/api/events', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(70000) }),
  });
  assert.equal(result.response.status, 413);

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    result = await jsonRequest('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: `wrong-value-${attempt}` }),
    });
  }
  assert.equal(result.response.status, 429);

  const weakGenerated = spawnSync(process.execPath, ['tools/generate-secrets.mjs', '--json'], {
    cwd: root, input: 'aaaaaaaaaaaaaaaa', encoding: 'utf8',
  });
  assert.notEqual(weakGenerated.status, 0, '初始化工具必须拒绝明显重复弱口令');
  const brandGenerated = spawnSync(process.execPath, ['tools/generate-secrets.mjs', '--json'], {
    cwd: root, input: 'Jiuyue!Training7Secure', encoding: 'utf8',
  });
  assert.notEqual(brandGenerated.status, 0, '初始化工具必须拒绝品牌相关口令');
  const phoneGenerated = spawnSync(process.execPath, ['tools/generate-secrets.mjs', '--json'], {
    cwd: root, input: 'River!180-6173-6378QuartzA', encoding: 'utf8',
  });
  assert.notEqual(phoneGenerated.status, 0, '初始化工具必须拒绝包含手机号的口令');

  const hashPassword = 'Quartz!River7Cobalt-2026';
  const generated = spawnSync(process.execPath, ['tools/generate-secrets.mjs', '--json'], {
    cwd: root, input: hashPassword, encoding: 'utf8',
  });
  assert.equal(generated.status, 0, generated.stderr);
  const generatedConfig = JSON.parse(generated.stdout);
  assert.match(generatedConfig.ADMIN_PASSWORD_HASH, /^scrypt\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(generatedConfig.SESSION_SECRET.length >= 32);

  const weakDirectConfiguration = spawnSync(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(await availablePort()), DATA_PATH: dataPath,
      ADMIN_PASSWORD: 'aaaaaaaaaaaaaaaa', ADMIN_PASSWORD_HASH: '', SESSION_SECRET: sessionSecret,
    },
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.notEqual(weakDirectConfiguration.status, 0);
  assert.match(weakDirectConfiguration.stderr, /ADMIN_PASSWORD/);

  await stopServer();
  await startServer({ ADMIN_PASSWORD: '', ADMIN_PASSWORD_HASH: generatedConfig.ADMIN_PASSWORD_HASH, SESSION_SECRET: generatedConfig.SESSION_SECRET });
  result = await jsonRequest('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: hashPassword }),
  });
  assert.equal(result.response.status, 200, '初始化工具生成的 scrypt 哈希必须可用于登录');
});

test('src process entry point serves the same secured health response', async () => {
  await stopServer();
  await startServer({}, 'src/server.mjs');

  const result = await jsonRequest('/api/health');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.service, 'jiuyue-sports');
  assert.equal(result.response.headers.get('x-content-type-options'), 'nosniff');
});
