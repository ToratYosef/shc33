const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');
const cors = require('cors');

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

const repricerScriptPath = path.resolve(__dirname, '..', 'repricer-process', 'run-repricer.js');
const repricerOutputCsvPath = '/shc33/feed/repricer-output.csv';

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function parseRepricerCsvPreview(csvText, limit = 200) {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (!lines.length) {
    return [];
  }

  const header = parseCsvLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length && rows.length < limit; i += 1) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j += 1) {
      row[header[j]] = values[j] ?? '';
    }
    rows.push(row);
  }

  return rows;
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
  fmi_active: {
    title: 'iCloud / FMI ON',
    problem: 'Find My iPhone (FMI) is still enabled. The device is locked to your Apple ID.',
    why: 'We cannot use or resell the device while it is linked to your Apple ID.',
    fixOptions: [
      {
        title: 'Option 1 – Remove Using iCloud (Most Common)',
        prerequisite: 'If You Still Have Access to Apple ID',
        steps: [
          'Go to: https://www.icloud.com',
          'Sign in with your Apple ID.',
          'Click "Find iPhone"',
          'Click "All Devices"',
          'Select the affected device.',
          'Click "Remove from Account"',
          'Confirm removal.',
          'Important: If it says "Erase iPhone" first, click that, wait for it to complete, THEN click Remove from Account.'
        ]
      },
      {
        title: 'Option 2 – From Another Apple Device',
        steps: [
          'Open Settings',
          'Tap your name (Apple ID at top)',
          'Scroll down to the device list',
          'Tap the device',
          'Tap "Remove from Account"'
        ]
      },
      {
        title: 'If You Don\'t Have Access to the Account',
        note: 'You must either recover your Apple ID at https://iforgot.apple.com OR provide the original purchase receipt so Apple can unlock it'
      }
    ],
    afterComplete: 'Once complete, press the button below to mark as resolved. We will verify and update: Status: ✅ Received & Cleared'
  },

  password_locked: {
    title: 'Screen Lock / Passcode Lock',
    problem: 'The device is locked with a passcode.',
    why: 'We need access to the device to verify its condition and complete processing.',
    fixOptions: [
      {
        title: 'If You Remember the PIN',
        steps: [
          'Option A: Reply securely with the device passcode so we can complete processing.',
          'Option B: Remove the passcode via iCloud (follow the FMI removal steps above)'
        ]
      },
      {
        title: 'If You Don\'t Have the Device',
        steps: [
          'Remove it from your account using iCloud (Apple) or Google Device Activity (Android)',
          'Note: If we cannot access the device, the offer may need to be adjusted.'
        ]
      }
    ],
    afterComplete: 'Once complete, press the button below to mark as resolved. Status: ✅ Received & Accessible'
  },

  stolen: {
    title: 'Blacklisted / Carrier Blocked',
    problem: 'The device is reported lost, stolen, or has an unpaid balance.',
    why: 'Blacklisted devices cannot be used or resold on carrier networks.',
    commonReasons: [
      'Insurance claim filed',
      'Phone reported lost',
      'Unpaid carrier bill',
      'Device still under financing'
    ],
    fixOptions: [
      {
        title: 'If Reported Lost/Stolen',
        steps: [
          'Call your carrier and request: "Please remove the blacklist from this IMEI"',
          'Carriers:',
          '  • Verizon: 800-922-0204',
          '  • AT&T: 800-331-0500',
          '  • T-Mobile: 877-746-0909'
        ]
      },
      {
        title: 'If Balance Due (BAL DUE)',
        steps: [
          'Pay off remaining device balance',
          'Request carrier to unlock and clear IMEI',
          'Ask them to confirm: "IMEI is clean and fully paid"'
        ]
      }
    ],
    afterComplete: 'Once complete, press the button below to mark as resolved. Status: ✅ Received & Clean'
  },

  outstanding_balance: {
    title: 'Blacklisted / Carrier Blocked - Outstanding Balance',
    problem: 'The device has an unpaid balance with the carrier.',
    why: 'Unpaid balances prevent the device from being used on any carrier network.',
    fixOptions: [
      {
        title: 'How To Clear',
        steps: [
          'Contact your carrier directly',
          'Check the remaining device balance',
          'Pay off any outstanding payments or device financing',
          'Request confirmation once paid in full and IMEI is cleared',
          'Ask them to confirm: "IMEI is clean and fully paid"'
        ]
      }
    ],
    afterComplete: 'Once complete, press the button below to mark as resolved. Status: ✅ Received & Paid'
  },

  google_frp_active: {
    title: 'Google Lock (FRP ON)',
    problem: 'Google account is still signed in. Factory Reset Protection (FRP) is active.',
    why: 'We cannot use or resell the device while FRP is active and linked to your Google account.',
    fixOptions: [
      {
        title: 'Option 1 – Remove Device From Google Account',
        prerequisite: 'If You Have Access to Your Google Account',
        steps: [
          'Go to: https://myaccount.google.com/device-activity',
          'Sign into your Google account.',
          'Find the affected device.',
          'Click "Sign Out"',
          'Confirm removal.'
        ]
      },
      {
        title: 'Option 2 – Direct Device Removal',
        prerequisite: 'If You Still Have the Device',
        steps: [
          'Go to: Settings → Accounts → Remove Google Account',
          'Follow device prompts to complete removal'
        ]
      },
      {
        title: 'If You Forgot the Google Account',
        note: 'Recover it here: https://accounts.google.com/signin/recovery'
      }
    ],
    afterComplete: 'Once complete, press the button below to mark as resolved. We will verify and update: Status: ✅ Received & Cleared'
  }
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

    const getDeviceInfo = (deviceKey) => {
      if (!deviceKey) return { number: 1, model: 'Device', storage: '' };
      const parts = String(deviceKey).split('::');
      const idx = Number(parts[1]);
      const deviceNumber = Number.isFinite(idx) ? idx + 1 : 1;
      const items = Array.isArray(order.items) ? order.items : [];
      const item = Number.isFinite(idx) ? items[idx] : null;
      const model = item?.deviceName || item?.model || order?.device || order?.deviceName || 'Device';
      const storage = item?.storage || item?.capacity || order?.storage || '';
      return { number: deviceNumber, model, storage };
    };

    // Group issues by device
    const issuesByDevice = {};
    visibleIssues.forEach(issue => {
      if (!issuesByDevice[issue.deviceKey]) {
        issuesByDevice[issue.deviceKey] = [];
      }
      issuesByDevice[issue.deviceKey].push(issue);
    });

    const allIssueCards = [];
    
    Object.keys(issuesByDevice).forEach(deviceKey => {
      const deviceInfo = getDeviceInfo(deviceKey);
      const deviceIssues = issuesByDevice[deviceKey];
      
      deviceIssues.forEach((issue, index) => {
            const copy = ISSUE_COPY[issue.reason] || {
              title: toTitleCase(issue.reason),
              problem: 'Please resolve this issue so we can continue processing.'
            };
            const safeDeviceKey = escapeHtml(issue.deviceKey);
            const safeReason = escapeHtml(issue.reason);
            const safeNotes = issue.notes ? `<div class="issue-notes">📌 Note: ${escapeHtml(issue.notes)}</div>` : '';
            const statusBadge = issue.resolved ? 'resolved' : 'pending';
            const statusLabel = issue.resolved ? 'Resolved' : 'Needs Action';
            
            // Build fix instructions HTML from new comprehensive format
            let fixInstructionsHtml = '';
            if (copy.problem || copy.why || copy.fixOptions) {
              fixInstructionsHtml = '<div class="fix-instructions">';
              
              // Problem section
              if (copy.problem) {
                fixInstructionsHtml += `
                  <div class="fix-section">
                    <div class="fix-section-title">📋 Problem:</div>
                    <p class="fix-section-content">${escapeHtml(copy.problem)}</p>
                  </div>
                `;
              }
              
              // Why it matters section
              if (copy.why) {
                fixInstructionsHtml += `
                  <div class="fix-section">
                    <div class="fix-section-title">❓ Why This Matters:</div>
                    <p class="fix-section-content">${escapeHtml(copy.why)}</p>
                  </div>
                `;
              }
              
              // Common reasons (for stolen/blacklist)
              if (copy.commonReasons && Array.isArray(copy.commonReasons)) {
                fixInstructionsHtml += `
                  <div class="fix-section">
                    <div class="fix-section-title">⚠️ Common Reasons:</div>
                    <ul class="fix-reasons-list">
                      ${copy.commonReasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}
                    </ul>
                  </div>
                `;
              }
              
              // Fix options
              if (copy.fixOptions && Array.isArray(copy.fixOptions)) {
                fixInstructionsHtml += '<div class="fix-options-container">';
                copy.fixOptions.forEach((option, optIdx) => {
                  fixInstructionsHtml += '<div class="fix-option">';
                  
                  if (option.title) {
                    fixInstructionsHtml += `<div class="fix-option-title">✅ ${escapeHtml(option.title)}</div>`;
                  }
                  
                  if (option.prerequisite) {
                    fixInstructionsHtml += `<div class="fix-prerequisite">${escapeHtml(option.prerequisite)}</div>`;
                  }
                  
                  if (option.steps && Array.isArray(option.steps)) {
                    fixInstructionsHtml += '<ol class="fix-steps">';
                    option.steps.forEach(step => {
                      fixInstructionsHtml += `<li>${escapeHtml(step)}</li>`;
                    });
                    fixInstructionsHtml += '</ol>';
                  }
                  
                  if (option.note) {
                    fixInstructionsHtml += `<div class="fix-note">📌 ${escapeHtml(option.note)}</div>`;
                  }
                  
                  fixInstructionsHtml += '</div>';
                });
                fixInstructionsHtml += '</div>';
              }
              
              // After complete section
              if (copy.afterComplete) {
                fixInstructionsHtml += `
                  <div class="fix-section after-complete">
                    <div class="fix-section-title">📍 After You Complete This:</div>
                    <p class="fix-section-content">${escapeHtml(copy.afterComplete)}</p>
                  </div>
                `;
              }
              
              fixInstructionsHtml += '</div>';
            }

            const buttonsHtml = issue.resolved
              ? '<div class="issue-actions"><button class="issue-button primary" disabled>✓ Resolved</button></div>'
              : `
                <div class="issue-actions">
                  <button class="issue-button primary" data-device-key="${safeDeviceKey}" data-reason="${safeReason}" data-action="resolve">
                    ✓ Mark as Resolved
                  </button>
                  <button class="issue-button secondary" data-device-key="${safeDeviceKey}" data-reason="${safeReason}" data-action="received">
                    📦 Mark as Received
                  </button>
                </div>
              `;

        allIssueCards.push(`
          <div class="issue-column ${issue.resolved ? 'resolved' : ''}" data-issue-index="${index}">
            <div class="issue-column-header">
              <div class="device-badge">
                <span class="device-icon-small">📱</span>
                <span class="device-label">${escapeHtml(deviceInfo.model)}</span>
              </div>
              <span class="issue-badge ${statusBadge}">${statusLabel}</span>
            </div>
            <div class="issue-column-content">
              <div class="issue-title">
                <span>${escapeHtml(copy.title)}</span>
              </div>
              ${safeNotes}
              ${fixInstructionsHtml}
              <div class="issue-feedback" aria-live="polite"></div>
            </div>
            ${buttonsHtml}
          </div>
        `);
      });
    });
    
    const deviceCardsHtml = allIssueCards.length > 0
      ? `<div class="issues-grid">${allIssueCards.join('')}</div>`
      : '<div class="empty-state"><div class="empty-state-icon">✓</div><h3>All Clear!</h3><p>No outstanding issues were found for this order.</p></div>';

    const hasIssues = visibleIssues.length > 0;
    const orderStatusClass = hasIssues ? '' : 'completed';
    const orderStatusLabel = hasIssues ? 'Needs Attention' : 'All Clear';

    res.status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Issue Resolution - SecondHandCell</title>
    <script src="https://cdn.tailwindcss.com"></script>
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
        background: linear-gradient(to bottom, #f1f5f9 0%, #e2e8f0 100%);
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
        padding: 24px 16px;
        max-width: 1400px;
        width: 100%;
        margin: 0 auto;
      }
      .page-header {
        text-align: center;
        margin-bottom: 24px;
      }
      .page-title {
        margin: 0 0 12px;
        font-size: 32px;
        color: #1e293b;
        font-weight: 700;
      }
      .page-subtitle {
        margin: 0;
        color: #64748b;
        font-size: 18px;
        line-height: 1.6;
      }
      .order-card {
        background: #ffffff;
        border-radius: 16px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
        padding: 16px;
        margin-bottom: 16px;
        border: 1px solid #e2e8f0;
      }
      .order-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
        padding-bottom: 12px;
        border-bottom: 2px solid #e2e8f0;
      }
      .order-id {
        font-size: 24px;
        font-weight: 700;
        color: #1e293b;
      }
      .order-status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        border-radius: 9999px;
        font-weight: 600;
        font-size: 14px;
        background: #fef3c7;
        color: #92400e;
      }
      .order-status.completed {
        background: #dcfce7;
        color: #166534;
      }
      .issues-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(450px, 1fr));
        gap: 16px;
        margin-top: 16px;
      }
      .issue-column {
        background: white;
        border-radius: 12px;
        border: 1px solid #e2e8f0;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        transition: all 0.3s ease;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        max-height: calc(100vh - 240px);
        height: 100%;
      }
      .issue-column:hover {
        border-color: #cbd5e1;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
        transform: translateY(-2px);
      }
      .issue-column.resolved {
        opacity: 0.75;
        background: #f0fdf4;
      }
      .issue-column-header {
        background: linear-gradient(135deg, #f8fafc, #f1f5f9);
        border-bottom: 2px solid #e2e8f0;
        padding: 8px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      .device-badge {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        background: #eff6ff;
        border-radius: 6px;
        border: 1px solid #bfdbfe;
      }
      .device-icon-small {
        font-size: 16px;
      }
      .device-label {
        font-size: 12px;
        font-weight: 600;
        color: #0369a1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .issue-column-content {
        padding: 8px;
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        overflow-x: hidden;
        min-height: 0;
      }
      .device-icon {
        width: 48px;
        height: 48px;
        background: linear-gradient(135deg, #3b82f6, #1d4ed8);
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-size: 24px;
        flex-shrink: 0;
      }
      .device-info {
        flex: 1;
      }
      .device-name {
        font-size: 18px;
        font-weight: 700;
        color: #1e293b;
        margin: 0 0 4px;
      }
      .device-storage {
        font-size: 14px;
        color: #64748b;
        margin: 0;
      }
      .issues-section {
        margin-top: 16px;
      }
      .issue-card {
        background: white;
        border-radius: 10px;
        padding: 16px;
        margin-bottom: 12px;
        border-left: 4px solid #ef4444;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
      }
      .issue-card.resolved {
        border-left-color: #10b981;
        opacity: 0.7;
      }
      .issue-title {
        font-weight: 700;
        font-size: 14px;
        color: #1e293b;
        margin: 0 0 6px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        word-break: break-word;
      }
      .issue-badge {
        font-size: 10px;
        font-weight: 700;
        padding: 4px 10px;
        border-radius: 9999px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        white-space: nowrap;
      }
      .issue-badge.pending {
        background: #fef3c7;
        color: #92400e;
      }
      .issue-badge.resolved {
        background: #dcfce7;
        color: #166534;
      }
      .issue-detail {
        font-size: 14px;
        color: #64748b;
        margin: 0 0 12px;
        line-height: 1.5;
      }
      .fix-instructions {
        background: #eff6ff;
        border-left: 3px solid #3b82f6;
        padding: 8px 10px;
        border-radius: 6px;
        margin: 6px 0;
        font-size: 12px;
      }
      .fix-instructions-title {
        font-weight: 700;
        font-size: 13px;
        color: #1e40af;
        margin: 0 0 8px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .fix-instructions-list {
        margin: 0;
        padding-left: 20px;
        font-size: 13px;
        color: #334155;
      }
      .fix-instructions-list li {
        margin-bottom: 4px;
      }
      .fix-section {
        margin-bottom: 6px;
      }
      .fix-section-title {
        font-weight: 700;
        font-size: 12px;
        color: #1e40af;
        margin: 0 0 6px;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .fix-section-content {
        font-size: 12px;
        color: #334155;
        margin: 0;
        line-height: 1.4;
      }
      .fix-reasons-list {
        margin: 0;
        padding-left: 20px;
        font-size: 13px;
        color: #334155;
      }
      .fix-reasons-list li {
        margin-bottom: 6px;
      }
      .fix-options-container {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 8px;
      }
      .fix-option {
        background: #f0f9ff;
        border: 1px solid #bfdbfe;
        border-radius: 4px;
        padding: 8px;
        font-size: 12px;
      }
      .fix-option-title {
        font-weight: 700;
        font-size: 11px;
        color: #0369a1;
        margin-bottom: 6px;
      }
      .fix-prerequisite {
        font-size: 11px;
        color: #0c4a6e;
        font-style: italic;
        margin-bottom: 6px;
        padding: 4px 6px;
        background: #e0f2fe;
        border-radius: 3px;
      }
      .fix-steps {
        margin: 6px 0;
        padding-left: 18px;
        font-size: 11px;
        color: #334155;
      }
      .fix-steps li {
        margin-bottom: 4px;
        line-height: 1.3;
      }
      .fix-note {
        font-size: 12px;
        color: #7c3aed;
        margin-top: 8px;
        padding: 6px 8px;
        background: #f5f3ff;
        border-radius: 4px;
        border-left: 2px solid #7c3aed;
      }
      .after-complete {
        background: #f0fdd4;
        border-left: 3px solid #16a34a;
        margin-top: 16px;
        padding: 12px;
        border-radius: 6px;
      }
      .after-complete .fix-section-title {
        color: #166534;
      }
      .after-complete .fix-section-content {
        color: #166534;
      }
      .issue-meta {
        margin-top: 12px;
        font-size: 13px;
        color: #64748b;
      }
      .issue-actions {
        display: flex;
        gap: 6px;
        padding: 8px;
        flex-shrink: 0;
        border-top: 1px solid #e2e8f0;
      }
      .issue-button {
        flex: 1;
        padding: 8px 10px;
        border-radius: 8px;
        border: none;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        font-size: 13px;
        min-height: 36px;
      }
      .issue-button.primary {
        background: linear-gradient(135deg, #10b981, #059669);
        color: white;
        box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
      }
      .issue-button.primary:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: 0 6px 16px rgba(16, 185, 129, 0.4);
      }
      .issue-button.secondary {
        background: #f1f5f9;
        color: #475569;
        border: 1px solid #cbd5e1;
      }
      .issue-button.secondary:hover:not(:disabled) {
        background: #e2e8f0;
      }
      .issue-button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .issue-notes {
        margin: 6px 0;
        font-size: 11px;
        color: #334155;
        background: #fef3c7;
        border-radius: 6px;
        padding: 6px 8px;
        border-left: 3px solid #f59e0b;
      }
      .issue-button-group {
        margin-top: 14px;
        display: flex;
        gap: 8px;
      }
      .issue-feedback {
        margin-top: 12px;
        font-size: 13px;
        font-weight: 600;
        padding: 8px 12px;
        border-radius: 8px;
        display: none;
      }
      .issue-feedback.visible {
        display: block;
      }
      .issue-feedback.success {
        background: #dcfce7;
        color: #166534;
      }
      .issue-feedback.error {
        background: #fef2f2;
        color: #dc2626;
      }
      .empty-state {
        text-align: center;
        padding: 60px 20px;
        color: #64748b;
      }
      .empty-state-icon {
        font-size: 64px;
        margin-bottom: 16px;
        opacity: 0.3;
      }
      @media (max-width: 768px) {
        .issues-grid {
          grid-template-columns: 1fr;
        }
        .order-header {
          flex-direction: column;
          align-items: flex-start;
          gap: 12px;
        }
        .issue-actions {
          flex-direction: column;
        }
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
      <div class="page-header">
        <h1 class="page-title">Issue Resolution</h1>
        <p class="page-subtitle">Resolve any issues with your order below. We'll continue processing once everything is cleared.</p>
      </div>
      
      <div class="order-card">
        <div class="order-header">
          <span class="order-id">Order #${safeOrderId}</span>
          <span class="order-status ${orderStatusClass}">${orderStatusLabel}</span>
        </div>
        
        ${hasIssues ? `
          <div class="device-grid">
            ${deviceCardsHtml}
          </div>
        ` : `
          <div class="empty-state">
            <div class="empty-state-icon">✓</div>
            <div class="empty-state-title">All Clear!</div>
            <div class="empty-state-message">No issues found with this order. Great work!</div>
          </div>
        `}
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
            var action = button.getAttribute('data-action') || 'resolve';
            var card = button.closest('.issue-card');
            var feedback = card ? card.querySelector('.issue-feedback') : null;
            var statusLabel = card ? card.querySelector('.issue-status') : null;
            button.disabled = true;
            
            var actionMessage = action === 'received' ? 'Marking as received...' : 'Sending confirmation...';
            var successMessage = action === 'received' ? 'Marked as received!' : 'Confirmed. Thank you!';
            
            setFeedback(feedback, actionMessage, '#64748b');
            fetch('${confirmUrl}', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceKey: deviceKey, reason: reason, action: action }),
            })
              .then(function (response) {
                if (!response.ok) {
                  throw new Error('Request failed. Please try again.');
                }
                return response.json();
              })
              .then(function () {
                setFeedback(feedback, successMessage, '#16a34a');
                if (statusLabel) {
                  statusLabel.textContent = action === 'received' ? 'Received' : 'Resolved';
                  statusLabel.classList.remove('pending');
                  statusLabel.classList.add('resolved');
                }
              })
              .catch(function (error) {
                button.disabled = false;
                setFeedback(feedback, error.message || 'Unable to process. Please try again.', '#dc2626');
              });
          });
        });
      })();
    </script>

    <script type="module" src="https://secondhandcell.com/assets/js/global-auth.js" defer></script>

    <script>
      const createModal = () => {
        if (document.getElementById("loginModal")) return document.getElementById("loginModal");

        const overlay = document.createElement("div");
        overlay.id = "loginModal";
        overlay.className = "shc-auth-modal";
        overlay.style.display = "none";

        overlay.innerHTML = \`
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
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google icon"/>
                Login with Google
              </button>
              <div class="shc-auth-or"><span>or</span></div>
              <input type="email" id="loginEmail" class="shc-auth-field" placeholder="Email address" autocomplete="email" required />
              <input type="password" id="loginPassword" class="shc-auth-field" placeholder="Password" autocomplete="current-password" required />
              <button type="submit" class="shc-auth-primary">Login</button>
              <p class="shc-auth-meta">Forgot your password? <a href="#" id="forgotPasswordLink" class="shc-auth-link" onclick="event.preventDefault()">Reset it</a></p>
            </form>

            <form id="signupForm" class="shc-auth-form" novalidate>
              <button type="button" id="googleSignupBtn" class="shc-auth-google">
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google icon"/>
                Sign up with Google
              </button>
              <div class="shc-auth-or"><span>or</span></div>
              <input type="text" id="signupName" class="shc-auth-field" placeholder="Full name" autocomplete="name" required />
              <input type="email" id="signupEmail" class="shc-auth-field" placeholder="Email address" autocomplete="email" required />
              <input type="password" id="signupPassword" class="shc-auth-field" placeholder="Password (min 6 characters)" autocomplete="new-password" required />
              <button type="submit" class="shc-auth-primary">Create Account</button>
              <p class="shc-auth-meta">Already have an account? <a href="#" id="switchToLogin" class="shc-auth-link" onclick="event.preventDefault()">Login</a></p>
            </form>
          </div>
        \`;

        document.body.appendChild(overlay);
        
        // Setup event listeners
        const closeBtn = overlay.querySelector('.shc-auth-close');
        const loginTabBtn = overlay.querySelector('#loginTabBtn');
        const signupTabBtn = overlay.querySelector('#signupTabBtn');
        const switchToLoginLink = overlay.querySelector('#switchToLogin');
        
        const closeModal = () => {
          overlay.style.display = 'none';
        };
        
        const showTab = (tabName) => {
          const forms = overlay.querySelectorAll('.shc-auth-form');
          const tabs = overlay.querySelectorAll('.shc-auth-tab');
          forms.forEach(f => f.classList.remove('is-visible'));
          tabs.forEach(t => t.classList.remove('is-active'));
          
          overlay.querySelector('#' + (tabName === 'login' ? 'loginForm' : 'signupForm')).classList.add('is-visible');
          overlay.querySelector('#' + (tabName === 'login' ? 'loginTabBtn' : 'signupTabBtn')).classList.add('is-active');
        };
        
        closeBtn.addEventListener('click', closeModal);
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) closeModal();
        });
        
        loginTabBtn.addEventListener('click', () => showTab('login'));
        signupTabBtn.addEventListener('click', () => showTab('signup'));
        switchToLoginLink.addEventListener('click', (e) => {
          e.preventDefault();
          showTab('login');
        });
        
        return overlay;
      };

      // Initialize modal on page load
      document.addEventListener('DOMContentLoaded', () => {
        createModal();
        
        // Look for any elements that should trigger the modal
        document.addEventListener('click', (e) => {
          if (e.target.matches('[data-login-modal]') || e.target.closest('[data-login-modal]')) {
            e.preventDefault();
            const modal = document.getElementById('loginModal');
            if (modal) {
              modal.style.display = 'flex';
            }
          }
        });
      });
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
  '/repricer',
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

apiRouter.get('/repricer/preview', async (req, res, next) => {
  try {
    if (!fs.existsSync(repricerOutputCsvPath)) {
      return res.status(404).json({
        error: 'repricer_output_missing',
        message: 'No repricer output file found. Run repricer first.',
      });
    }

    const csvText = await fs.promises.readFile(repricerOutputCsvPath, 'utf8');
    const rows = parseRepricerCsvPreview(csvText, 200);

    return res.json({
      ok: true,
      file: repricerOutputCsvPath,
      rows,
      rowCount: rows.length,
    });
  } catch (error) {
    return next(error);
  }
});

apiRouter.post('/repricer/run', async (req, res, next) => {
  try {
    if (!fs.existsSync(repricerScriptPath)) {
      return res.status(500).json({
        error: 'repricer_script_missing',
        message: `Repricer script not found at ${repricerScriptPath}`,
      });
    }

    const args = [
      repricerScriptPath,
      '--dir', '/shc33/feed',
      '--write-csv',
      '--no-gca',
    ];

    const startedAt = Date.now();

    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: path.resolve(__dirname, '..'),
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
    });

    const durationMs = Date.now() - startedAt;

    return res.status(result.code === 0 ? 200 : 500).json({
      ok: result.code === 0,
      exitCode: result.code,
      durationMs,
      outputFile: repricerOutputCsvPath,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } catch (error) {
    return next(error);
  }
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
