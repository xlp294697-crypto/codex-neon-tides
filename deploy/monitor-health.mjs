import { execFile } from 'node:child_process';
import { readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { connect } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { backupTime, checkDatabase } from '../tools/sqlite-operations.mjs';
import { verifyBackup } from '../tools/verify-backup.mjs';

export function evaluateHealth(state) {
  const checks = [
    [state.homepage === true, 'HOMEPAGE_FAILED'],
    [state.readiness === true, 'READINESS_FAILED'],
    [
      Number.isFinite(state.diskFreeBytes) && state.diskFreeBytes >= 1073741824,
      'DISK_LOW',
    ],
    [state.containerRunning === true, 'CONTAINER_DOWN'],
    [
      Number.isFinite(state.containerRestarts) &&
        state.containerRestarts >= 0 &&
        state.containerRestarts < 3,
      'CONTAINER_RESTARTS',
    ],
    [
      Number.isFinite(state.certificateDays) && state.certificateDays > 14,
      'CERTIFICATE_EXPIRING',
    ],
    [
      Number.isFinite(state.backupAgeHours) &&
        state.backupAgeHours >= 0 &&
        state.backupAgeHours <= 36,
      'BACKUP_STALE',
    ],
    [state.sqlite === true, 'SQLITE_FAILED'],
  ];
  const codes = checks.filter(([ok]) => !ok).map(([, code]) => code);
  return { ok: codes.length === 0, codes };
}
async function inspectContainer(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))
    throw new Error('Invalid container');
  const { stdout } = await promisify(execFile)(
    'docker',
    [
      'inspect',
      '--format',
      '{{.State.Running}} {{.State.Restarting}} {{.RestartCount}}',
      name,
    ],
    { timeout: 10000, maxBuffer: 4096, windowsHide: true },
  );
  const match = /^(true|false) (true|false) (\d+)\s*$/.exec(stdout);
  if (!match) throw new Error('Invalid inspection');
  return {
    running: match[1] === 'true',
    restarting: match[2] === 'true',
    restarts: Number(match[3]),
  };
}
function certificateDays(url) {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: url.hostname,
      port: Number(url.port || 443),
      servername: url.hostname,
      rejectUnauthorized: true,
    });
    socket.setTimeout(10000, () => socket.destroy(new Error('TLS timeout')));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const expires = Date.parse(socket.getPeerCertificate().valid_to);
      socket.end();
      resolve((expires - Date.now()) / 86400000);
    });
  });
}
export async function collectHealth(config, adapters = {}) {
  const url = new URL(config.origin);
  const local =
    config.allowLocalHttp &&
    url.protocol === 'http:' &&
    ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (!local && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !config.database ||
    !config.backupDirectory ||
    !config.container
  )
    throw new Error('Invalid configuration');
  const state = {};
  const errors = [];
  async function probe(code, action) {
    try {
      await action();
    } catch {
      errors.push(code);
    }
  }
  await Promise.all([
    probe('HOMEPAGE_FAILED', async () => {
      const res = await fetch(new URL('/', url), {
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      state.homepage =
        res.status === 200 &&
        !!res.headers.get('content-type')?.includes('text/html');
      await res.body?.cancel();
    }),
    probe('READINESS_FAILED', async () => {
      const res = await fetch(new URL('/api/health', url), {
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      const body = await res.json();
      state.readiness =
        res.status === 200 &&
        body.live === true &&
        body.ready === true &&
        body.database === 'ready';
    }),
    probe('DISK_CHECK_FAILED', async () => {
      const fs = await statfs(path.dirname(config.database));
      state.diskFreeBytes = fs.bavail * fs.bsize;
    }),
    probe('CONTAINER_CHECK_FAILED', async () => {
      const container = await (adapters.inspectContainer || inspectContainer)(
        config.container,
      );
      state.containerRunning = container.running && !container.restarting;
      state.containerRestarts = container.restarts;
    }),
    probe('CERTIFICATE_CHECK_FAILED', async () => {
      state.certificateDays = local ? 36500 : await certificateDays(url);
    }),
    probe('BACKUP_UNVERIFIED', async () => {
      const names = (await readdir(config.backupDirectory))
        .filter((name) => Number.isFinite(backupTime(name)))
        .sort()
        .reverse();
      if (!names.length) throw new Error('No backup');
      // A damaged newest backup requires action even if an older copy verifies.
      await verifyBackup(path.join(config.backupDirectory, names[0]));
      state.backupAgeHours = (Date.now() - backupTime(names[0])) / 3600000;
    }),
    probe('SQLITE_FAILED', async () => {
      await checkDatabase(config.database);
      state.sqlite = true;
    }),
  ]);
  const codes = [
    ...new Set([...errors, ...evaluateHealth(state).codes]),
  ].sort();
  return { ok: codes.length === 0, codes };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  let result;
  try {
    const { values } = parseArgs({
      options: {
        origin: { type: 'string' },
        database: { type: 'string' },
        'backup-directory': { type: 'string' },
        container: { type: 'string' },
        'allow-local-http': { type: 'boolean', default: false },
      },
    });
    result = await collectHealth({
      origin: values.origin,
      database: values.database,
      backupDirectory: values['backup-directory'],
      container: values.container,
      allowLocalHttp: values['allow-local-http'],
    });
  } catch {
    result = { ok: false, codes: ['MONITOR_CONFIGURATION'] };
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
