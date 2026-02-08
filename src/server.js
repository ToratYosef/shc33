// /shc33/src/server.js
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const isServerless = Boolean(
  process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME
);

if (!isServerless) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const { requireAuth, requireAdmin } = require('./middleware/auth');

const profileRouter = require('./routes/profile');
const remindersRouter = require('./routes/reminders');
const refreshTrackingRouter = require('./routes/refreshTracking');
const manualFulfillRouter = require('./routes/manualFulfill');
const adminUsersRouter = require('./routes/adminUsers');
const supportRouter = require('./routes/support');

const { notFoundHandler, errorHandler } = require('./utils/errors');

// Firebase-functions Express app (contains /verify-address, /submit-order, etc.)
const { expressApp } = require('../functions/index.js');

const app = express();

// --------- REQUEST LOGGING (LIVE PM2 LOGS) ---------
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    console.log(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`
    );
  });

  next();
});

function normalizeTrustProxy(value) {
  if (typeof value === 'undefined') return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return 1;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return value;
}

const trustProxy = normalizeTrustProxy(process.env.TRUST_PROXY);
if (typeof trustProxy !== 'undefined') {
  app.set('trust proxy', trustProxy);
} else {
  // default on VPS + most serverless: trust first proxy
  app.set('trust proxy', 1);
}

const defaultCorsOrigins = [
  'https://secondhandcell.com',
  'https://www.secondhandcell.com',
  'https://api.secondhandcell.com',
];

const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedCorsOrigins = new Set([...defaultCorsOrigins, ...corsOrigins]);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedCorsOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

const shouldRateLimit =
  !isServerless ||
  String(process.env.RATE_LIMIT_ENABLE || '').toLowerCase() === 'true';

if (shouldRateLimit) {
  const limiter = rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 900000),
    max: Number(process.env.RATE_LIMIT_MAX || 300),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const trustProxySetting = app.get('trust proxy');
      if (trustProxySetting) return req.ip;
      return req.socket?.remoteAddress || req.ip || 'unknown';
    },
  });

  app.use(limiter);
}

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));

// Root health (not under /api)
app.get('/', (req, res) => res.status(200).json({ ok: true }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Decide where API lives (defaults to /server if env missing)
const apiBasePath = (() => {
  const raw =
    typeof process.env.API_BASE_PATH === 'string'
      ? process.env.API_BASE_PATH.trim()
      : '';
  if (!raw) return '/server';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return '/server';
  if (
    raw.includes('(') ||
    raw.includes(')') ||
    raw.includes('*') ||
    raw.includes(':splat') ||
    raw.includes('/:')
  ) {
    return '/server';
  }
  if (raw === ':' || raw === '/:') return '/server';
  if (!raw.startsWith('/')) return `/${raw}`;
  return raw;
})();

const mountPath = isServerless && apiBasePath === '/api' ? '/' : apiBasePath;

/**
 * IMPORTANT:
 * Split routers so public endpoints NEVER hit requireAuth.
 */

// ---------- PUBLIC (NO AUTH) ----------
const publicRouter = express.Router();

// Public health under API base
publicRouter.get('/health', (req, res) => res.json({ ok: true }));

// Mount functions Express app publicly (verify-address, submit-order, etc.)
publicRouter.use(expressApp);

// ---------- PRIVATE (AUTH REQUIRED) ----------
const privateRouter = express.Router();

privateRouter.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  return requireAuth(req, res, next);
});

// Admin gate for specific routes
const adminExactPaths = new Set(['/checkImei', '/create-admin', '/send-email']);
const adminPrefixPaths = [
  '/orders/needs-printing',
  '/merge-print',
  '/labels/print/queue',
  '/admin/reminders',
];

privateRouter.use((req, res, next) => {
  const p = req.path;
  const shouldRequireAdmin =
    adminExactPaths.has(p) || adminPrefixPaths.some((prefix) => p.startsWith(prefix));
  if (!shouldRequireAdmin) return next();
  return requireAdmin(req, res, next);
});

// Protected routers
privateRouter.use(profileRouter);
privateRouter.use(remindersRouter);
privateRouter.use(refreshTrackingRouter);
privateRouter.use(manualFulfillRouter);
privateRouter.use(adminUsersRouter);
privateRouter.use(supportRouter);

// Mount both at the same base path
app.use(mountPath, publicRouter);
app.use(mountPath, privateRouter);

app.use(notFoundHandler);
app.use(errorHandler);

if (!isServerless && require.main === module) {
  const port = Number(process.env.PORT || 3001);
  // bind localhost only (recommended)
  app.listen(port, '127.0.0.1', () => {
    console.log(`API server listening on port ${port}`);
  });
}

module.exports = app;
