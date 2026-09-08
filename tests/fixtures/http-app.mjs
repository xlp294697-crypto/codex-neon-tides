import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.mjs';
import { loadConfig } from '../../src/config.mjs';

export async function httpFixture(t, { subprocess = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jy-http-test-'));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const config = {
    ...loadConfig(
      {
        DATA_PATH: path.join(directory, 'site.db'),
        ADMIN_PASSWORD: 'Synthetic!Fixture934Key',
        SESSION_SECRET:
          'synthetic-session-secret-at-least-thirty-two-characters',
        COOKIE_SECURE: 'true',
      },
      root,
    ),
    port: 0,
  };
  let stop = async () => {};
  let baseUrl;
  let app;
  const cleanups = [];
  t.after(async () => {
    await stop();
    for (const cleanup of cleanups) cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  async function start() {
    if (subprocess) {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { startServer } from './src/server.mjs';
        const server = startServer(JSON.parse(process.env.TEST_APP_CONFIG));
        server.once('listening', () => process.send(server.address().port));
        process.once('message', async () => { await server.shutdown('test'); process.disconnect(); });
        await server.ready;
      `,
        ],
        {
          cwd: root,
          env: { ...process.env, TEST_APP_CONFIG: JSON.stringify(config) },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      const exited = once(child, 'exit');
      const [port] = await Promise.race([
        once(child, 'message'),
        exited.then(() => {
          throw new Error('Test server exited before listening');
        }),
      ]);
      baseUrl = `http://127.0.0.1:${port}`;
      stop = async () => {
        if (child.connected) child.send('stop');
        await exited;
      };
    } else {
      app = createApp(config);
      await app.lifecycle.initialize();
      const server = createServer(app);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      stop = async () => {
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeIdleConnections();
        });
        app.lifecycle.cancelScheduledEventFlush();
        app.lifecycle.closeDatabase();
      };
    }
  }
  await start();
  const fixture = {
    config,
    get app() {
      return app;
    },
    onCleanup(cleanup) {
      cleanups.push(cleanup);
    },
    async restart() {
      await stop();
      await start();
    },
    async request(url, options) {
      const response = await fetch(baseUrl + url, options);
      return { response, body: await response.json() };
    },
    async login() {
      const result = await fixture.request('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: config.adminPassword }),
      });
      if (result.response.status !== 200) throw new Error('Test login failed');
      return {
        cookie: result.response.headers.get('set-cookie').split(';')[0],
        setCookie: result.response.headers.get('set-cookie'),
        csrfToken: result.body.csrfToken,
      };
    },
  };
  return fixture;
}
