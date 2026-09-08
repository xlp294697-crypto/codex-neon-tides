const CATEGORIES = new Set([
  'HTTP_INTERNAL_ERROR',
  'SESSION_MAINTENANCE_FAILED',
  'ANALYTICS_RETENTION_FAILED',
  'INQUIRY_RETENTION_FAILED',
  'ANALYTICS_FLUSH_FAILED',
  'SERVER_SHUTDOWN_STARTED',
  'SERVER_CLOSE_FAILED',
  'SERVER_ANALYTICS_DRAIN_FAILED',
  'SERVER_ANALYTICS_PENDING',
  'DATABASE_CLOSE_FAILED',
  'SERVER_STARTED',
  'INSECURE_COOKIE_CONFIGURATION',
]);

const DETAIL_KEYS = new Set([
  'requestId',
  'attempt',
  'pending',
  'signal',
  'environment',
  'port',
]);

function safeDetail(key, value) {
  if (!DETAIL_KEYS.has(key)) return undefined;
  if (['attempt', 'pending', 'port'].includes(key))
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const text = String(value);
  return /^[A-Za-z0-9:_-]{1,80}$/.test(text) ? text : undefined;
}

export function writeLog(level, category, details = {}) {
  const safeCategory = CATEGORIES.has(category)
    ? category
    : 'HTTP_INTERNAL_ERROR';
  const entry = {
    timestamp: new Date().toISOString(),
    level: ['info', 'warn', 'error'].includes(level) ? level : 'error',
    category: safeCategory,
  };
  for (const [key, value] of Object.entries(details)) {
    const safe = safeDetail(key, value);
    if (safe !== undefined) entry[key] = safe;
  }
  const sink = entry.level === 'info' ? console.log : console[entry.level];
  sink(JSON.stringify(entry));
}
