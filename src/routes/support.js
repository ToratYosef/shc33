const express = require('express');
const { insertWithGeneratedId } = require('../services/db');

const router = express.Router();

router.post('/email-support', async (req, res, next) => {
  try {
    const { chatId, userName, userEmail, firstMessage } = req.body || {};

    if (!userEmail || !firstMessage) {
      return res.status(400).json({ ok: false, error: 'userEmail and firstMessage are required.' });
    }

    const ticketId = await insertWithGeneratedId('support_tickets', {
      chatId: chatId || null,
      customerName: userName || null,
      email: userEmail,
      message: firstMessage,
      createdAt: new Date().toISOString(),
      source: 'web_chat',
    });

    return res.json({ ok: true, ticketId });
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

    await insertWithGeneratedId('chat_feedback', {
      chatId,
      surveyData,
      createdAt: new Date().toISOString(),
      source: 'chat_survey',
    });

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
