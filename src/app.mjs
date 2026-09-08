import { randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, closeDatabase } from './db/database.mjs';
import { migrate } from './db/migrate.mjs';
import { createInquiryRepository } from './repositories/inquiry-repository.mjs';
import { createAnalyticsRepository } from './repositories/analytics-repository.mjs';
import { createSessionRepository } from './repositories/session-repository.mjs';
import { transaction } from './repositories/transaction.mjs';
import { HttpError } from './http/errors.mjs';
import { createResponseHelpers } from './http/responses.mjs';
import { createAuth } from './middleware/auth.mjs';
import { requireCsrf } from './middleware/csrf.mjs';
import { createRateLimiter } from './middleware/rate-limit.mjs';
import { getText } from './validation/common.mjs';
import { validateInquiry } from './validation/inquiries.mjs';
import { validateEvent } from './validation/events.mjs';
import { createDashboard } from './services/dashboard-service.mjs';
import { createInquiryService } from './services/inquiry-service.mjs';
import { createAnalyticsService } from './services/analytics-service.mjs';

const STATIC_FILES = new Map([
  [
    '/',
    { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  ],
  [
    '/admin',
    { file: 'admin.html', type: 'text/html; charset=utf-8', cache: 'no-store' },
  ],
  [
    '/privacy',
    {
      file: 'privacy.html',
      type: 'text/html; charset=utf-8',
      cache: 'no-cache',
    },
  ],
  [
    '/robots.txt',
    {
      file: 'robots.txt',
      type: 'text/plain; charset=utf-8',
      cache: 'public, max-age=3600',
    },
  ],
  [
    '/assets/styles.css',
    {
      file: 'styles.css',
      type: 'text/css; charset=utf-8',
      cache: 'public, max-age=3600',
    },
  ],
  [
    '/assets/app.js',
    {
      file: 'app.js',
      type: 'application/javascript; charset=utf-8',
      cache: 'public, max-age=3600',
    },
  ],
  [
    '/assets/admin.js',
    {
      file: 'admin.js',
      type: 'application/javascript; charset=utf-8',
      cache: 'no-store',
    },
  ],
]);

const MEDIA_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

const CATALOG = {
  categories: [
    {
      id: 'exam',
      name: '中考体育',
      description: '面向中学生的体测评估和系统训练。',
    },
    {
      id: 'growth',
      name: '青少年成长',
      description: '体态、体能和年龄适配的运动发展。',
    },
    {
      id: 'special',
      name: '专项训练',
      description: '啦啦操、趣味田径、游泳和专项体测准备。',
    },
  ],
  products: [
    { code: 'ZKTY', name: '中考体育', category: 'exam' },
    { code: 'TLTN', name: '体态体能', category: 'growth' },
    { code: 'LLC', name: '啦啦操专项', category: 'special' },
    { code: 'TRACK', name: '趣味田径', category: 'special' },
    { code: 'JXTC', name: '警校体测', category: 'special' },
    { code: 'SWIM', name: '游泳培训', category: 'growth' },
  ],
};

export function createApp(config) {
  const {
    publicRoot: PUBLIC_ROOT,
    mediaRoot: MEDIA_ROOT,
    dataPath: DATA_PATH,
    eventRetentionDays: EVENT_RETENTION_DAYS,
    maxEventRecords: MAX_EVENT_RECORDS,
    maxInquiryRecords: MAX_INQUIRY_RECORDS,
    icpNumber: ICP_NUMBER,
    reportTimeZone: REPORT_TIME_ZONE,
  } = config;
  const { readJson, sendBuffer, sendJson } = createResponseHelpers(config);

  let db;
  let inquiries;
  let events;
  let sessions;
  let dataHealthy = true;

  const auth = createAuth(config);
  const { verifyAdminPassword, newSession, requireAdmin, sessionCookie } = auth;
  const rateLimiter = createRateLimiter(config);
  const { buckets: rateBuckets, getRequestIp, hitRateLimit, clearRateLimit } = rateLimiter;

  function storageOperation(operation) {
    try {
      const result = operation();
      dataHealthy = true;
      return result;
    } catch (error) {
      dataHealthy = false;
      throw error;
    }
  }

  function pruneData() {
    events.prune({
      cutoff: new Date(Date.now() - EVENT_RETENTION_DAYS * 86400000).toISOString(),
      maxRecords: MAX_EVENT_RECORDS,
    });
    inquiries.prune(MAX_INQUIRY_RECORDS);
  }

  const inquiryService = createInquiryService({
    create: (inquiry) => storageOperation(() => transaction(db, () => {
      inquiries.create(inquiry);
      pruneData();
    })),
    findAll: () => storageOperation(() => inquiries.findAll()),
    updateStatus: (...args) => storageOperation(() => inquiries.updateStatus(...args)),
    remove: (id) => storageOperation(() => inquiries.remove(id)),
  });
  const analyticsService = createAnalyticsService({
    insertBatch: (batch) => storageOperation(() => transaction(db, () => {
      events.insertBatch(batch);
      pruneData();
    })),
  }, { onWriteFailure: () => { dataHealthy = false; } });
  const { flushEventBuffer, cancelScheduledEventFlush } = analyticsService;

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character],
    );
  }

  function readData() {
    return storageOperation(() => ({
      events: events.findAll(),
      inquiries: inquiries.findAll(),
    }));
  }

  async function getSafeMedia(pathname) {
    const match = pathname.match(
      /^\/assets\/media\/([A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpg|jpeg|png|webp))$/i,
    );
    if (!match) return null;
    const candidate = path.join(MEDIA_ROOT, match[1]);
    const mediaReal = await realpath(MEDIA_ROOT);
    let candidateReal;
    try {
      const information = await lstat(candidate);
      if (!information.isFile() || information.isSymbolicLink()) return null;
      candidateReal = await realpath(candidate);
    } catch {
      return null;
    }
    const relative = path.relative(mediaReal, candidateReal);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      return null;
    return {
      path: candidateReal,
      type: MEDIA_TYPES.get(path.extname(candidateReal).toLowerCase()),
    };
  }

  async function serveStatic(req, res, pathname) {
    if (pathname.startsWith('/assets/media/')) {
      const media = await getSafeMedia(pathname);
      if (!media?.type) return false;
      sendBuffer(req, res, 200, await readFile(media.path), media.type, {
        'Cache-Control': 'public, max-age=86400',
      });
      return true;
    }
    const entry = STATIC_FILES.get(pathname);
    if (!entry) return false;
    const filePath = path.join(PUBLIC_ROOT, entry.file);
    let payload = await readFile(filePath);
    if (pathname === '/') {
      const record = ICP_NUMBER
        ? `<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">${escapeHtml(ICP_NUMBER)}</a>`
        : '';
      payload = Buffer.from(
        payload.toString('utf8').replace('<!--ICP_RECORD-->', record),
      );
    }
    sendBuffer(req, res, 200, payload, entry.type, {
      'Cache-Control': entry.cache,
    });
    return true;
  }

  async function route(req, res) {
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(req.url, 'http://localhost').pathname,
      );
    } catch {
      throw new HttpError(400, '网址格式无效。');
    }

    const ip = getRequestIp(req);

    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      pathname === '/api/health'
    ) {
      sendJson(req, res, dataHealthy ? 200 : 503, {
        ok: dataHealthy,
        service: 'jiuyue-sports',
        version: '1.0.0',
        time: new Date().toISOString(),
      });
      return;
    }
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      pathname === '/api/catalog'
    ) {
      sendJson(req, res, 200, CATALOG, {
        'Cache-Control': 'public, max-age=300',
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/events') {
      if (
        hitRateLimit(rateBuckets.eventsGlobal, 'all', 300, 60000) ||
        hitRateLimit(rateBuckets.events, ip, 60, 60000)
      ) {
        throw new HttpError(429, '访问统计请求过于频繁。');
      }
      const body = await readJson(req);
      const result = validateEvent(body);
      if (!result.ok) throw new HttpError(422, result.message);
      const accepted = analyticsService.enqueue(result.value);
      if (!accepted.ok) throw new HttpError(503, accepted.message);
      sendJson(req, res, 202, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/inquiries') {
      if (
        hitRateLimit(rateBuckets.inquiriesGlobal, 'all', 60, 60000) ||
        hitRateLimit(rateBuckets.inquiriesAll, ip, 30, 60000)
      ) {
        throw new HttpError(429, '提交请求过于频繁，请稍后再试。');
      }
      const body = await readJson(req);
      if (getText(body.website, 200)) {
        sendJson(req, res, 201, { ok: true, id: randomUUID() });
        return;
      }
      const result = validateInquiry(body);
      if (!result.ok) throw new HttpError(422, result.message);
      if (
        hitRateLimit(rateBuckets.inquiriesFast, ip, 1, 8000) ||
        hitRateLimit(rateBuckets.inquiriesHourly, ip, 8, 3600000)
      ) {
        throw new HttpError(429, '提交过于频繁，请稍后再试。');
      }
      const inquiry = await inquiryService.create(result.value);
      sendJson(req, res, 201, { ok: true, id: inquiry.id });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      if (hitRateLimit(rateBuckets.login, ip, 5, 15 * 60000))
        throw new HttpError(429, '登录失败次数过多，请稍后再试。');
      const body = await readJson(req);
      if (!verifyAdminPassword(getText(body.password, 250)))
        throw new HttpError(401, '管理员密码错误。');
      clearRateLimit(rateBuckets.login, ip);
      const session = newSession();
      sendJson(
        req,
        res,
        200,
        { ok: true, csrfToken: session.csrfToken },
        { 'Set-Cookie': sessionCookie(session.cookie) },
      );
      return;
    }

    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      pathname === '/api/session'
    ) {
      const session = requireAdmin(req);
      sendJson(req, res, 200, { ok: true, csrfToken: session.csrfToken });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      const session = requireAdmin(req);
      requireCsrf(req, session);
      auth.invalidateSession(session.token);
      sendJson(
        req,
        res,
        200,
        { ok: true },
        { 'Set-Cookie': sessionCookie('', 0) },
      );
      return;
    }

    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      pathname === '/api/dashboard'
    ) {
      requireAdmin(req);
      await flushEventBuffer({ drain: true });
      sendJson(req, res, 200, createDashboard(await readData(), REPORT_TIME_ZONE));
      return;
    }

    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      pathname === '/api/inquiries'
    ) {
      requireAdmin(req);
      sendJson(req, res, 200, { inquiries: await inquiryService.findAll() });
      return;
    }

    const statusMatch = pathname.match(/^\/api\/inquiries\/([A-Za-z0-9-]+)$/);
    if (req.method === 'PATCH' && statusMatch) {
      const session = requireAdmin(req);
      requireCsrf(req, session);
      const body = await readJson(req);
      const result = await inquiryService.updateStatus(statusMatch[1], body.status);
      if (!result.ok) {
        throw new HttpError(result.code === 'INQUIRY_NOT_FOUND' ? 404 : 422, result.message);
      }
      sendJson(req, res, 200, { ok: true });
      return;
    }
    if (req.method === 'DELETE' && statusMatch) {
      const session = requireAdmin(req);
      requireCsrf(req, session);
      const result = await inquiryService.remove(statusMatch[1]);
      if (!result.ok) throw new HttpError(404, result.message);
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (await serveStatic(req, res, pathname)) return;
    }

    throw new HttpError(404, '页面不存在。');
  }

  async function handleRequest(req, res) {
    try {
      await route(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500)
        console.error(
          `[${new Date().toISOString()}] ${req.method} ${req.url}:`,
          error,
        );
      if (!res.headersSent)
        sendJson(req, res, status, {
          error: status === 500 ? '服务器暂时无法处理请求。' : error.message,
        });
      else res.destroy();
    }
  }

  async function initialize() {
    await realpath(MEDIA_ROOT);
    try {
      db = openDatabase(DATA_PATH);
      if (process.platform !== 'win32') await chmod(DATA_PATH, 0o600);
      migrate(db);
      inquiries = createInquiryRepository(db);
      events = createAnalyticsRepository(db);
      sessions = createSessionRepository(db);
      storageOperation(() => transaction(db, pruneData));
      sessions.prune();
    } catch (error) {
      if (db?.isOpen) closeDatabase(db);
      dataHealthy = false;
      throw error;
    }
  }

  function cleanupExpiredState() {
    rateLimiter.cleanupExpiredState();
    auth.cleanupExpiredState();
    try {
      storageOperation(() => sessions.prune());
    } catch {
      console.error(`[${new Date().toISOString()}] 过期会话清理失败。`);
    }
  }

  async function runDataMaintenance() {
    try {
      storageOperation(() => transaction(db, pruneData));
    } catch (error) {
      dataHealthy = false;
      console.error(
        `[${new Date().toISOString()}] 数据保留期限清理失败：`,
        error,
      );
    }
  }

  Object.defineProperty(handleRequest, 'lifecycle', {
    value: Object.freeze({
      initialize,
      closeDatabase() { if (db?.isOpen) closeDatabase(db); },
      cleanupExpiredState,
      runDataMaintenance,
      flushEventBuffer,
      cancelScheduledEventFlush,
      get eventBufferLength() {
        return analyticsService.eventBufferLength;
      },
      setEventTimerControls(controls) {
        analyticsService.setEventTimerControls(controls);
      },
    }),
  });

  return handleRequest;
}
