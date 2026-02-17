const path = require('path');
const fs = require('fs');
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

const {
  expressApp,
  updateOrderBoth,
  buildOrderDeviceKey,
} = require('../functions/index.js');
const { admin } = require('../functions/helpers/firebaseAdmin');

const app = express();

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeIssueReason(value) {
  if (!value) {
    return '';
  }
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function toTitleCase(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

const ISSUE_COPY = {
  outstanding_balance: {
    title: 'Outstanding Balance',
    detail: 'Please pay off any carrier balance tied to the device.',
  },
  password_locked: {
    title: 'Password Locked',
    detail: 'Remove the passcode and sign out of all accounts on the phone.',
  },
  stolen: {
    title: 'Reported Lost or Stolen',
    detail: 'Carrier systems show this device as lost or stolen.',
  },
  fmi_active: {
    title: 'FMI/FRP Enabled',
    detail: 'Disable Find My iPhone/FRP and remove all accounts.',
  },
};

function buildIssueList(order) {
  const issues = [];
  const qcIssuesByDevice = order?.qcIssuesByDevice;

  if (qcIssuesByDevice && typeof qcIssuesByDevice === 'object' && !Array.isArray(qcIssuesByDevice)) {
    Object.keys(qcIssuesByDevice).forEach((deviceKey) => {
      const issueMap = qcIssuesByDevice[deviceKey];
      if (!issueMap || typeof issueMap !== 'object' || Array.isArray(issueMap)) {
        return;
      }
      Object.keys(issueMap).forEach((reasonKey) => {
        const issue = issueMap[reasonKey] || {};
        const reason = normalizeIssueReason(issue.reason || reasonKey);
        if (!reason) {
          return;
        }
        issues.push({
          deviceKey,
          reason,
          resolved: Boolean(issue.resolved) || Boolean(issue.resolvedAt),
          notes: issue.notes || '',
        });
      });
    });
  }

  if (!issues.length) {
    const fallbackReason = normalizeIssueReason(
      order?.lastConditionEmailReason || order?.conditionEmailReason || ''
    );
    if (fallbackReason) {
      const fallbackKey = buildOrderDeviceKey(order?.id || order?.orderId || '', 0);
      issues.push({
        deviceKey: fallbackKey,
        reason: fallbackReason,
        resolved: false,
        notes: order?.lastConditionEmailNotes || '',
      });
    }
  }

  return issues;
}

function normalizeTrustProxy(value) {
  if (typeof value === 'undefined') {
    return undefined;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return 1;
  }
  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }
  return value;
}

const trustProxy = normalizeTrustProxy(process.env.TRUST_PROXY);
if (typeof trustProxy !== 'undefined') {
  app.set('trust proxy', trustProxy);
} else if (isServerless) {
  app.set('trust proxy', 1);
} else {
  app.set('trust proxy', 1);
}

const defaultCorsOrigins = [
  'https://secondhandcell.com',
  'https://www.secondhandcell.com',
  'https://admin.secondhandcell.com',
  'http://admin.secondhandcell.com',
  'https://api.secondhandcell.com',
  'https://cautious-pancake-69p475gq54q4f5qp4-3001.app.github.dev',
];

const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedCorsOrigins = new Set([
  ...defaultCorsOrigins,
  ...corsOrigins,
]);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    if (allowedCorsOrigins.has(origin)) {
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
    keyGenerator: (req) => {
      const trustProxySetting = app.get('trust proxy');
      if (trustProxySetting) {
        return req.ip;
      }
      return req.socket?.remoteAddress || req.ip || 'unknown';
    },
  });

  app.use(limiter);
}
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));

app.get('/', (req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/api/orders/:orderId/issue-resolved', (req, res) => {
  const orderId = String(req.params.orderId || '').trim();
  if (!orderId) {
    return res.status(400).send('Order ID is required.');
  }
  return res.redirect(`https://api.secondhandcell.com/fix-issue/${encodeURIComponent(orderId)}`);
});

