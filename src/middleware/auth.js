const { existsById } = require('../services/db');

function isAuthDisabled() {
  const raw = String(process.env.DISABLE_AUTH || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function ensurePublicUser(req) {
  if (!req.user) {
    req.user = { uid: 'public', claims: {}, isAdmin: true };
  }
  if (!req.user.claims) {
    req.user.claims = {};
  }
  req.user.isAdmin = true;
  return req.user;
}

function parseBearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }
  return token.trim();
}

const crypto = require('crypto');

let certCache = { expiresAt: 0, certs: {} };

function parseBearerPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed token.');
  }
  const [headerB64, payloadB64] = parts;
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  return { header, payload };
}

async function getFirebaseCerts() {
  const now = Date.now();
  if (certCache.expiresAt > now && certCache.certs && Object.keys(certCache.certs).length) {
    return certCache.certs;
  }

  const res = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  if (!res.ok) {
    throw new Error(`Failed to fetch Firebase certs: ${res.status}`);
  }

  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 60 * 60 * 1000;
  const certs = await res.json();

  certCache = {
    certs,
    expiresAt: now + maxAgeMs,
  };

  return certs;
}

function verifyTokenSignature(token, certPem) {
  const [headerB64, payloadB64, signatureB64] = token.split('.');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  return verifier.verify(certPem, Buffer.from(signatureB64, 'base64url'));
}

async function verifyFirebaseToken(token) {
  const { header, payload } = parseBearerPayload(token);
  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Invalid token header.');
  }

  const certs = await getFirebaseCerts();
  const certPem = certs[header.kid];
  if (!certPem) {
    throw new Error('Signing certificate not found for token.');
  }

  if (!verifyTokenSignature(token, certPem)) {
    throw new Error('Token signature verification failed.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp && nowSec >= payload.exp) {
    throw new Error('Token expired.');
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (projectId && payload.aud !== projectId) {
    throw new Error('Invalid token audience.');
  }

  return payload;
}

async function resolveUser(req) {
  if (req.user) {
    return req.user;
  }

  const token = parseBearerToken(req);
  if (!token) {
    return null;
  }

  const decoded = await verifyFirebaseToken(token);
  const user = {
    uid: decoded.uid,
    email: decoded.email || null,
    claims: decoded,
  };
  req.user = user;
  return user;
}

async function requireAuth(req, res, next) {
  if (isAuthDisabled()) {
    ensurePublicUser(req);
    return next();
  }
  try {
    const user = await resolveUser(req);
    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'Authentication required. Please sign in and try again.',
        code: 'auth/unauthenticated',
      });
    }

    return next();
  } catch (error) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid or expired authentication token.',
      code: 'auth/invalid-token',
      detail: error?.message || 'Token verification failed.',
    });
  }
}

async function optionalAuth(req, res, next) {
  if (isAuthDisabled()) {
    ensurePublicUser(req);
    return next();
  }
  try {
    await resolveUser(req);
  } catch (error) {
    req.user = null;
  }
  return next();
}

async function requireAdmin(req, res, next) {
  if (isAuthDisabled()) {
    ensurePublicUser(req);
    return next();
  }
  if (req.method === 'OPTIONS') {
    return next();
  }

  try {
    const user = await resolveUser(req);
    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'Authentication required. Please sign in and try again.',
        code: 'auth/unauthenticated',
      });
    }

    const hasAdminClaim = user?.claims?.admin === true;
    if (hasAdminClaim) {
      req.user.isAdmin = true;
      return next();
    }

    const adminExists = await existsById('admins', user.uid);
    if (!adminExists) {
      return res.status(403).json({
        ok: false,
        error: 'Admin privileges required for this action.',
        code: 'auth/forbidden',
      });
    }

    req.user.isAdmin = true;
    return next();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'Failed to verify admin access.',
      code: 'auth/admin-check-failed',
      detail: error?.message || 'Admin verification failed.',
    });
  }
}

function createAuthGate({ publicPaths = [] } = {}) {
  return async function authGate(req, res, next) {
    if (isAuthDisabled()) {
      ensurePublicUser(req);
      return next();
    }
    if (req.method === 'OPTIONS') {
      return next();
    }

    const path = req.path || '/';
    const isPublic = publicPaths.some((matcher) =>
      typeof matcher === 'string' ? matcher === path : matcher.test(path)
    );
    if (isPublic) {
      return optionalAuth(req, res, next);
    }
    return requireAuth(req, res, next);
  };
}

module.exports = {
  requireAuth,
  requireAdmin,
  optionalAuth,
  createAuthGate,
};
