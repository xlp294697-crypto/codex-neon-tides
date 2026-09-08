const mode = process.argv[2] || 'readiness';
try {
  if (!['liveness', 'readiness'].includes(mode))
    throw new Error('Invalid probe');
  const port = Number(process.env.PORT || 3002);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid port');
  const endpoint = mode === 'liveness' ? '/api/health/live' : '/api/health';
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    signal: AbortSignal.timeout(6500),
    redirect: 'error',
  });
  const health = await response.json();
  process.exitCode =
    response.ok &&
    health.live === true &&
    (mode === 'liveness' ||
      (health.ready === true && health.database === 'ready'))
      ? 0
      : 1;
} catch {
  process.exitCode = 1;
}
