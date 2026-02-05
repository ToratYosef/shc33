const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const {
  sendReminderEmail,
  sendExpiringReminderEmail,
  sendKitReminderEmail,
} = require('../../../functions/index.js');

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
    const result = await fn(data, context);
    return res.json({ ok: true, data: result });
  } catch (error) {
    const mapped = mapCallableError(error);
    return res.status(mapped.status).json({ ok: false, error: mapped.message });
  }
}

router.post('/admin/reminders/send', (req, res, next) => {
  const { orderId } = req.body || {};
  return invokeCallable(sendReminderEmail, { orderId }, req, res, next);
});

router.post('/admin/reminders/send-expiring', (req, res, next) => {
  const { orderId } = req.body || {};
  return invokeCallable(sendExpiringReminderEmail, { orderId }, req, res, next);
});

router.post('/admin/reminders/send-kit', (req, res, next) => {
  const { orderId } = req.body || {};
  return invokeCallable(sendKitReminderEmail, { orderId }, req, res, next);
});

module.exports = router;
