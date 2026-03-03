const { getClientIp } = require('../utils/ip');

const buckets = new Map();

function analyticsRateLimit(req, res, next) {
  const windowMs = Number(process.env.ANALYTICS_RATE_LIMIT_WINDOW_MS || 60000);
  const maxRequests = Number(process.env.ANALYTICS_RATE_LIMIT_MAX || 120);
  const key = getClientIp(req) || req.ip || 'unknown';
  const now = Date.now();

  const existing = buckets.get(key);
  if (!existing || existing.expiresAt <= now) {
    buckets.set(key, { count: 1, expiresAt: now + windowMs });
    return next();
  }

  existing.count += 1;
  if (existing.count > maxRequests) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  return next();
}

module.exports = analyticsRateLimit;
