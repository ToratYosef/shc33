const express = require('express');
const { getWithId } = require('../services/db');

const router = express.Router();

router.get('/profile', async (req, res, next) => {
  try {
    const { uid } = req.user;
    const profile = await getWithId('users', uid);
    if (!profile) {
      return res.status(404).json({ ok: false, error: 'Profile not found.' });
    }
    return res.json({ ok: true, data: profile });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
