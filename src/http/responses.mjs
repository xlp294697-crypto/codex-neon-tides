import { HttpError } from './errors.mjs';

export function createResponseHelpers({ enableHsts, maxBodyBytes }) {
  function securityHeaders(cacheControl = 'no-store') {
    const headers = {
      'Cache-Control': cacheControl,
      'Content-Security-Policy':
        "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'",
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    };
    if (enableHsts)
      headers['Strict-Transport-Security'] =
        'max-age=31536000; includeSubDomains';
    return headers;
  }

  function sendBuffer(req, res, status, payload, contentType, headers = {}) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    res.writeHead(status, {
      ...securityHeaders(headers['Cache-Control'] || 'no-store'),
      'Content-Type': contentType,
      'Content-Length': body.length,
      ...headers,
      'X-Request-Id': req.requestId,
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  }

  function sendJson(req, res, status, body, headers = {}) {
    sendBuffer(
      req,
      res,
      status,
      Buffer.from(JSON.stringify(body)),
      'application/json; charset=utf-8',
      headers,
    );
  }

  async function readJson(req) {
    const contentType = String(req.headers['content-type'] || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'application/json')
      throw new HttpError(415, '请求必须使用 application/json。');
    if (
      String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site'
    ) {
      throw new HttpError(403, '不接受跨站写入请求。');
    }
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (
      !Number.isFinite(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > maxBodyBytes
    ) {
      throw new HttpError(413, '提交内容过大。');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBodyBytes) throw new HttpError(413, '提交内容过大。');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('not-an-object');
      return parsed;
    } catch {
      throw new HttpError(400, '请求内容必须是有效的 JSON 对象。', 'INVALID_JSON');
    }
  }

  return Object.freeze({ readJson, securityHeaders, sendBuffer, sendJson });
}
