import { randomUUID } from 'node:crypto';

// No response bodies, cookies, credentials, or inquiry fields reach diagnostics.
let stage = 'configuration';
let cookie;
let csrfToken;
let inquiryId;
let failed = false;
let origin;
const environment = process.argv[3];
async function request(endpoint, options = {}) {
  const response = await fetch(new URL(endpoint, origin), {
    ...options,
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
    headers: { origin, ...options.headers },
  });
  return response;
}
function requireValue(value) {
  if (!value) throw new Error('Smoke check failed');
}
function authHeaders() {
  return { cookie, 'x-csrf-token': csrfToken };
}
try {
  requireValue(['staging', 'production'].includes(environment));
  const url = new URL(process.argv[2]);
  requireValue(
    !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash,
  );
  requireValue(
    url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(url.hostname)),
  );
  requireValue(process.env.SMOKE_ADMIN_PASSWORD);
  origin = url.origin;
  stage = 'health';
  for (const endpoint of ['/api/health/live', '/api/health']) {
    const response = await request(endpoint);
    const body = await response.json();
    requireValue(response.ok && body.live === true);
    if (endpoint === '/api/health')
      requireValue(body.ready === true && body.database === 'ready');
  }
  stage = 'public-pages';
  for (const [endpoint, type] of [
    ['/', 'text/html'],
    ['/privacy', 'text/html'],
    ['/admin', 'text/html'],
    ['/assets/styles.css', 'text/css'],
    ['/assets/app.js', 'javascript'],
  ]) {
    const response = await request(endpoint);
    requireValue(
      response.status === 200 &&
        response.headers.get('content-type')?.includes(type),
    );
    requireValue((await response.text()).length > 100);
  }
  stage = 'login';
  const login = await request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: process.env.SMOKE_ADMIN_PASSWORD }),
  });
  requireValue(login.status === 200);
  const setCookie = login.headers.get('set-cookie');
  cookie = setCookie?.split(';')[0];
  csrfToken = (await login.json()).csrfToken;
  requireValue(
    cookie &&
      csrfToken &&
      setCookie.includes('HttpOnly') &&
      setCookie.includes('SameSite=Strict') &&
      setCookie.includes('Secure'),
  );
  requireValue(
    (await request('/api/session', { headers: authHeaders() })).status === 200,
  );
  if (environment === 'staging') {
    stage = 'synthetic-inquiry';
    const response = await request('/api/inquiries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parentName: `Synthetic smoke ${randomUUID()}`,
        phone: '+1-202-555-0100',
        grade: 'synthetic',
        course: 'synthetic release check',
        concern: 'Automated synthetic test; delete immediately.',
        privacyConsent: true,
        analyticsConsent: false,
      }),
    });
    requireValue(response.status === 201);
    inquiryId = (await response.json()).id;
    requireValue(
      typeof inquiryId === 'string' && /^[a-f0-9-]{36}$/.test(inquiryId),
    );
    // Mutate the returned ID only; never fetch the production inquiry collection.
    requireValue(
      (
        await request(`/api/inquiries/${inquiryId}`, {
          method: 'PATCH',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'Contacted' }),
        })
      ).status === 200,
    );
  }
} catch {
  failed = true;
  console.error(`Smoke failed: ${stage}`);
} finally {
  if (inquiryId && /^[a-f0-9-]{36}$/.test(inquiryId) && cookie && csrfToken) {
    try {
      requireValue(
        (
          await request(`/api/inquiries/${inquiryId}`, {
            method: 'DELETE',
            headers: authHeaders(),
          })
        ).status === 200,
      );
    } catch {
      failed = true;
      console.error(
        'Smoke failed: synthetic-cleanup; operator cleanup required',
      );
    }
  }
  if (cookie && csrfToken) {
    try {
      requireValue(
        (
          await request('/api/logout', {
            method: 'POST',
            headers: authHeaders(),
          })
        ).status === 200,
      );
    } catch {
      failed = true;
      console.error('Smoke failed: session-cleanup');
    }
  }
}
process.exitCode = failed ? 1 : 0;
if (!failed)
  console.log(
    environment === 'staging'
      ? 'Smoke passed; synthetic inquiry and session removed.'
      : 'Smoke passed; public pages and authentication verified; session removed.',
  );
