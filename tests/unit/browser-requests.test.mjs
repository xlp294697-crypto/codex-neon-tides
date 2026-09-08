import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function browser(script) {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector))
      elements.set(selector, {
        hidden: true,
        disabled: false,
        dataset: {},
        textContent: '',
        className: '',
        resets: 0,
        listeners: {},
        addEventListener(name, handler) {
          this.listeners[name] = handler;
        },
        querySelector: element,
        querySelectorAll: () => [],
        focus() {},
        reset() {
          this.resets++;
        },
      });
    return elements.get(selector);
  }
  let fetcher = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: '请登录' } }),
  });
  const timers = new Map();
  let timerId = 0;
  const alerts = [];
  const context = vm.createContext({
    document: {
      querySelector: element,
      querySelectorAll: () => [],
      addEventListener() {},
      referrer: '',
      body: { style: {} },
    },
    window: {},
    location: { search: '', pathname: '/', hash: '' },
    innerWidth: 1000,
    localStorage: { getItem: () => 'no' },
    URLSearchParams,
    URL,
    AbortController,
    FormData: class {
      *[Symbol.iterator]() {
        yield ['parentName', 'Synthetic'];
        yield ['privacyConsent', 'yes'];
      }
    },
    fetch: (...args) => fetcher(...args),
    setTimeout: (callback) => {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
    alert: (message) => alerts.push(message),
    confirm: () => true,
  });
  vm.runInContext(
    await readFile(new URL(`../../public/${script}`, import.meta.url), 'utf8'),
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  return {
    context,
    element,
    timers,
    alerts,
    setFetch(value) {
      fetcher = value;
    },
    request() {
      return vm.runInContext("request('/api/test')", context);
    },
  };
}

for (const script of ['app.js', 'admin.js']) {
  test(`${script} reads safe error messages and reports network failures and timeouts`, async () => {
    const page = await browser(script);
    page.setFetch(async () => ({
      ok: false,
      status: 422,
      json: async () => ({
        error: {
          code: 'INVALID_INQUIRY',
          message: '请检查电话',
          requestId: 'test-id',
        },
      }),
    }));
    await assert.rejects(page.request(), /请检查电话/);
    page.setFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await assert.rejects(page.request(), /网络/);
    page.setFetch(
      (_url, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        ),
    );
    const pending = page.request();
    const assertion = assert.rejects(pending, /超时/);
    for (const callback of page.timers.values()) callback();
    await assertion;
    assert.equal(page.timers.size, 0);
  });

  test(`${script} blocks duplicate form submissions and re-enables the form after failure`, async () => {
    const page = await browser(script);
    const rejecters = [];
    let calls = 0;
    page.setFetch(() => {
      calls++;
      return new Promise((_resolve, rejectRequest) => {
        rejecters.push(rejectRequest);
      });
    });
    const form = page.element(
      script === 'app.js' ? '#booking-form' : '#login-form',
    );
    const button = form.querySelector('[type="submit"]');
    const event = { preventDefault() {}, currentTarget: form };
    const pending = form.listeners.submit(event);
    event.currentTarget = null;
    const duplicate = form.listeners.submit({
      preventDefault() {},
      currentTarget: form,
    });
    const disabled = button.disabled;
    for (const reject of rejecters) reject(new TypeError('Failed to fetch'));
    await Promise.all([pending, duplicate]);
    assert.equal(calls, 1);
    assert.equal(disabled, true);
    assert.equal(button.disabled, false);
    assert.match(
      page.element(script === 'app.js' ? '#status' : '#login-status')
        .textContent,
      /网络/,
    );
  });
}

test('booking resets the saved form reference after a successful asynchronous submission', async () => {
  const page = await browser('app.js');
  let resolve;
  page.setFetch(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const form = page.element('#booking-form');
  const event = { preventDefault() {}, currentTarget: form };
  const pending = form.listeners.submit(event);
  event.currentTarget = null;
  resolve({ ok: true, status: 201, json: async () => ({ ok: true }) });
  await pending;
  assert.equal(form.resets, 1);
  assert.match(page.element('#status').textContent, /预约已提交/);
});

test('failed logout reports the network error without claiming the session was revoked', async () => {
  const page = await browser('admin.js');
  page.setFetch(async () => {
    throw new TypeError('Failed to fetch');
  });
  await page.element('#logout').listeners.click();
  assert.equal(
    page.element('#login-status').textContent.includes('已退出'),
    false,
  );
  assert.match(page.alerts[0], /网络/);
});
