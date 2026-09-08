import { getText } from '../validation/common.mjs';

export function createRateLimiter(config) {
  const TRUST_PROXY = config.trustProxy;
  const rateBuckets = {
    events: new Map(),
    eventsGlobal: new Map(),
    inquiriesAll: new Map(),
    inquiriesGlobal: new Map(),
    inquiriesFast: new Map(),
    inquiriesHourly: new Map(),
    login: new Map(),
  };
  function getRequestIp(req) {
    if (TRUST_PROXY) {
      const forwarded = getText(req.headers['x-forwarded-for'], 300)
        .split(',')[0]
        .trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function hitRateLimit(bucket, key, limit, windowMs) {
    const now = Date.now();
    const current = bucket.get(key);
    if (!current || current.resetAt <= now) {
      bucket.set(key, { count: 1, resetAt: now + windowMs });
      return false;
    }
    current.count += 1;
    return current.count > limit;
  }

  function clearRateLimit(bucket, key) {
    bucket.delete(key);
  }

  function cleanupExpiredState() {
    const now = Date.now();
    for (const bucket of Object.values(rateBuckets)) {
      for (const [key, value] of bucket) {
        if (value.resetAt <= now) bucket.delete(key);
      }
    }
  }

  return {
    buckets: rateBuckets,
    getRequestIp,
    hitRateLimit,
    clearRateLimit,
    cleanupExpiredState,
  };
}
