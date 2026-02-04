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

const { requireAuth, optionalAuth, requireAdmin } = require('./middleware/auth');
const profileRouter = require('./routes/profile');
const remindersRouter = require('./routes/reminders');
const refreshTrackingRouter = require('./routes/refreshTracking');
const manualFulfillRouter = require('./routes/manualFulfill');
const adminUsersRouter = require('./routes/adminUsers');
const supportRouter = require('./routes/support');
const { notFoundHandler, errorHandler } = require('./utils/errors');

const { expressApp } = require('../../functions/index.js');

const app = express();

const trustProxy = process.env.TRUST_PROXY;
if (typeof trustProxy !== 'undefined') {
  app.set('trust proxy', trustProxy);
} else if (isServerless) {
  app.set('trust proxy', 1);
} else {
  app.set('trust proxy', false);
}

const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    if (corsOrigins.length === 0) {
      return callback(new Error('CORS origin not configured'));
    }
    if (corsOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

const shouldRateLimit =
  !isServerless || String(process.env.RATE_LIMIT_ENABLE || '').toLowerCase() === 'true';
if (shouldRateLimit) {
  const limiter = rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 900000),
    max: Number(process.env.RATE_LIMIT_MAX || 300),
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use(limiter);
}
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));

app.get('/', (req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

const apiBasePath = (() => {
  const raw = typeof process.env.API_BASE_PATH === 'string'
    ? process.env.API_BASE_PATH.trim()
    : '';
  if (!raw) {
    return '/';
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return '/';
  }
  if (raw.includes('(') || raw.includes(')') || raw.includes('*') || raw.includes(':splat') || raw.includes('/:')) {
    return '/';
  }
  if (raw === ':' || raw === '/:') {
    return '/';
  }
  if (!raw.startsWith('/')) {
    return `/${raw}`;
  }
  return raw;
})();

const apiRouter = express.Router();

const publicExactPaths = new Set([
  '/verify-address',
  '/submit-order',
  '/email-support',
  '/submit-chat-feedback',
]);
const publicPrefixPaths = ['/promo-codes/', '/wholesale'];

apiRouter.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    return next();
  }
  const path = req.path;
  const isPublic =
    publicExactPaths.has(path) ||
    publicPrefixPaths.some((prefix) => path.startsWith(prefix));
  if (isPublic) {
    return optionalAuth(req, res, next);
  }
  return requireAuth(req, res, next);
});

const adminExactPaths = new Set([
  '/checkImei',
  '/create-admin',
  '/send-email',
]);
const adminPrefixPaths = [
  '/orders/needs-printing',
  '/merge-print',
  '/labels/print/queue',
  '/admin/reminders',
];

apiRouter.use((req, res, next) => {
  const path = req.path;
  const shouldRequireAdmin =
    adminExactPaths.has(path) ||
    adminPrefixPaths.some((prefix) => path.startsWith(prefix));
  if (!shouldRequireAdmin) {
    return next();
  }
  return requireAdmin(req, res, next);
});

apiRouter.get('/health', (req, res) => {
  res.json({ ok: true });
});

apiRouter.use(profileRouter);
apiRouter.use(remindersRouter);
apiRouter.use(refreshTrackingRouter);
apiRouter.use(manualFulfillRouter);
apiRouter.use(adminUsersRouter);
apiRouter.use(supportRouter);

apiRouter.use(expressApp);

const mountPath = isServerless && apiBasePath === '/api' ? '/' : apiBasePath;
app.use(mountPath, apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);

if (!isServerless && require.main === module) {
  const port = Number(process.env.PORT || 3001);
  app.listen(port, () => {
    console.log(`API server listening on port ${port}`);
  });
}

module.exports = app;
