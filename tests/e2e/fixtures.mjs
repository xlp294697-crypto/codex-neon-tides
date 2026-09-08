import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.mjs';
import { loadConfig } from '../../src/config.mjs';
import { openDatabase } from '../../src/db/database.mjs';
import { createInquiryRepository } from '../../src/repositories/inquiry-repository.mjs';
import { createAnalyticsRepository } from '../../src/repositories/analytics-repository.mjs';
import { inquiry } from '../fixtures/storage.mjs';

export { expect };

export const test = base.extend({
  // Playwright requires object destructuring even for a fixture with no dependencies.
  // eslint-disable-next-line no-empty-pattern
  app: async ({}, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'jy-e2e-'));
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const config = loadConfig(
      {
        DATA_PATH: path.join(directory, 'synthetic.db'),
        ADMIN_PASSWORD: 'Synthetic!Chromium934Key',
        SESSION_SECRET:
          'synthetic-browser-secret-at-least-thirty-two-characters',
        COOKIE_SECURE: 'false',
        NODE_ENV: 'test',
      },
      root,
    );
    let handler;
    let server;
    let port = 0;
    async function start() {
      handler = createApp(config);
      await handler.lifecycle.initialize();
      server = createServer(handler);
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
      port = server.address().port;
    }
    async function stop() {
      if (server?.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
        });
      }
      if (handler) {
        handler.lifecycle.cancelScheduledEventFlush();
        try {
          await handler.lifecycle.flushEventBuffer();
        } finally {
          handler.lifecycle.closeDatabase();
        }
      }
    }
    function storage(operation) {
      const db = openDatabase(config.dataPath);
      try {
        return operation(db);
      } finally {
        db.close();
      }
    }
    try {
      await start();
      await use({
        baseURL: `http://127.0.0.1:${port}`,
        password: config.adminPassword,
        async restart() {
          await stop();
          await start();
        },
        seedInquiry(id) {
          storage((db) => createInquiryRepository(db).create(inquiry(id)));
        },
        inquiries: () => storage((db) => createInquiryRepository(db).findAll()),
        async events() {
          await handler.lifecycle.flushEventBuffer();
          return storage((db) => createAnalyticsRepository(db).findAll());
        },
      });
    } finally {
      try {
        await stop();
      } finally {
        // Only this fixture's mkdtemp directory is removed, never DATA_PATH from the shell.
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  baseURL: async ({ app }, use) => use(app.baseURL),
  browserHealth: [
    async ({ context }, use) => {
      const problems = [];
      const expected = [];
      function watch(page) {
        page.on('pageerror', () =>
          problems.push('Uncaught browser JavaScript error'),
        );
        page.on('requestfailed', (request) => {
          problems.push(
            `Failed request: ${request.method()} ${new URL(request.url()).pathname}`,
          );
        });
        page.on('response', (response) => {
          if (response.status() < 400) return;
          const pathname = new URL(response.url()).pathname;
          const match = expected.find(
            (item) =>
              item.path === pathname &&
              item.status === response.status() &&
              item.method === response.request().method() &&
              item.seen < item.count,
          );
          if (match) match.seen += 1;
          else
            problems.push(`Unexpected HTTP ${response.status()}: ${pathname}`);
        });
        page.on('console', (message) => {
          if (message.type() !== 'error') return;
          const url = message.location().url;
          const pathname = url ? new URL(url).pathname : '';
          const match = expected.some(
            (item) =>
              item.path === pathname &&
              message.text().startsWith('Failed to load resource:') &&
              message.text().includes(String(item.status)),
          );
          if (!match)
            problems.push(
              `Browser console error at ${pathname || 'unknown location'}`,
            );
        });
      }
      context.on('page', watch);
      for (const page of context.pages()) watch(page);
      await use({
        expectHttpError(method, path, status, count = 1) {
          expected.push({ method, path, status, count, seen: 0 });
        },
      });
      expect(
        problems,
        'No console errors, failed requests, unexpected HTTP errors or resource 404s',
      ).toEqual([]);
      for (const item of expected)
        expect(
          item.seen,
          `${item.method} ${item.path}: expected HTTP ${item.status}`,
        ).toBe(item.count);
    },
    { auto: true },
  ],
});

export async function fillInquiry(page, phone = '00000000000') {
  await page.getByLabel('家长姓名').fill('Synthetic Parent');
  await page.getByLabel('联系电话', { exact: false }).fill(phone);
  await page.getByLabel('孩子年级').selectOption('小学');
  await page.getByLabel('意向课程').selectOption('体态体能');
  await page.locator('[name="privacyConsent"]').check();
}
