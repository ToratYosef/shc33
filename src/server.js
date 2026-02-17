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
  const deviceKey = req.query.deviceKey ? String(req.query.deviceKey).trim() : '';
  if (!orderId) {
    return res.status(400).send('Order ID is required.');
  }
  const redirectUrl = new URL(`https://api.secondhandcell.com/fix-issue/${encodeURIComponent(orderId)}`);
  if (deviceKey) {
    redirectUrl.searchParams.set('deviceKey', deviceKey);
  }
  return res.redirect(redirectUrl.toString());
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
    const requestedDeviceKey = req.query.deviceKey ? String(req.query.deviceKey).trim() : '';
    const issues = buildIssueList(order);
    const visibleIssues = requestedDeviceKey
      ? issues.filter((issue) => issue.deviceKey === requestedDeviceKey)
      : issues;
    const safeOrderId = escapeHtml(orderId);
    const confirmUrl = `/fix-issue/${encodeURIComponent(orderId)}/confirm`;

    const getDeviceLabel = (deviceKey) => {
      if (!deviceKey) return 'Device';
      const parts = String(deviceKey).split('::');
      const idx = Number(parts[1]);
      const deviceNumber = Number.isFinite(idx) ? idx + 1 : 1;
      const items = Array.isArray(order.items) ? order.items : [];
      const item = Number.isFinite(idx) ? items[idx] : null;
      const model = item?.deviceName || item?.model || order?.device || order?.deviceName || '';
      const storage = item?.storage || item?.capacity || order?.storage || '';
      const modelLabel = [model, storage].filter(Boolean).join(' ').trim();
      return modelLabel ? `Device ${deviceNumber}: ${modelLabel}` : `Device ${deviceNumber}`;
    };

    const focusedDeviceLabel = requestedDeviceKey ? getDeviceLabel(requestedDeviceKey) : '';
    const safeFocusedDeviceLabel = focusedDeviceLabel ? escapeHtml(focusedDeviceLabel) : '';
    const safeFocusedDeviceKey = requestedDeviceKey ? escapeHtml(requestedDeviceKey) : '';

    const issuesHtml = visibleIssues.length
      ? visibleIssues
          .map((issue, index) => {
            const copy = ISSUE_COPY[issue.reason] || {
              title: toTitleCase(issue.reason),
              detail: 'Please resolve this issue so we can continue processing.',
            };
            const safeDeviceKey = escapeHtml(issue.deviceKey);
            const safeDeviceLabel = escapeHtml(getDeviceLabel(issue.deviceKey));
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
                <div class="issue-meta">Device: ${safeDeviceLabel}</div>
                ${safeNotes}
                ${buttonHtml}
                <div class="issue-feedback" aria-live="polite"></div>
              </div>
            `;
          })
          .join('')
      : '<p>No outstanding issues were found for this device/order.</p>';

    res.status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Issue Resolution - SecondHandCell</title>
    <style>
      :root {
        --site-indigo: #4f46e5;
        --site-indigo-dark: #4338ca;
        --site-green: #16a34a;
        --site-navy: #0f172a;
        color-scheme: light;
      }

      /* Utility */
      .hidden {
        display: none !important;
      }

      /* ================================
         HEADER
      ================================ */

      .site-header {
        position: sticky;
        top: 0;
        z-index: 1000;
        width: 100%;
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(14px);
        box-shadow: 0 10px 30px -20px rgba(15, 23, 42, 0.6);
        border-bottom: 1px solid rgba(226, 232, 240, 0.7);
      }

      .site-header__inner {
        max-width: 1200px;
        margin: 0 auto;
        padding: 0.65rem 1.1rem;
        display: flex;
        align-items: center;
        gap: 0.85rem;
        justify-content: space-between;
      }

      /* Logo Left */
      .logo-container-left {
        flex: 1;
        display: flex;
        align-items: center;
      }

      .logo-link {
        display: inline-flex;
        align-items: center;
        height: 2.75rem;
      }

      .logo-image {
        height: 150%;
        max-height: 4rem;
        width: auto;
      }

      /* Center Wordmark */
      .logo-text-container-center {
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.1rem;
      }

      .logo-wordmark {
        font-weight: 500;
        font-size: clamp(1.35rem, 3vw, 2.25rem);
        letter-spacing: -0.02em;
        white-space: nowrap;
      }

      .logo-wordmark__primary {
        color: #111827;
      }

      .logo-wordmark__accent {
        color: var(--site-green);
      }

      .logo-tagline {
        font-size: clamp(0.65rem, 1.2vw, 0.95rem);
        color: var(--site-green);
        margin: 0;
        white-space: nowrap;
      }

      .logo-tagline span {
        color: var(--site-navy);
        font-weight: 500;
      }

      /* Right Auth */
      .header-auth-nav {
        flex: 1;
        display: flex;
        justify-content: flex-end;
        align-items: center;
      }

      .site-header__auth-wrapper {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        position: relative;
      }

      .site-header__login {
        font-weight: 600;
        background: var(--site-indigo);
        color: #fff;
        padding: 0.55rem 1.15rem;
        border-radius: 999px;
        transition: background 0.2s ease;
        text-decoration: none;
      }

      .site-header__login:hover {
        background: var(--site-indigo-dark);
      }

      /* User circle */
      .user-monogram {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2.5rem;
        height: 2.5rem;
        border-radius: 999px;
        background: #dbeafe;
        color: #1d4ed8;
        font-weight: 600;
        cursor: pointer;
      }

      /* Dropdown */
      .auth-dropdown {
        position: absolute;
        right: 0;
        top: calc(100% + 0.35rem);
        min-width: 12rem;
        background: #fff;
        border-radius: 0.75rem;
        box-shadow: 0 20px 30px -24px rgba(15, 23, 42, 0.8);
        padding: 0.35rem 0;
        display: none;
        flex-direction: column;
        z-index: 10000;
      }

      .auth-dropdown.is-visible {
        display: flex;
      }

      .auth-dropdown a,
      .auth-dropdown button {
        padding: 0.65rem 1rem;
        text-align: left;
        font-weight: 600;
        background: transparent;
        border: none;
        color: #1f2937;
        cursor: pointer;
        text-decoration: none;
      }

      .auth-dropdown a:hover,
      .auth-dropdown button:hover {
        background: rgba(79, 70, 229, 0.08);
      }

      .btn-red-logout {
        color: #dc2626;
      }

      .btn-red-logout:hover {
        background-color: #fef2f2;
      }

      /* ================================
         BODY & MAIN CONTENT
      ================================ */
      /* ================================
         BODY & MAIN CONTENT
      ================================ */
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: #0f172a;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
      }
      .relative {
        position: relative;
      }
      .inline-flex {
        display: inline-flex;
      }
      .flex-col {
        flex-direction: column;
      }
      .items-center {
        align-items: center;
      }
      .no-underline {
        text-decoration: none;
      }
      .main-content {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 40px 24px;
      }
      .card {
        max-width: 600px;
        width: 100%;
        background: #ffffff;
        border-radius: 20px;
        box-shadow: 0 25px 60px rgba(0, 0, 0, 0.2);
        padding: 40px;
        text-align: center;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 28px;
        color: #1e293b;
        font-weight: 700;
      }
      .subtitle {
        margin: 0 0 24px;
        color: #64748b;
        font-size: 16px;
        line-height: 1.6;
      }
      .order {
        margin: 20px 0;
        font-weight: 600;
        font-size: 18px;
        color: #0f172a;
        padding: 12px 20px;
        background: #f1f5f9;
        border-radius: 10px;
        display: inline-block;
      }
      .issues {
        margin-top: 30px;
        display: grid;
        gap: 18px;
      }
      .issue-card {
        border: 2px solid #e2e8f0;
        border-radius: 16px;
        padding: 20px;
        background: linear-gradient(to bottom, #ffffff, #f8fafc);
        transition: all 0.3s ease;
      }
      .issue-card:hover {
        border-color: #cbd5e1;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      }
      .issue-header {
        display: flex;
        gap: 12px;
        justify-content: space-between;
        align-items: flex-start;
      }
      .issue-title {
        font-weight: 700;
        font-size: 17px;
        color: #1e293b;
        text-align: left;
      }
      .issue-detail {
        font-size: 14px;
        color: #64748b;
        margin-top: 6px;
        text-align: left;
      }
      .issue-status {
        font-size: 11px;
        font-weight: 700;
        padding: 6px 12px;
        border-radius: 9999px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        white-space: nowrap;
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
        margin-top: 12px;
        font-size: 13px;
        color: #64748b;
        text-align: left;
      }
      .issue-notes {
        margin: 12px 0 0;
        font-size: 14px;
        color: #334155;
        background: #ffffff;
        border-radius: 10px;
        padding: 12px 14px;
        border: 1px solid #e2e8f0;
        text-align: left;
      }
      .issue-button {
        margin-top: 16px;
        background: linear-gradient(135deg, #10b981, #059669);
        color: #ffffff;
        border: none;
        border-radius: 9999px;
        padding: 14px 36px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 10px 25px rgba(16, 185, 129, 0.3);
        transition: all 0.2s ease;
      }
      .issue-button:hover:not([disabled]) {
        transform: translateY(-2px);
        box-shadow: 0 14px 30px rgba(16, 185, 129, 0.4);
      }
      .issue-button[disabled] {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .issue-feedback {
        margin-top: 12px;
        font-size: 14px;
        font-weight: 500;
      }

      /* ================================
         LOGIN MODAL
      ================================ */
      .shc-auth-modal {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.55);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 18px;
        z-index: 2000;
        overflow-y: auto;
      }

      .shc-auth-modal.is-visible { display: flex; }

      .shc-auth-card {
        width: min(520px, 100%);
        background: #fff;
        border-radius: 20px;
        box-shadow: 0 30px 80px -40px rgba(15,23,42,0.6);
        padding: 28px;
        position: relative;
      }

      .shc-auth-close {
        position: absolute;
        top: 12px;
        right: 12px;
        background: transparent;
        border: none;
        color: #94a3b8;
        font-size: 22px;
        cursor: pointer;
      }

      .shc-auth-tabs {
        display: grid;
        grid-template-columns: repeat(2, minmax(0,1fr));
        gap: 8px;
        margin: 16px 0 12px;
      }

      .shc-auth-tab {
        padding: 12px;
        border-radius: 12px;
        border: 1px solid #e2e8f0;
        background: #f8fafc;
        font-weight: 700;
        color: #475569;
        cursor: pointer;
      }

      .shc-auth-tab.is-active {
        border-color: #5b21b6;
        color: #111827;
        box-shadow: 0 5px 18px -12px rgba(91,33,182,0.6);
      }

      .shc-auth-field {
        width: 100%;
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid #cbd5e1;
        margin-bottom: 12px;
        font-size: 15px;
      }

      .shc-auth-primary {
        width: 100%;
        padding: 13px 16px;
        border-radius: 14px;
        border: none;
        background: linear-gradient(120deg,#5b21b6,#2563eb);
        color: #fff;
        font-weight: 800;
        cursor: pointer;
        box-shadow: 0 20px 40px -28px rgba(37,99,235,0.9);
      }

      .shc-auth-google {
        width: 100%;
        padding: 12px 16px;
        border-radius: 14px;
        border: 1px solid #e2e8f0;
        background: #fff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        font-weight: 700;
        color: #0f172a;
        cursor: pointer;
      }

      .shc-auth-or {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 14px 0;
        color: #94a3b8;
        font-size: 14px;
      }

      .shc-auth-or::before,
      .shc-auth-or::after {
        content: "";
        flex: 1;
        height: 1px;
        background: #e2e8f0;
      }

      .shc-auth-meta {
        text-align: center;
        font-size: 14px;
        color: #475569;
        margin-top: 10px;
      }

      .shc-auth-link {
        color: #2563eb;
        font-weight: 700;
        text-decoration: none;
      }

      .shc-auth-link:hover { text-decoration: underline; }

      .shc-auth-message {
        display: none;
        margin-top: 8px;
        padding: 10px 12px;
        border-radius: 12px;
        font-weight: 600;
        font-size: 14px;
      }

      .shc-auth-message.is-visible { display: block; }

      .shc-auth-message.is-error {
        background: #fef2f2;
        color: #b91c1c;
        border: 1px solid #fecdd3;
      }

      .shc-auth-message.is-success {
        background: #ecfdf3;
        color: #15803d;
        border: 1px solid #bbf7d0;
      }

      .shc-auth-google img { width: 18px; height: 18px; }

      .shc-auth-header { text-align: center; }

      .shc-auth-title {
        font-size: 24px;
        font-weight: 800;
        color: #0f172a;
        margin: 0;
      }

      .shc-auth-subtitle {
        margin: 6px 0 0;
        color: #475569;
        font-weight: 500;
      }

      .shc-auth-form { display: none; }
      .shc-auth-form.is-visible { display: block; }

      .shc-monogram {
        cursor: pointer !important;
        user-select: none;
        -webkit-user-select: none;
        pointer-events: auto !important;
      }

      .shc-auth-dropdown {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        background: #fff;
        border: 1px solid #e2e8f0;
        border-radius: 14px;
        box-shadow: 0 30px 80px -48px rgba(15,23,42,0.55);
        padding: 10px;
        min-width: 180px;
        display: none;
        z-index: 10000;
      }

      .shc-auth-dropdown.is-visible { display: block; }

      .shc-auth-dropdown a,
      .shc-auth-dropdown button {
        width: 100%;
        display: block;
        text-align: left;
        padding: 10px 12px;
        border-radius: 10px;
        color: #0f172a;
        font-weight: 600;
        border: none;
        background: transparent;
        cursor: pointer;
      }

      .shc-auth-dropdown a:hover,
      .shc-auth-dropdown button:hover {
        background: #f1f5f9;
      }
    </style>
  </head>
  <body>
    <header class="site-header site-header--mobile-compact relative" data-site-header>
      <div class="site-header__inner site-header__inner--centered">
        <div class="logo-container-left">
          <a href="https://secondhandcell.com" class="logo-link" aria-label="SecondHandCell home">
            <img
              src="https://secondhandcell.com/assets/logo.webp"
              alt="SecondHandCell Logo"
              class="logo-image"
              width="320"
              height="320"
              onerror="this.onerror=null;this.src='https://placehold.co/200x64/ffffff/1e293b?text=SecondHandCell';"
            >
          </a>
        </div>

        <div class="logo-text-container-center">
          <a href="https://secondhandcell.com" aria-label="Go to homepage" class="inline-flex flex-col items-center no-underline">
            <div class="logo-wordmark">
              <span class="logo-wordmark__primary">Second</span><span class="logo-wordmark__accent">HandCell</span>
            </div>
            <p class="logo-tagline">Turn Your Old <span>Phone Into Cash!</span></p>
          </a>
        </div>

        <nav class="header-auth-nav" aria-label="Account navigation">
          <div id="authStatusContainer" class="site-header__auth-wrapper">
            <a href="#" id="loginNavBtn" class="site-header__login">Login/Sign Up</a>
            <div id="userMonogram" class="user-monogram hidden"></div>
            <div id="authDropdown" class="auth-dropdown hidden">
              <a href="https://secondhandcell.com/my-account.html" class="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-100">My Account</a>
              <a href="https://secondhandcell.com/track-order.html" class="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-100">Track an Order</a>
              <button id="logoutBtn" class="btn-red-logout">Sign Out</button>
            </div>
          </div>
        </nav>
      </div>
    </header>
    
    <main class="main-content">
      <div class="card">
        <h1>Issue Resolution</h1>
        <p class="subtitle">Please resolve each issue below. We'll continue processing your order once everything is cleared.</p>
        <div class="order">Order #${safeOrderId}</div>
        ${safeFocusedDeviceLabel ? `<div class="order" style="margin-top:12px; font-size:16px; background:#e0f2fe; color:#0369a1;">Device: ${safeFocusedDeviceLabel}</div>` : ''}
        <div class="issues">${issuesHtml}</div>
      </div>
    </main>
    
    <footer class="bg-slate-800 text-white">
      <div class="container mx-auto px-4 py-12">
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div class="lg:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-8">
            <div>
              <h3 class="text-xl font-bold mb-4">SecondHandCell</h3>
              <p class="text-slate-400">Your trusted partner for selling used tech. Quick quotes, fair prices, and hassle-free service.</p>
            </div>

            <div>
              <h3 class="text-xl font-bold mb-4">Quick Links</h3>
              <ul class="space-y-2">
                <li><a href="https://secondhandcell.com/index.html" class="text-slate-400 hover:text-white transition duration-300">Home</a></li>
                <li><a href="https://secondhandcell.com/about.html" class="text-slate-400 hover:text-white transition duration-300">About Us</a></li>
                <li><a href="https://secondhandcell.com/privacy.html" class="text-slate-400 hover:text-white transition duration-300">Privacy Policy</a></li>
                <li><a href="https://secondhandcell.com/terms.html" class="text-slate-400 hover:text-white transition duration-300">Terms &amp; Conditions</a></li>
              </ul>
            </div>

            <div>
              <h3 class="text-xl font-bold mb-4">Contact Us</h3>
              <p class="text-slate-400">Email: support@secondhandcell.com</p>
            </div>
          </div>

          <div class="bg-slate-700 p-6 rounded-lg">
            <h3 class="text-xl font-bold mb-2 text-white">Stay Updated</h3>
            <p class="text-slate-300 mb-4">Sign up for updates, price increases, and more!</p>
            <form id="footerEmailSignupForm" class="flex flex-col sm:flex-row gap-2">
              <input
                type="email"
                id="footerEmail"
                placeholder="Enter your email"
                class="w-full flex-grow border border-slate-400 bg-slate-800 text-white p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              >
              <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-blue-700">Sign Up</button>
            </form>
            <div id="footerSignupMessage" class="mt-3 text-sm text-center"></div>
          </div>
        </div>

        <div class="bg-slate-800 text-white p-6 rounded-xl shadow-lg mt-8 text-center border-2 border-red-600">
          <p class="text-lg font-bold">IMPORTANT NOTICE</p>
          <p class="mt-2 text-sm md:text-base">We do not purchase blacklisted or lost/stolen devices. All devices are verified through a legal compliance check.</p>
        </div>

        <div class="mt-8">
          <div class="flex flex-wrap items-center justify-center gap-6 sm:flex-row sm:justify-center sm:gap-8 lg:justify-start">
            <a href="https://www.sellcell.com/" target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center">
              <img
                src="https://secondhandcell.com/assets/sellcell.webp"
                width="150"
                height="107"
                alt="SellCell Accredited Buyer"
                loading="lazy"
                class="h-20 w-auto object-contain"
              >
            </a>

            <a href="https://www.trustpilot.com/evaluate/secondhandcell.com" target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center">
              <img
                src="https://secondhandcell.com/assets/stars-4.svg"
                alt="Trustpilot 5 star rating"
                loading="lazy"
                class="h-12 w-auto object-contain"
              >
            </a>
          </div>
        </div>

        <div class="border-t border-slate-700 mt-8 pt-6 text-center text-slate-400 text-sm">
          <p>&copy; 2026 SecondHandCell. All rights reserved.</p>
        </div>
      </div>
    </footer>
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

    <!-- Login Modal -->
    <div id="loginModal" class="shc-auth-modal" style="display:none">
      <div class="shc-auth-card" role="dialog" aria-modal="true" aria-labelledby="shc-auth-title">
        <button class="shc-auth-close" type="button" aria-label="Close authentication modal">&times;</button>

        <div class="shc-auth-header">
          <p class="shc-auth-title" id="shc-auth-title">Your SecondHandCell Account</p>
          <p class="shc-auth-subtitle">Sign in or create an account to keep your quote in sync.</p>
        </div>

        <div class="shc-auth-tabs" role="tablist">
          <button class="shc-auth-tab is-active" id="loginTabBtn" type="button" data-tab="login">Login</button>
          <button class="shc-auth-tab" id="signupTabBtn" type="button" data-tab="signup">Sign Up</button>
        </div>

        <div id="authMessage" class="shc-auth-message" role="alert"></div>

        <form id="loginForm" class="shc-auth-form is-visible" novalidate>
          <button type="button" id="googleLoginBtn" class="shc-auth-google">
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google icon" />
            Login with Google
          </button>

          <div class="shc-auth-or"><span>or</span></div>

          <input type="email" id="loginEmail" class="shc-auth-field" placeholder="Email address" autocomplete="email" required />
          <input type="password" id="loginPassword" class="shc-auth-field" placeholder="Password" autocomplete="current-password" required />

          <button type="submit" class="shc-auth-primary">Login</button>

          <p class="shc-auth-meta">
            Forgot your password? <a href="#" id="forgotPasswordLink" class="shc-auth-link">Reset it</a>
          </p>
        </form>

        <form id="signupForm" class="shc-auth-form" novalidate>
          <button type="button" id="googleSignupBtn" class="shc-auth-google">
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google icon" />
            Sign up with Google
          </button>

          <div class="shc-auth-or"><span>or</span></div>

          <input type="text" id="signupName" class="shc-auth-field" placeholder="Full name" autocomplete="name" required />
          <input type="email" id="signupEmail" class="shc-auth-field" placeholder="Email address" autocomplete="email" required />
          <input type="password" id="signupPassword" class="shc-auth-field" placeholder="Password (min 6 characters)" autocomplete="new-password" required />

          <button type="submit" class="shc-auth-primary">Create Account</button>

          <p class="shc-auth-meta">
            Already have an account? <a href="#" id="switchToLogin" class="shc-auth-link">Login</a>
          </p>
        </form>
      </div>
    </div>

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
const publicPrefixPaths = ['/wholesale'];

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
