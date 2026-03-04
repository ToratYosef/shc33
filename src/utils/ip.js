const ipaddr = require('ipaddr.js');

function normalizeIp(value) {
  if (!value) return null;
  let candidate = String(value).trim();
  if (!candidate) return null;
  if (candidate.includes(',')) {
    candidate = candidate.split(',')[0].trim();
  }
  if (candidate.startsWith('::ffff:')) {
    candidate = candidate.slice(7);
  }
  return candidate;
}

function isPublicIp(value) {
  try {
    const addr = ipaddr.parse(value);
    if (addr.kind() === 'ipv4') {
      const range = addr.range();
      return !['private', 'loopback', 'linkLocal', 'broadcast', 'carrierGradeNat', 'reserved', 'multicast', 'unspecified'].includes(range);
    }

    const range = addr.range();
    return !['uniqueLocal', 'loopback', 'linkLocal', 'multicast', 'unspecified', 'reserved'].includes(range);
  } catch (error) {
    return false;
  }
}

function firstPublicForwardedIp(xForwardedFor) {
  if (!xForwardedFor) return null;
  const values = String(xForwardedFor)
    .split(',')
    .map((part) => normalizeIp(part))
    .filter(Boolean);

  return values.find((candidate) => isPublicIp(candidate)) || null;
}

function getClientIp(req) {
  const cfIp = normalizeIp(req.headers['cf-connecting-ip']);
  if (cfIp) {
    return cfIp;
  }

  const forwarded = firstPublicForwardedIp(req.headers['x-forwarded-for']);
  if (forwarded) {
    return forwarded;
  }

  return normalizeIp(req.socket?.remoteAddress) || null;
}

function maskIp(ip) {
  if (!ip) return null;

  try {
    const addr = ipaddr.parse(ip);
    if (addr.kind() === 'ipv4') {
      const octets = addr.octets.slice(0, 3);
      octets.push(0);
      return octets.join('.');
    }

    const parts = addr.parts.slice(0, 3);
    while (parts.length < 8) {
      parts.push(0);
    }
    return ipaddr.IPv6.fromParts(parts).toNormalizedString();
  } catch (error) {
    return null;
  }
}

module.exports = {
  getClientIp,
  maskIp,
};
