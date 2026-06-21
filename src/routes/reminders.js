const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const {
  sendReminderEmail,
  sendExpiringReminderEmail,
  sendKitReminderEmail,
} = require('../../functions/index.js');

const router = express.Router();

router.use(requireAdmin);

function mapCallableError(error) {
  if (!error || typeof error !== 'object') {
    return { status: 500, message: 'Unknown error.' };
  }
  const code = error.code || error?.details?.code || null;
  const message = error.message || 'Request failed.';
  const statusMap = {
    'unauthenticated': 401,
    'permission-denied': 403,
    'invalid-argument': 400,
    'not-found': 404,
    'failed-precondition': 412,
  };
  return { status: statusMap[code] || 500, message };
}

async function invokeCallable(fn, data, req, res, next) {
  try {
    const context = {
      auth: {
        uid: req.user.uid,
        token: req.user.claims,
      },
    };
    const callableRunner = typeof fn.run === 'function' ? fn.run.bind(fn) : fn;
    const result = await callableRunner(data, context);
    return res.json({ ok: true, data: result });
  } catch (error) {
    const mapped = mapCallableError(error);
    console.error('[reminders] callable failed:', {
      path: req.originalUrl || req.url,
      method: req.method,
      status: mapped.status,
      message: mapped.message,
      code: error?.code || error?.details?.code || null,
      stack: error?.stack || null,
      data,
    });
    return res.status(mapped.status).json({ ok: false, error: mapped.message, code: error?.code || null });
  }
}

function resolveReminderTier(body = {}) {
  const candidate = body.tier ?? body.reminderTier ?? body.stage ?? 1;
  const numeric = Number(candidate);
  return [1, 2, 3].includes(numeric) ? numeric : candidate;
}

function sendLabelReminderForOrder(req, res, next) {
  const orderId = req.params.id || req.body?.orderId;
  const reminderTier = resolveReminderTier(req.body || {});
  return invokeCallable(sendReminderEmail, { orderId, reminderTier }, req, res, next);
}

router.post('/admin/reminders/send', (req, res, next) => {
  const { orderId } = req.body || {};
  const reminderTier = resolveReminderTier(req.body || {});
  return invokeCallable(sendReminderEmail, { orderId, reminderTier }, req, res, next);
});

router.post('/orders/:id/send-label-reminder-email', sendLabelReminderForOrder);
router.post('/orders/:id/send-reminder-email', sendLabelReminderForOrder);

router.post('/admin/reminders/send-expiring', (req, res, next) => {
  const { orderId } = req.body || {};
  return invokeCallable(sendExpiringReminderEmail, { orderId }, req, res, next);
});

router.post('/admin/reminders/send-kit', (req, res, next) => {
  const { orderId } = req.body || {};
  return invokeCallable(sendKitReminderEmail, { orderId }, req, res, next);
});

module.exports = router;
