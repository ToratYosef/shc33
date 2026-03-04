const buckets = new Map();

export function createRateLimiter({ windowMs, maxHits }) {
  return (key) => {
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || now > current.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: maxHits - 1 };
    }

    if (current.count >= maxHits) {
      return { allowed: false, retryMs: current.resetAt - now };
    }

    current.count += 1;
    return { allowed: true, remaining: maxHits - current.count };
  };
}
