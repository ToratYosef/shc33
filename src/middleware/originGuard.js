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

function getAllowedAnalyticsHosts() {
  const configuredHosts = String(process.env.ANALYTICS_ALLOWED_HOSTS || '')
    .split(',')
    .map(normalizeHost)
    .filter(Boolean);

  if (configuredHosts.length) {
    return configuredHosts;
  }

  return ['secondhandcell.com', 'api.secondhandcell.com'];
}

function originGuard(req, res, next) {
  const allowedHosts = getAllowedAnalyticsHosts();
  const allowed = new Set(allowedHosts);
  const originHost = getHostFromHeader(req.headers.origin);
  const refererHost = getHostFromHeader(req.headers.referer);

  if ((originHost && allowed.has(originHost)) || (refererHost && allowed.has(refererHost))) {
    return next();
  }

  return res.status(403).json({ error: 'origin_forbidden' });
}

module.exports = originGuard;
module.exports.getAllowedAnalyticsHosts = getAllowedAnalyticsHosts;
module.exports.normalizeHost = normalizeHost;
