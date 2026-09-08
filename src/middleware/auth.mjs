import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../http/errors.mjs';

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createAuth(config) {
  const {
    adminPassword: ADMIN_PASSWORD, adminPasswordHash: ADMIN_PASSWORD_HASH,
    sessionSecret: SESSION_SECRET, sessionHours: SESSION_HOURS,
    cookieSecure: COOKIE_SECURE,
  } = config;
  const adminSessions = new Map();

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

  function invalidateSession(token) {
    adminSessions.delete(token);
  }

  function cleanupExpiredState() {
    const now = Date.now();
    for (const [token, session] of adminSessions) {
      if (session.exp <= now) adminSessions.delete(token);
    }
  }

  return { verifyAdminPassword, newSession, readSession, requireAdmin, sessionCookie, invalidateSession, cleanupExpiredState };
}
