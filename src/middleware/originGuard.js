function normalizeHost(input) {
  return String(input || '').trim().toLowerCase().replace(/^www\./, '');
}

function getHostFromHeader(value) {
  if (!value) return null;
  try {
    return normalizeHost(new URL(String(value)).hostname);
  } catch (error) {
    return null;
  }
}

function originGuard(req, res, next) {
  const allowedHosts = String(process.env.ANALYTICS_ALLOWED_HOSTS || '')
    .split(',')
    .map(normalizeHost)
    .filter(Boolean);

  if (!allowedHosts.length) {
    return res.status(500).json({ error: 'analytics_allowed_hosts_not_configured' });
  }

  const allowed = new Set(allowedHosts);
  const originHost = getHostFromHeader(req.headers.origin);
  const refererHost = getHostFromHeader(req.headers.referer);

  if ((originHost && allowed.has(originHost)) || (refererHost && allowed.has(refererHost))) {
    return next();
  }

  return res.status(403).json({ error: 'origin_forbidden' });
}

module.exports = originGuard;
