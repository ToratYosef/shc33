const express = require('express');
const { upsert } = require('../services/db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.post('/create-admin', requireAdmin, async (req, res, next) => {
  try {
    const { uid, email, displayName } = req.body || {};

    if (!uid || !email) {
      return res.status(400).json({ ok: false, error: 'uid and email are required.' });
    }

    await upsert('admins', uid, {
      email,
      displayName: displayName || null,
      createdAt: new Date().toISOString(),
      createdBy: req.user.uid,
      admin: true,
    });

    return res.json({ ok: true, uid, email });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
