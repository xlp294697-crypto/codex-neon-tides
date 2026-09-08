import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';
import { loadConfig } from './config.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function startServer(config) {
  const app = createApp(config);
  const server = createServer(app);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 200;

  let eventFlushTimer = null;
  let rateLimitCleanup = null;
  let dataMaintenance = null;
  let shutdownStarted = false;

  function cancelScheduledEventFlush() {
    if (eventFlushTimer) clearTimeout(eventFlushTimer);
    eventFlushTimer = null;
  }

  function scheduleEventFlush(delay) {
    if (eventFlushTimer) return;
    eventFlushTimer = setTimeout(() => {
      eventFlushTimer = null;
      void app.lifecycle
        .flushEventBuffer()
        .catch((error) =>
          console.error(
            `[${new Date().toISOString()}] 统计批量写入失败：`,
            error,
          ),
        );
    }, delay);
    eventFlushTimer.unref();
  }

  app.lifecycle.setEventTimerControls({
    schedule: scheduleEventFlush,
    cancel: cancelScheduledEventFlush,
  });

  async function shutdown(signal) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log(`${signal}: stopping Jiuyue Sports...`);
    clearInterval(rateLimitCleanup);
    clearInterval(dataMaintenance);
    cancelScheduledEventFlush();
    const forcedExit = setTimeout(() => process.exit(1), 15000);
    forcedExit.unref();
    let failed = false;
    try {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections?.();
      });
    } catch (error) {
      failed = true;
      console.error('停止接收请求失败：', error);
    }

    let flushError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      cancelScheduledEventFlush();
      try {
        await app.lifecycle.flushEventBuffer({ drain: true });
        flushError = null;
      } catch (error) {
        flushError = error;
        console.error(`停止前第 ${attempt} 次写入统计失败：`, error);
      }
    }
    cancelScheduledEventFlush();
    if (flushError || app.lifecycle.eventBufferLength) {
      failed = true;
      console.error(
        `停止时仍有 ${app.lifecycle.eventBufferLength} 条统计事件未写入。`,
      );
    }
    if (failed) process.exitCode = 1;
    clearTimeout(forcedExit);
  }

  const ready = (async () => {
    await app.lifecycle.initialize();

    rateLimitCleanup = setInterval(
      () => app.lifecycle.cleanupExpiredState(),
      10 * 60000,
    );
    rateLimitCleanup.unref();

    dataMaintenance = setInterval(
      () => void app.lifecycle.runDataMaintenance(),
      6 * 3600000,
    );
    dataMaintenance.unref();

    server.listen(config.port, config.host, () => {
      console.log(
        `Jiuyue Sports ${config.nodeEnv === 'production' ? 'production' : 'development'} server: http://${config.host}:${config.port}`,
      );
      console.log(`Data file: ${config.dataPath}`);
      if (config.nodeEnv === 'production' && !config.cookieSecure) {
        console.warn(
          'WARNING: COOKIE_SECURE=false；只有在完全隔离的本机 HTTP 测试中才应使用。',
        );
      }
    });

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  })();

  Object.defineProperties(server, {
    ready: { value: ready },
    shutdown: { value: shutdown },
  });
  return server;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isProcessEntryPoint =
  entryPath === path.join(ROOT, 'server.mjs') ||
  entryPath === fileURLToPath(import.meta.url);

if (isProcessEntryPoint) {
  const config = loadConfig(process.env, ROOT);
  const server = startServer(config);
  await server.ready;
}
