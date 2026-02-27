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
  buildOrderDeviceKey,
  collectOrderDeviceKeys,
  deriveOrderStatusFromDevices,
}) {

  if (!transporter) {
    throw new Error('Email transporter must be provided to create the emails router.');
  }

  // Validate email configuration
  const missingEnvVars = [];
  if (!process.env.EMAIL_USER) missingEnvVars.push('EMAIL_USER');
  if (!process.env.EMAIL_PASS) missingEnvVars.push('EMAIL_PASS');
  if (!process.env.EMAIL_NAME) missingEnvVars.push('EMAIL_NAME');

  if (missingEnvVars.length > 0) {
    console.warn(`⚠️  Email transporter created but missing environment variables: ${missingEnvVars.join(', ')}`);
  }

  const router = express.Router();

  router.post('/send-email', async (req, res) => {
    const { to, bcc, subject, html } = req.body || {};

    try {
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

      // Validate environment variables before attempting send
      if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.error('Missing email environment variables: EMAIL_USER or EMAIL_PASS not configured');
        return res.status(500).json({
          error: 'Email service not configured',
          details: 'EMAIL_USER or EMAIL_PASS environment variables are missing'
        });
      }

      await transporter.sendMail(mailOptions);
      res.status(200).json({ message: 'Email sent successfully.' });
    } catch (error) {
      console.error('Error sending email:', {
        message: error.message,
        code: error.code,
        stack: error.stack,
        to,
      });

      if (error && error.code === 'EAUTH') {
        return res.status(502).json({
          error: 'Email authentication failed',
          details: 'Gmail rejected login. Use a valid Gmail app password for EMAIL_PASS and confirm account security settings.',
          code: error.code,
        });
      }

      res.status(500).json({
        error: 'Failed to send email',
        details: error.message || 'Unknown error',
        code: error.code,
      });
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
      const { reason, notes, label: labelText, deviceKey } = req.body || {};
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

      // Handle per-device status updates
      const resolvedDeviceKey = (typeof deviceKey === 'string' && deviceKey.trim())
        ? deviceKey.trim()
        : buildOrderDeviceKey(req.params.id, 0);

      const { subject, html, text } = buildConditionEmail(reason, order, notes, resolvedDeviceKey);
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

      await transporter.sendMail(mailOptions);

      const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
      const trimmedNotes = typeof notes === 'string' ? notes.trim() : '';
      const updatePayload = {
        lastCustomerEmailSentAt: serverTimestamp,
        lastConditionEmailReason: reason,
        ...(trimmedNotes ? { lastConditionEmailNotes: trimmedNotes } : {}),
      };

      // For all QC-related condition emails, set device status to 'emailed' if deviceKey provided
      const qcEmailReasons = ['outstanding_balance', 'password_locked', 'stolen', 'fmi_active'];
      if (qcEmailReasons.includes(reason) && deviceKey) {
        updatePayload[`deviceStatusByKey.${resolvedDeviceKey}`] = 'emailed';

        updatePayload[`qcIssuesByDevice.${resolvedDeviceKey}.${reason}`] = {
          reason,
          notes: trimmedNotes || null,
          createdAt: serverTimestamp,
          updatedAt: serverTimestamp,
          resolvedAt: null,
          resolved: false,
        };
        
        // Derive order status from all devices
        const nextDeviceStatusByKey = {
          ...(order.deviceStatusByKey || {}),
          [resolvedDeviceKey]: 'emailed',
        };
        const derivedStatus = deriveOrderStatusFromDevices(order, nextDeviceStatusByKey);
        if (derivedStatus) {
          updatePayload.status = derivedStatus;
        } else {
          // If not all devices are in terminal states, check if single device order
          const deviceKeys = collectOrderDeviceKeys(order);
          if (deviceKeys.length === 1) {
            updatePayload.status = 'emailed';
          }
        }
        
        // Set QC awaiting response flag
        updatePayload.qcAwaitingResponse = true;
      } else if (reason === 'outstanding_balance' && !deviceKey) {
        // Legacy: order-level status update for outstanding_balance without deviceKey
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

      res.json({ message: 'Email sent successfully.' });
    } catch (error) {
      console.error('Failed to send condition email:', error);
      res.status(500).json({ error: 'Failed to send condition email.' });
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
