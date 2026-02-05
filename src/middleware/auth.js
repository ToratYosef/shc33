const { admin, db } = require('../services/firestore');

function parseBearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }
  return token.trim();
}

async function verifyFirebaseToken(token) {
  return admin.auth().verifyIdToken(token);
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
  try {
    await resolveUser(req);
  } catch (error) {
    req.user = null;
  }
  return next();
}

async function requireAdmin(req, res, next) {
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

    const adminDoc = await db.collection('admins').doc(user.uid).get();
    if (!adminDoc.exists) {
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