app.get('/fix-issue/:orderId', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    if (!orderId) {
      return res.status(400).send('Order ID is required.');
    }

    const orderRef = admin.firestore().collection('orders').doc(orderId);
    const snapshot = await orderRef.get();
    if (!snapshot.exists) {
      return res.status(404).send('Order not found.');
    }

    const order = { id: snapshot.id, ...snapshot.data() };
    const issues = buildIssueList(order);
    const safeOrderId = escapeHtml(orderId);
    const confirmUrl = `/fix-issue/${encodeURIComponent(orderId)}/confirm`;

    const issuesHtml = issues.length
      ? issues
          .map((issue, index) => {
            const copy = ISSUE_COPY[issue.reason] || {
              title: toTitleCase(issue.reason),
              detail: 'Please resolve this issue so we can continue processing.',
            };
            const safeDeviceKey = escapeHtml(issue.deviceKey);
            const safeReason = escapeHtml(issue.reason);
            const safeNotes = issue.notes ? `<p class="issue-notes">${escapeHtml(issue.notes)}</p>` : '';
            const statusLabel = issue.resolved ? 'Resolved' : 'Needs action';
            const buttonHtml = issue.resolved
              ? ''
              : `<button class="issue-button" data-device-key="${safeDeviceKey}" data-reason="${safeReason}">Confirm resolved</button>`;

            return `
              <div class="issue-card" data-issue-index="${index}">
                <div class="issue-header">
                  <div>
                    <div class="issue-title">${escapeHtml(copy.title)}</div>
                    <div class="issue-detail">${escapeHtml(copy.detail)}</div>
                  </div>
                  <span class="issue-status ${issue.resolved ? 'resolved' : 'pending'}">${statusLabel}</span>
                </div>
                <div class="issue-meta">Device: ${safeDeviceKey}</div>
                ${safeNotes}
                ${buttonHtml}
                <div class="issue-feedback" aria-live="polite"></div>
              </div>
            `;
          })
          .join('')
      : '<p>No outstanding issues were found for this order.</p>';

    res.status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Issue Resolved</title>
    <style>
      :root {
        color-scheme: light;
      }
      body {
        margin: 0;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        background: #f8fafc;
        color: #0f172a;
        display: flex;
        min-height: 100vh;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        max-width: 520px;
        width: 100%;
        background: #ffffff;
        border-radius: 18px;
        box-shadow: 0 20px 50px rgba(15, 23, 42, 0.12);
        padding: 32px;
        text-align: center;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 24px;
      }
      p {
        margin: 8px 0 0;
        color: #475569;
        line-height: 1.6;
      }
      .order {
        margin: 18px 0 0;
        font-weight: 600;
        color: #0f172a;
      }
      .issues {
        margin-top: 20px;
        display: grid;
        gap: 16px;
      }
      .issue-card {
        border: 1px solid #e2e8f0;
        border-radius: 14px;
        padding: 18px;
        background: #f8fafc;
      }
      .issue-header {
        display: flex;
        gap: 12px;
        justify-content: space-between;
        align-items: flex-start;
      }
      .issue-title {
        font-weight: 700;
        font-size: 16px;
      }
      .issue-detail {
        font-size: 14px;
        color: #64748b;
        margin-top: 4px;
      }
      .issue-status {
        font-size: 12px;
        padding: 4px 10px;
        border-radius: 9999px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .issue-status.pending {
        background: #fef3c7;
        color: #92400e;
      }
      .issue-status.resolved {
        background: #dcfce7;
        color: #166534;
      }
      .issue-meta {
        margin-top: 10px;
        font-size: 13px;
        color: #475569;
      }
      .issue-notes {
        margin: 10px 0 0;
        font-size: 13px;
        color: #334155;
        background: #ffffff;
        border-radius: 10px;
        padding: 10px 12px;
        border: 1px solid #e2e8f0;
      }
      .issue-button {
        margin-top: 14px;
        background: #10b981;
        color: #ffffff;
        border: none;
        border-radius: 9999px;
        padding: 14px 32px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 10px 20px rgba(16, 185, 129, 0.25);
      }
      .issue-button[disabled] {
        opacity: 0.6;
        cursor: default;
      }
      .issue-feedback {
        margin-top: 10px;
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Issue Resolved</h1>
      <p>Resolve each issue below. We will continue once everything is cleared.</p>
      <div class="order">Order #${safeOrderId}</div>
      <div class="issues">${issuesHtml}</div>
    </div>
    <script>
      (function () {
        var buttons = document.querySelectorAll('.issue-button');
        function setFeedback(container, message, color) {
          if (!container) return;
          container.textContent = message;
          container.style.color = color || '#475569';
        }
        buttons.forEach(function (button) {
          button.addEventListener('click', function () {
            if (button.disabled) return;
            var deviceKey = button.getAttribute('data-device-key');
            var reason = button.getAttribute('data-reason');
            var card = button.closest('.issue-card');
            var feedback = card ? card.querySelector('.issue-feedback') : null;
            var statusLabel = card ? card.querySelector('.issue-status') : null;
            button.disabled = true;
            setFeedback(feedback, 'Sending confirmation...', '#64748b');
            fetch('${confirmUrl}', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceKey: deviceKey, reason: reason }),
            })
              .then(function (response) {
                if (!response.ok) {
                  throw new Error('Request failed. Please try again.');
                }
                return response.json();
              })
              .then(function () {
                setFeedback(feedback, 'Confirmed. Thank you!', '#16a34a');
                if (statusLabel) {
                  statusLabel.textContent = 'Resolved';
                  statusLabel.classList.remove('pending');
                  statusLabel.classList.add('resolved');
                }
              })
              .catch(function (error) {
                button.disabled = false;
                setFeedback(feedback, error.message || 'Unable to confirm. Please try again.', '#dc2626');
              });
          });
        });
      })();
    </script>
  </body>
