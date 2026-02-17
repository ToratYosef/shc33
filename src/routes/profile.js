const express = require('express');
const { db } = require('../services/firestore');

const router = express.Router();

router.get('/profile', async (req, res, next) => {
  try {
    const { uid } = req.user;
    const snapshot = await db.collection('users').doc(uid).get();
    if (!snapshot.exists) {
      return res.status(404).json({ ok: false, error: 'Profile not found.' });
    }
    return res.json({ ok: true, data: { id: snapshot.id, ...snapshot.data() } });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
