import {
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './http/errors.mjs';
import { createResponseHelpers } from './http/responses.mjs';

const ANALYTICS_NOTICE_VERSION = '2026-08-22';
const EVENT_BATCH_SIZE = 100;
const EVENT_BUFFER_LIMIT = 1000;
const EVENT_FLUSH_DELAY_MS = 2000;
const EVENT_RETRY_DELAY_MS = 5000;

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
    sessionHours: SESSION_HOURS,
    trustProxy: TRUST_PROXY,
    cookieSecure: COOKIE_SECURE,
    adminPassword: ADMIN_PASSWORD,
    adminPasswordHash: ADMIN_PASSWORD_HASH,
    sessionSecret: SESSION_SECRET,
    icpNumber: ICP_NUMBER,
    reportTimeZone: REPORT_TIME_ZONE,
  } = config;
  const REPORT_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const { readJson, sendBuffer, sendJson } = createResponseHelpers(config);

  const rateBuckets = {
    events: new Map(),
    eventsGlobal: new Map(),
    inquiriesAll: new Map(),
    inquiriesGlobal: new Map(),
    inquiriesFast: new Map(),
    inquiriesHourly: new Map(),
    login: new Map(),
  };
  const adminSessions = new Map();

  let dataQueue = Promise.resolve();
  let dataHealthy = true;
  let eventFlushPromise = null;
  const eventBuffer = [];
  let scheduleEventFlushTimer = () => undefined;
  let cancelEventFlushTimer = () => undefined;

  function getText(value, maximum = 500) {
    if (value === null || value === undefined) return '';
    return String(value).trim().slice(0, maximum);
  }

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

  function getSource(input) {
    const source = normalizeCampaignValue(input?.utm?.source, 40);
    if (source) return source;
    const referrer = normalizeReferrer(input?.referrer).toLowerCase();
    if (referrer.includes('google')) return 'Google';
    if (referrer.includes('bing')) return 'Bing';
    if (referrer) return 'Referral';
    return 'Direct';
  }

  function normalizeCampaignValue(value, maximum) {
    return getText(value, maximum * 2)
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maximum);
  }

  function normalizeReferrer(value) {
    const raw = getText(value, 500);
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      if (!['http:', 'https:'].includes(parsed.protocol)) return '';
      return parsed.origin.slice(0, 250);
    } catch {
      return '';
    }
  }

  function normalizeVisitorId(value) {
    const visitorId = getText(value, 100);
    return /^[A-Za-z0-9_-]{8,100}$/.test(visitorId) ? visitorId : '';
  }

  function readAnalyticsConsent(body) {
    if (
      body?.analyticsConsent !== true ||
      body?.analyticsNoticeVersion !== ANALYTICS_NOTICE_VERSION
    )
      return null;
    const consentAt = getText(body.analyticsConsentAt, 40);
    const timestamp = Date.parse(consentAt);
    if (!Number.isFinite(timestamp) || timestamp > Date.now() + 86400000)
      return null;
    return {
      analyticsConsentAt: new Date(timestamp).toISOString(),
      analyticsNoticeVersion: ANALYTICS_NOTICE_VERSION,
    };
  }

  function getRequestIp(req) {
    if (TRUST_PROXY) {
      const forwarded = getText(req.headers['x-forwarded-for'], 300)
        .split(',')[0]
        .trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function hitRateLimit(bucket, key, limit, windowMs) {
    const now = Date.now();
    const current = bucket.get(key);
    if (!current || current.resetAt <= now) {
      bucket.set(key, { count: 1, resetAt: now + windowMs });
      return false;
    }
    current.count += 1;
    return current.count > limit;
  }

  function clearRateLimit(bucket, key) {
    bucket.delete(key);
  }

  function safeEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  function verifyAdminPassword(password) {
    if (ADMIN_PASSWORD_HASH) {
      const [, salt, expected] = ADMIN_PASSWORD_HASH.split('.');
      const calculated = scryptSync(
        String(password),
        Buffer.from(salt, 'base64url'),
        64,
      ).toString('base64url');
      return safeEqual(calculated, expected);
    }
    return safeEqual(String(password), ADMIN_PASSWORD);
  }

  function sign(value) {
    return createHmac('sha256', SESSION_SECRET)
      .update(value)
      .digest('base64url');
  }

  function newSession() {
    const token = randomBytes(32).toString('base64url');
    const cookie = `${token}.${sign(token)}`;
    const session = {
      token,
      role: 'admin',
      exp: Date.now() + SESSION_HOURS * 3600000,
    };
    adminSessions.set(token, session);
    return { ...session, cookie, csrfToken: sign(`csrf:${cookie}`) };
  }

  function getCookie(req, name) {
    const cookies = String(req.headers.cookie || '').split(';');
    for (const item of cookies) {
      const separator = item.indexOf('=');
      if (separator < 0) continue;
      if (item.slice(0, separator).trim() === name)
        return item.slice(separator + 1).trim();
    }
    return '';
  }

  function readSession(req) {
    const cookie = getCookie(req, 'jy_admin');
    const separator = cookie.lastIndexOf('.');
    if (!cookie || separator < 1) return null;
    const token = cookie.slice(0, separator);
    const signature = cookie.slice(separator + 1);
    if (!safeEqual(sign(token), signature)) return null;
    const session = adminSessions.get(token);
    if (
      !session ||
      session.role !== 'admin' ||
      !Number.isFinite(session.exp) ||
      session.exp <= Date.now()
    ) {
      adminSessions.delete(token);
      return null;
    }
    return { ...session, cookie, csrfToken: sign(`csrf:${cookie}`) };
  }

  function requireAdmin(req) {
    const session = readSession(req);
    if (!session) throw new HttpError(401, '请先登录管理后台。');
    return session;
  }

  function requireCsrf(req, session) {
    if (
      !safeEqual(getText(req.headers['x-csrf-token'], 200), session.csrfToken)
    ) {
      throw new HttpError(403, '安全校验失败，请刷新后台后重试。');
    }
  }

  function sessionCookie(value, maxAge = SESSION_HOURS * 3600) {
    const attributes = [
      `jy_admin=${value}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      `Max-Age=${maxAge}`,
    ];
    if (COOKIE_SECURE) attributes.push('Secure');
    return attributes.join('; ');
  }

  async function ensureDataFile() {
    await mkdir(path.dirname(DATA_PATH), { recursive: true });
    try {
      await stat(DATA_PATH);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(
        DATA_PATH,
        JSON.stringify({ version: 1, events: [], inquiries: [] }, null, 2),
        {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        },
      );
    }
    if (process.platform !== 'win32') await chmod(DATA_PATH, 0o600);
  }

  async function readDataFromDisk() {
    await ensureDataFile();
    let data;
    try {
      data = JSON.parse(await readFile(DATA_PATH, 'utf8'));
    } catch (error) {
      dataHealthy = false;
      throw new Error(`数据文件无法读取或不是有效 JSON：${error.message}`);
    }
    if (!Array.isArray(data.events)) data.events = [];
    if (!Array.isArray(data.inquiries)) data.inquiries = [];
    if (!data.version) data.version = 1;
    dataHealthy = true;
    return data;
  }

  async function atomicWriteData(data) {
    const directory = path.dirname(DATA_PATH);
    const temporary = path.join(
      directory,
      `.${path.basename(DATA_PATH)}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`,
    );
    const payload = `${JSON.stringify(data, null, 2)}\n`;
    try {
      await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      try {
        await rename(temporary, DATA_PATH);
      } catch (error) {
        if (!['EPERM', 'EEXIST'].includes(error.code)) throw error;
        await copyFile(temporary, DATA_PATH);
      }
      dataHealthy = true;
    } catch (error) {
      dataHealthy = false;
      throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async function mutateData(mutator) {
    const operation = dataQueue.then(async () => {
      const data = await readDataFromDisk();
      const cutoff = Date.now() - EVENT_RETENTION_DAYS * 86400000;
      data.events = data.events.filter((event) => {
        const timestamp = Date.parse(event.createdAt);
        return !Number.isFinite(timestamp) || timestamp >= cutoff;
      });
      const result = await mutator(data);
      if (data.events.length > MAX_EVENT_RECORDS)
        data.events = data.events.slice(-MAX_EVENT_RECORDS);
      if (data.inquiries.length > MAX_INQUIRY_RECORDS)
        data.inquiries = data.inquiries.slice(0, MAX_INQUIRY_RECORDS);
      await atomicWriteData(data);
      return result;
    });
    dataQueue = operation.catch(() => undefined);
    return operation;
  }

  async function readData() {
    await dataQueue;
    return readDataFromDisk();
  }

  function scheduleEventFlush(delay = EVENT_FLUSH_DELAY_MS) {
    if (!eventBuffer.length) return;
    scheduleEventFlushTimer(delay);
  }

  function cancelScheduledEventFlush() {
    cancelEventFlushTimer();
  }

  function enqueueEvent(event) {
    if (eventBuffer.length >= EVENT_BUFFER_LIMIT)
      throw new HttpError(503, '统计队列繁忙，请稍后再试。');
    eventBuffer.push(event);
    if (eventBuffer.length >= EVENT_BATCH_SIZE) {
      cancelScheduledEventFlush();
      void flushEventBuffer().catch((error) =>
        console.error(
          `[${new Date().toISOString()}] 统计批量写入失败：`,
          error,
        ),
      );
    } else scheduleEventFlush();
  }

  async function flushEventBuffer({ drain = false } = {}) {
    if (drain) cancelScheduledEventFlush();
    let failed = false;
    try {
      do {
        if (!eventFlushPromise) {
          if (!eventBuffer.length) break;
          const batch = eventBuffer.splice(0, EVENT_BATCH_SIZE);
          eventFlushPromise = (async () => {
            try {
              await mutateData((data) => data.events.push(...batch));
            } catch (error) {
              eventBuffer.unshift(...batch);
              dataHealthy = false;
              throw error;
            }
          })();
        }
        const pendingFlush = eventFlushPromise;
        try {
          await pendingFlush;
        } finally {
          if (eventFlushPromise === pendingFlush) eventFlushPromise = null;
        }
        if (drain) cancelScheduledEventFlush();
      } while (drain && eventBuffer.length);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (eventBuffer.length) {
        const delay = failed
          ? EVENT_RETRY_DELAY_MS
          : eventBuffer.length >= EVENT_BATCH_SIZE
            ? 0
            : EVENT_FLUSH_DELAY_MS;
        scheduleEventFlush(delay);
      }
    }
  }

  function reportDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const parts = Object.fromEntries(
      REPORT_DATE_FORMATTER.formatToParts(date)
        .filter((part) => ['year', 'month', 'day'].includes(part.type))
        .map((part) => [part.type, part.value]),
    );
    return parts.year && parts.month && parts.day
      ? `${parts.year}-${parts.month}-${parts.day}`
      : '';
  }

  function recentReportDates(count = 7, now = Date.now()) {
    const dates = [];
    for (
      let offset = 0;
      dates.length < count && offset < count + 5;
      offset += 1
    ) {
      const date = reportDateKey(now - offset * 86400000);
      if (date && !dates.includes(date)) dates.unshift(date);
    }
    return dates;
  }

  function getDashboard(data) {
    const events = Array.isArray(data.events) ? data.events : [];
    const inquiries = Array.isArray(data.inquiries) ? data.inquiries : [];
    const attributedInquiries = inquiries.filter(
      (item) => item.analyticsAttributed === true,
    );
    const pageViews = events.filter(
      (event) => !event.eventType || event.eventType === 'page_view',
    );
    const bookingSuccessEvents = events.filter(
      (event) => event.eventType === 'booking_success',
    );
    const visitorIds = new Set(
      pageViews
        .map((event) => normalizeVisitorId(event.visitorId))
        .filter(Boolean),
    );
    const trackedConversionVisitorIds = new Set(
      bookingSuccessEvents
        .map((event) => normalizeVisitorId(event.visitorId))
        .filter((visitorId) => visitorId && visitorIds.has(visitorId)),
    );
    const daily = recentReportDates().map((date) => {
      const dailyPageViews = pageViews.filter(
        (event) => reportDateKey(event.createdAt) === date,
      );
      const dailyTrackedVisitors = new Set(
        bookingSuccessEvents
          .filter((event) => reportDateKey(event.createdAt) === date)
          .map((event) => normalizeVisitorId(event.visitorId))
          .filter((visitorId) => visitorId && visitorIds.has(visitorId)),
      );
      return {
        date,
        visits: dailyPageViews.length,
        visitors: new Set(
          dailyPageViews
            .map((event) => normalizeVisitorId(event.visitorId))
            .filter(Boolean),
        ).size,
        enquiries: inquiries.filter(
          (item) => reportDateKey(item.createdAt) === date,
        ).length,
        trackedConversions: dailyTrackedVisitors.size,
      };
    });
    const group = (items, labelFor) => {
      const counts = new Map();
      for (const item of items) {
        const label = labelFor(item) || '未知';
        counts.set(label, (counts.get(label) || 0) + 1);
      }
      return [...counts.entries()]
        .map(([label, value]) => ({ label, value }))
        .sort(
          (a, b) =>
            b.value - a.value || a.label.localeCompare(b.label, 'zh-CN'),
        );
    };
    const imageOpenEvents = events.filter(
      (event) => event.eventType === 'image_open',
    );
    const imageGroups = new Map();
    for (const event of imageOpenEvents) {
      const key = JSON.stringify([
        event.targetId || '',
        event.targetLabel || '',
        event.section || '',
      ]);
      const current = imageGroups.get(key) || {
        id: event.targetId || '',
        label: event.targetLabel || '',
        section: event.section || '',
        value: 0,
      };
      current.value += 1;
      imageGroups.set(key, current);
    }
    const visits = pageViews.length;
    const visitors = visitorIds.size;
    const trackedConversions = trackedConversionVisitorIds.size;
    const topImages = [...imageGroups.values()].sort(
      (a, b) => b.value - a.value || a.id.localeCompare(b.id),
    );
    return {
      metrics: {
        visits,
        visitors,
        enquiries: inquiries.length,
        attributedEnquiries: attributedInquiries.length,
        trackedConversions,
        conversion: visitors
          ? Math.round((trackedConversions / visitors) * 1000) / 10
          : 0,
      },
      reportTimeZone: REPORT_TIME_ZONE,
      daily,
      sources: group(pageViews, (event) => event.source),
      pages: group(pageViews, (event) => event.page).slice(0, 6),
      engagement: {
        qualificationViews: events.filter(
          (event) =>
            event.eventType === 'section_view' &&
            event.section === 'qualifications',
        ).length,
        outcomeViews: events.filter(
          (event) =>
            event.eventType === 'section_view' && event.section === 'outcomes',
        ).length,
        imageOpens: imageOpenEvents.length,
        assessmentClicks: events.filter(
          (event) => event.eventType === 'assessment_click',
        ).length,
        bookingSuccesses: events.filter(
          (event) => event.eventType === 'booking_success',
        ).length,
        topImages,
      },
    };
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
      const analyticsConsent = readAnalyticsConsent(body);
      if (!analyticsConsent)
        throw new HttpError(422, '缺少有效的访问统计同意记录。');
      const eventType = getText(
        body.eventType || 'page_view',
        40,
      ).toLowerCase();
      const supported = [
        'page_view',
        'section_view',
        'image_open',
        'assessment_click',
        'booking_success',
      ];
      if (!supported.includes(eventType))
        throw new HttpError(422, '不支持的统计事件类型。');
      const event = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        eventType,
        page: getText(body.page, 160),
        visitorId: normalizeVisitorId(body.visitorId),
        section: getText(body.section, 80),
        targetId: getText(body.targetId, 120),
        targetLabel: getText(body.targetLabel, 250),
        referrer: normalizeReferrer(body.referrer),
        source: getSource(body),
        medium: normalizeCampaignValue(body?.utm?.medium, 40),
        campaign: normalizeCampaignValue(body?.utm?.campaign, 80),
        device: getText(body.device, 30),
        ...analyticsConsent,
      };
      if (!event.page || !event.visitorId)
        throw new HttpError(422, '缺少页面或随机访客标识。');
      if (
        eventType === 'section_view' &&
        !['qualifications', 'outcomes'].includes(event.section)
      )
        throw new HttpError(422, '区块浏览事件缺少有效区块。');
      if (eventType === 'image_open' && (!event.targetId || !event.targetLabel))
        throw new HttpError(422, '图片打开事件缺少图片标识。');
      if (eventType === 'assessment_click' && !event.section)
        throw new HttpError(422, '预约按钮事件缺少来源区块。');
      enqueueEvent(event);
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
      const analyticsConsent = readAnalyticsConsent(body);
      const clean = {
        parentName: getText(body.parentName, 100),
        phone: getText(body.phone, 40),
        grade: getText(body.grade, 80),
        course: getText(body.course, 100),
        concern: getText(body.concern, 2000),
        preferredTime: getText(body.preferredTime, 100),
        sourcePage: analyticsConsent ? getText(body.sourcePage, 160) : '',
        sourceSection: analyticsConsent ? getText(body.sourceSection, 80) : '',
        referrer: analyticsConsent ? normalizeReferrer(body.referrer) : '',
        privacyConsent:
          body.privacyConsent === true || body.privacyConsent === 'yes',
      };
      if (
        !clean.parentName ||
        !clean.phone ||
        !clean.grade ||
        !clean.course ||
        !/^\+?[0-9][0-9\s-]{5,29}$/.test(clean.phone)
      ) {
        throw new HttpError(
          422,
          '请填写家长姓名、有效电话、孩子年级和意向课程。',
        );
      }
      if (!clean.privacyConsent)
        throw new HttpError(422, '请先确认预约信息处理告知。');
      if (
        hitRateLimit(rateBuckets.inquiriesFast, ip, 1, 8000) ||
        hitRateLimit(rateBuckets.inquiriesHourly, ip, 8, 3600000)
      ) {
        throw new HttpError(429, '提交过于频繁，请稍后再试。');
      }
      const inquiry = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        status: 'New',
        source: analyticsConsent ? getSource(body) : '',
        parentName: clean.parentName,
        phone: clean.phone,
        grade: clean.grade,
        course: clean.course,
        concern: clean.concern,
        preferredTime: clean.preferredTime,
        sourcePage: clean.sourcePage,
        sourceSection: clean.sourceSection,
        referrer: clean.referrer,
        analyticsAttributed: Boolean(analyticsConsent),
        privacyNoticeVersion: '2026-08-22',
        privacyConsentAt: new Date().toISOString(),
      };
      await mutateData((data) => data.inquiries.unshift(inquiry));
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
      adminSessions.delete(session.token);
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
      sendJson(req, res, 200, getDashboard(await readData()));
      return;
    }

    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      pathname === '/api/inquiries'
    ) {
      requireAdmin(req);
      sendJson(req, res, 200, { inquiries: (await readData()).inquiries });
      return;
    }

    const statusMatch = pathname.match(/^\/api\/inquiries\/([A-Za-z0-9-]+)$/);
    if (req.method === 'PATCH' && statusMatch) {
      const session = requireAdmin(req);
      requireCsrf(req, session);
      const body = await readJson(req);
      const allowed = ['New', 'Contacted', 'Qualified', 'Won', 'Closed'];
      if (!allowed.includes(body.status))
        throw new HttpError(422, '预约状态无效。');
      const changed = await mutateData((data) => {
        const inquiry = data.inquiries.find(
          (item) => item.id === statusMatch[1],
        );
        if (!inquiry) return false;
        inquiry.status = body.status;
        inquiry.updatedAt = new Date().toISOString();
        return true;
      });
      if (!changed) throw new HttpError(404, '没有找到该预约。');
      sendJson(req, res, 200, { ok: true });
      return;
    }
    if (req.method === 'DELETE' && statusMatch) {
      const session = requireAdmin(req);
      requireCsrf(req, session);
      const removed = await mutateData((data) => {
        const index = data.inquiries.findIndex(
          (item) => item.id === statusMatch[1],
        );
        if (index < 0) return false;
        data.inquiries.splice(index, 1);
        return true;
      });
      if (!removed) throw new HttpError(404, '没有找到该预约。');
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
    await ensureDataFile();
    await realpath(MEDIA_ROOT);
    await mutateData(() => undefined);
  }

  function cleanupExpiredState() {
    const now = Date.now();
    for (const bucket of Object.values(rateBuckets)) {
      for (const [key, value] of bucket) {
        if (value.resetAt <= now) bucket.delete(key);
      }
    }
    for (const [token, session] of adminSessions) {
      if (session.exp <= now) adminSessions.delete(token);
    }
  }

  async function runDataMaintenance() {
    try {
      await mutateData(() => undefined);
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
      cleanupExpiredState,
      runDataMaintenance,
      flushEventBuffer,
      cancelScheduledEventFlush,
      get eventBufferLength() {
        return eventBuffer.length;
      },
      setEventTimerControls(controls) {
        scheduleEventFlushTimer = controls.schedule;
        cancelEventFlushTimer = controls.cancel;
      },
    }),
  });

  return handleRequest;
}