</html>`);
  } catch (error) {
    console.error('Failed to load fix-issue page:', error);
    return res.status(500).send('Unable to load issue resolution page.');
  }
});

app.post('/fix-issue/:orderId/confirm', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    if (!orderId) {
      return res.status(400).json({ error: 'Order ID is required.' });
    }

    const reason = normalizeIssueReason(req.body?.reason);
    const deviceKey = typeof req.body?.deviceKey === 'string' && req.body.deviceKey.trim()
      ? req.body.deviceKey.trim()
      : buildOrderDeviceKey(orderId, 0);
    if (!reason) {
      return res.status(400).json({ error: 'Issue reason is required.' });
    }

    const orderRef = admin.firestore().collection('orders').doc(orderId);
    const snapshot = await orderRef.get();
    if (!snapshot.exists) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const order = { id: snapshot.id, ...snapshot.data() };

    const updatePayload = {};
    const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();

    updatePayload[`qcIssuesByDevice.${deviceKey}.${reason}.resolvedAt`] = serverTimestamp;
    updatePayload[`qcIssuesByDevice.${deviceKey}.${reason}.resolved`] = true;
    updatePayload[`qcIssuesByDevice.${deviceKey}.${reason}.updatedAt`] = serverTimestamp;

    const updatedOrder = {
      ...order,
      qcIssuesByDevice: {
        ...(order.qcIssuesByDevice || {}),
        [deviceKey]: {
          ...((order.qcIssuesByDevice || {})[deviceKey] || {}),
          [reason]: {
            ...(((order.qcIssuesByDevice || {})[deviceKey] || {})[reason] || {}),
            resolved: true,
          },
        },
      },
    };

    const allIssues = buildIssueList(updatedOrder);
    const unresolvedIssues = allIssues.filter((issue) => !issue.resolved);
    const hasUnresolved = unresolvedIssues.length > 0;

    updatePayload.qcAwaitingResponse = hasUnresolved;

    const deviceIssues = allIssues.filter((issue) => issue.deviceKey === deviceKey);
    const deviceHasUnresolved = deviceIssues.some((issue) => !issue.resolved);
    updatePayload[`deviceStatusByKey.${deviceKey}`] = deviceHasUnresolved
      ? 'emailed'
      : 'issue_resolved';

    if (hasUnresolved) {
      updatePayload.status = 'emailed';
    }

    const logEntries = [
      {
        type: 'status_change',
        message: 'Customer confirmed issue resolved via fix-issue page.',
      },
    ];

    await updateOrderBoth(orderId, updatePayload, {
      autoLogStatus: false,
      logEntries,
    });

    return res.json({ ok: true, orderId, unresolvedCount: unresolvedIssues.length });
  } catch (error) {
    console.error('Failed to confirm issue resolution:', error);
    return res.status(500).json({ error: 'Unable to confirm issue resolution.' });
  }
});

app.use('/terminal', express.static(path.join(__dirname, '..', 'public', 'terminal'), {
  index: 'index.html',
  fallthrough: false,
}));

const sellcellDebugFeedPath = path.join(
  __dirname,
  '..',
  'repricer-process',
  'sellcell-feed-debug.xml'
);

function prettyPrintXml(xmlText) {
  const parts = String(xmlText || '').replace(/>\s*</g, '><').split(/></);
  const lines = [];
  let indent = 0;

  parts.forEach((part, index) => {
    const prefix = index === 0 ? '' : '<';
    const suffix = index === parts.length - 1 ? '' : '>';
    const token = `${prefix}${part}${suffix}`.trim();
    if (!token) {
      return;
    }

    const isDeclaration = token.startsWith('<?') || token.startsWith('<!');
    const isClosing = /^<\//.test(token);
    const isSelfClosing = /\/>$/.test(token);
    const isOpening = /^<[^!?/][^>]*>$/.test(token);

    if (isClosing) {
      indent = Math.max(indent - 1, 0);
    }

    const pad = '  '.repeat(indent);
    lines.push(`${pad}${token}`);

    if (!isDeclaration && isOpening && !isSelfClosing && !isClosing) {
      indent += 1;
    }
  });

  return `${lines.join('\n')}\n`;
}

async function sendSellcellDebugFeed(req, res) {
  try {
    const xmlText = await fs.promises.readFile(sellcellDebugFeedPath, 'utf8');
    const prettyXml = prettyPrintXml(xmlText);
    return res
      .status(200)
      .type('application/xml')
      .send(prettyXml);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return res.status(404).json({
        ok: false,
        error: 'Debug feed file not found. Run repricer-process/run-repricer.js first.',
        path: req.originalUrl,
      });
    }
    return res.status(err?.statusCode || 500).json({
      ok: false,
      error: err?.message || 'Unable to load debug feed file.',
      path: req.originalUrl,
    });
  }
}

app.get('/repricer-process/sellcell-feed-debug.xml', sendSellcellDebugFeed);
app.get('/shc33/repricer-process/sellcell-feed-debug.xml', sendSellcellDebugFeed);


const apiBasePath = (() => {
  const raw = typeof process.env.API_BASE_PATH === 'string'
    ? process.env.API_BASE_PATH.trim()
    : '';
  if (!raw) {
    return '/server';
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return '/server';
  }
  if (raw.includes('(') || raw.includes(')') || raw.includes('*') || raw.includes(':splat') || raw.includes('/:')) {
    return '/server';
  }
  if (raw === ':' || raw === '/:') {
    return '/server';
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
