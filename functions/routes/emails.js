const express = require('express');
const admin = require('firebase-admin');

module.exports = function createEmailsRouter({
  transporter,
  sendMultipleTestEmails,
  CONDITION_EMAIL_TEMPLATES,
  CONDITION_EMAIL_FROM_ADDRESS,
  CONDITION_EMAIL_BCC_RECIPIENTS,
  buildConditionEmail,
  ordersCollection,
  updateOrderBoth,
}) {
  if (!transporter) {
    throw new Error('Email transporter must be provided to create the emails router.');
  }

  const router = express.Router();

  function queueEmail(label, task) {
    Promise.resolve()
      .then(task)
      .catch((error) => {
        console.error(`${label}:`, error);
      });
  }

  router.post('/send-email', async (req, res) => {
    try {
      const { to, bcc, subject, html } = req.body || {};

      if (!to || !subject || !html) {
        return res
          .status(400)
          .json({ error: 'Missing required fields: to, subject, and html are required.' });
      }

      const mailOptions = {
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to,
        subject,
        html,
        bcc: Array.isArray(bcc) ? bcc : bcc ? [bcc] : [],
      };

      queueEmail('Error sending email', () => transporter.sendMail(mailOptions));
      res.status(202).json({ message: 'Email queued successfully.' });
    } catch (error) {
      console.error('Error queueing email:', error);
      res.status(500).json({ error: 'Failed to queue email.' });
    }
  });

  router.post('/test-emails', async (req, res) => {
    const { email, emailTypes } = req.body || {};

    if (!email || !emailTypes || !Array.isArray(emailTypes)) {
      return res.status(400).json({ error: 'Email and emailTypes array are required.' });
    }

    try {
      const testResult = await sendMultipleTestEmails(email, emailTypes);
      console.log('Test emails sent. Types:', emailTypes);
      res.status(200).json(testResult);
    } catch (error) {
      console.error('Failed to send test emails:', error);
      res.status(500).json({ error: `Failed to send test emails: ${error.message}` });
    }
  });

  router.post('/orders/:id/send-condition-email', async (req, res) => {
    try {
      const { reason, notes, label: labelText } = req.body || {};
      if (!reason || !CONDITION_EMAIL_TEMPLATES[reason]) {
        return res.status(400).json({ error: 'A valid email reason is required.' });
      }

      const orderRef = ordersCollection.doc(req.params.id);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) {
        return res.status(404).json({ error: 'Order not found.' });
      }

      const order = { id: orderSnap.id, ...orderSnap.data() };
      const shippingInfo = order.shippingInfo || {};
      const customerEmail = shippingInfo.email || shippingInfo.emailAddress;
      if (!customerEmail) {
        return res
          .status(400)
          .json({ error: 'The order does not have a customer email address.' });
      }

      const { subject, html, text } = buildConditionEmail(reason, order, notes);
      const mailOptions = {
        from: CONDITION_EMAIL_FROM_ADDRESS,
        to: customerEmail,
        subject,
        html,
        text,
      };

      if (CONDITION_EMAIL_BCC_RECIPIENTS.length) {
        mailOptions.bcc = CONDITION_EMAIL_BCC_RECIPIENTS;
      }

      queueEmail('Failed to send condition email', async () => {
        await transporter.sendMail(mailOptions);

        const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
        const updatePayload = {
          lastCustomerEmailSentAt: serverTimestamp,
          lastConditionEmailReason: reason,
          ...(notes && notes.trim() ? { lastConditionEmailNotes: notes.trim() } : {}),
        };

        if (reason === 'outstanding_balance') {
          updatePayload.balanceEmailSentAt = serverTimestamp;
          if ((order.status || '').toLowerCase() === 'received') {
            updatePayload.status = 'emailed';
          }
        }

        await updateOrderBoth(
          req.params.id,
          updatePayload,
          {
            autoLogStatus: false,
            logEntries: [
              {
                type: 'email',
                message: `Sent ${labelText || subject} email to customer.`,
                metadata: {
                  reason,
                  label: labelText || null,
                  notes: notes && notes.trim() ? notes.trim() : null,
                },
              },
            ],
          }
        );
      });

      res.status(202).json({ message: 'Condition email queued successfully.' });
    } catch (error) {
      console.error('Failed to queue condition email:', error);
      res.status(500).json({ error: 'Failed to queue condition email.' });
    }
  });

  router.post('/orders/:id/fmi-cleared', async (req, res) => {
    try {
      const { id } = req.params;
      const docRef = ordersCollection.doc(id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = { id: doc.id, ...doc.data() };

      if (order.status !== 'fmi_on_pending') {
        return res
          .status(409)
          .json({ error: 'Order is not in the correct state to be marked FMI cleared.' });
      }

      await updateOrderBoth(id, {
        status: 'fmi_cleared',
        fmiAutoDowngradeDate: null,
      });

      res.json({ message: 'FMI status updated successfully.' });
    } catch (error) {
      console.error('Error clearing FMI status:', error);
      res.status(500).json({ error: 'Failed to clear FMI status' });
    }
  });

  return router;
};
