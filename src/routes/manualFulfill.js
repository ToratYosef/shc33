const express = require('express');
const { updateOrderBoth } = require('../../../functions/index.js');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.post('/manual-fulfill/:id', requireAdmin, async (req, res, next) => {
  try {
    const orderId = req.params.id;
    const {
      outboundTrackingNumber,
      inboundTrackingNumber,
      inboundLabelUrl,
    } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ ok: false, error: 'Order ID is required.' });
    }
    if (!inboundTrackingNumber) {
      return res.status(400).json({ ok: false, error: 'Inbound tracking number is required.' });
    }

    const updatePayload = {
      inboundTrackingNumber,
      inboundLabelUrl: inboundLabelUrl || null,
      trackingNumber: inboundTrackingNumber,
    };

    if (outboundTrackingNumber) {
      updatePayload.outboundTrackingNumber = outboundTrackingNumber;
      updatePayload.status = 'kit_sent';
    } else {
      updatePayload.status = 'label_generated';
    }

    const { order } = await updateOrderBoth(orderId, updatePayload, {
      autoLogStatus: true,
      logEntries: [
        {
          type: 'update',
          message: 'Manual fulfillment applied.',
          metadata: {
            outboundTrackingNumber: outboundTrackingNumber || null,
            inboundTrackingNumber,
          },
        },
      ],
    });

    return res.json({
      ok: true,
      message: 'Manual fulfillment applied successfully.',
      order,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
