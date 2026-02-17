const express = require('express');
const { admin, db } = require('../services/firestore');

const router = express.Router();

router.post('/email-support', async (req, res, next) => {
  try {
    const { chatId, userName, userEmail, firstMessage } = req.body || {};

    if (!userEmail || !firstMessage) {
      return res.status(400).json({ ok: false, error: 'userEmail and firstMessage are required.' });
    }

    const ticketRef = await db.collection('support_tickets').add({
      chatId: chatId || null,
      customerName: userName || null,
      email: userEmail,
      message: firstMessage,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'web_chat',
    });

    return res.json({ ok: true, ticketId: ticketRef.id });
  } catch (error) {
    return next(error);
  }
});

router.post('/submit-chat-feedback', async (req, res, next) => {
  try {
    const { chatId, surveyData } = req.body || {};

    if (!chatId || !surveyData) {
      return res.status(400).json({ ok: false, error: 'chatId and surveyData are required.' });
    }

    await db.collection('chat_feedback').add({
      chatId,
      surveyData,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'chat_survey',
    });

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
