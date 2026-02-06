const express = require('express');

module.exports = function createAdminControlsModule(deps) {
  const {
    admin,
    axios,
    ordersCollection,
    usersCollection,
    updateOrderBoth,
    sendMailWithFallback,
    formatShippingAddressForLog,
    recordCustomerEmail,
    getOrderPayout,
    applyTemplate,
    buildDeviceSummary,
    formatCurrencyValue,
    formatDisplayText,
    getOrderCompletedEmailTemplate,
    DEVICE_RECEIVED_EMAIL_HTML,
    REVIEW_REQUEST_EMAIL_HTML,
    buildEmailLayout,
    escapeHtml,
    getLastCustomerEmailMillis,
    MANUAL_AUTO_REQUOTE_INELIGIBLE_STATUSES,
    createShipEngineLabel,
    cancelOrderAndNotify,
    getShipStationCredentials,
    buildKitTrackingUpdate,
    DEFAULT_CARRIER_CODE,
    resolveCarrierCode,
    buildTrackingUrl,
    fetchTrackingData,
    normalizeInboundTrackingStatus,
    isStatusPastReceived,
    shouldPromoteKitStatus,
    shouldTrackInbound,
    getInboundTrackingNumber,
    deriveInboundStatusUpdate,
    formatStatusLabel,
    isKitOrder,
    mapShipEngineStatus,
    KIT_TRANSIT_STATUS,
  } = deps;

  const httpClient = axios.create({
    timeout: Number(process.env.ADMIN_HTTP_TIMEOUT_MS || 15000),
  });

  const router = express.Router();

  async function refreshKitTrackingById(orderId, options = {}) {
    if (!orderId) {
      const error = new Error('Order ID is required');
      error.statusCode = 400;
      throw error;
    }

    const doc = await ordersCollection.doc(orderId).get();
    if (!doc.exists) {
      const error = new Error('Order not found');
      error.statusCode = 404;
      throw error;
    }

    const order = { id: doc.id, ...doc.data() };

    if (isStatusPastReceived(order)) {
      return { skipped: true, reason: 'Order already received/completed. Tracking refresh skipped.' };
    }

    const hasOutbound = Boolean(order.outboundTrackingNumber);
    const hasInbound = Boolean(order.inboundTrackingNumber || order.trackingNumber);

    if (!hasOutbound && !hasInbound) {
      return { skipped: true, reason: 'No tracking numbers available for this order.' };
    }

    const shipengineKey = options.shipengineKey || process.env.SHIPENGINE_KEY || null;
    const shipstationCredentials = options.shipstationCredentials || getShipStationCredentials();
    if (!shipengineKey && !shipstationCredentials) {
      const error = new Error('Tracking API credentials are not configured.');
      error.statusCode = 500;
      throw error;
    }

    let updatePayload;
    let delivered;
    let direction;

    try {
      ({ updatePayload, delivered, direction } = await buildKitTrackingUpdate(order, {
        axiosClient: httpClient,
        shipengineKey,
        shipstationCredentials,
        defaultCarrierCode: DEFAULT_CARRIER_CODE,
        serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
      }));
    } catch (error) {
      const message = typeof error?.message === 'string' ? error.message : '';
      if (
        message.includes('Tracking number not available') ||
        message.includes('Tracking number is required') ||
        message.includes('Carrier code is required')
      ) {
        return { skipped: true, reason: message };
      }
      throw error;
    }

    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    const updateData = {
      ...updatePayload,
      kitTrackingLastRefreshedAt: timestamp,
    };

    if (direction === 'inbound') {
      updateData.inboundTrackingLastRefreshedAt = timestamp;
    }

    const { order: updatedOrder } = await updateOrderBoth(orderId, updateData, {
      existingOrder: order,
      skipReload: true,
    });

    const message = (() => {
      if (direction === 'inbound') {
        if (delivered) {
          if (updatePayload.status === 'delivered_to_us') {
            return 'Inbound kit marked as delivered to us.';
          }
          return 'Inbound device marked as delivered.';
        }
        return 'Inbound tracking status refreshed.';
      }

      return delivered ? 'Kit marked as delivered.' : 'Kit tracking status refreshed.';
    })();

    if (delivered && shipengineKey) {
      try {
        if (shouldTrackInbound(updatedOrder)) {
          await syncInboundTrackingForOrder(updatedOrder, { shipengineKey });
        }
      } catch (inboundError) {
        console.error(
          `Error syncing inbound tracking after kit delivery for order ${orderId}:`,
          inboundError
        );
      }
    }

    return {
      message,
      delivered,
      direction,
      tracking: updatePayload.kitTrackingStatus,
      order: {
        id: updatedOrder.id,
        status: updatedOrder.status,
      },
    };
  }

  async function syncInboundTrackingForOrder(order, options = {}) {
    if (!order || !order.id) {
      throw new Error('Order details are required to sync inbound tracking.');
    }

    const trackingNumber = getInboundTrackingNumber(order);
    if (!trackingNumber) {
      return {
        order,
        tracking: null,
        skipped: 'no_tracking',
      };
    }

    const shipEngineKey = options.shipengineKey || process.env.SHIPENGINE_KEY || null;
    const shipStationCredentials = options.shipstationCredentials || getShipStationCredentials();
    if (!shipEngineKey && !shipStationCredentials) {
      throw new Error('ShipEngine or ShipStation API credentials not configured.');
    }

    const axiosClient = options.axiosClient || httpClient;
    const carrierCode = resolveCarrierCode(order, 'inbound', DEFAULT_CARRIER_CODE);

    const trackingData = await fetchTrackingData({
      axiosClient,
      trackingNumber,
      carrierCode,
      defaultCarrierCode: DEFAULT_CARRIER_CODE,
      shipengineKey: shipEngineKey,
      shipstationCredentials: shipStationCredentials,
    });

    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    if (!trackingData || typeof trackingData !== 'object') {
      const { order: updatedOrder } = await updateOrderBoth(order.id, {
        labelTrackingLastSyncedAt: timestamp,
      }, {
        autoLogStatus: false,
        logEntries: [
          {
            type: 'tracking',
            message: 'Inbound label tracking sync attempted but ShipEngine returned no data.',
            metadata: { trackingNumber },
          },
        ],
        existingOrder: order,
        skipReload: true,
      });

      return {
        order: updatedOrder,
        tracking: null,
        skipped: 'no_data',
      };
    }

    const updatePayload = {
      labelTrackingStatus: trackingData.status_code || trackingData.statusCode || null,
      labelTrackingStatusDescription: trackingData.status_description || trackingData.statusDescription || null,
      labelTrackingCarrierStatusCode: trackingData.carrier_status_code || trackingData.carrierStatusCode || null,
      labelTrackingCarrierStatusDescription:
        trackingData.carrier_status_description || trackingData.carrierStatusDescription || null,
      labelTrackingEstimatedDelivery:
        trackingData.estimated_delivery_date || trackingData.estimatedDeliveryDate || null,
      labelTrackingLastSyncedAt: timestamp,
    };

    if (Array.isArray(trackingData.events)) {
      updatePayload.labelTrackingEvents = trackingData.events;
    } else if (Array.isArray(trackingData.activities)) {
      updatePayload.labelTrackingEvents = trackingData.activities;
    }

    const normalizedStatus = normalizeInboundTrackingStatus(
      updatePayload.labelTrackingStatus,
      updatePayload.labelTrackingStatusDescription
    );
    if (normalizedStatus === 'DELIVERED' || normalizedStatus === 'DELIVERED_TO_AGENT') {
      updatePayload.labelDeliveredAt = timestamp;
    }

    const statusUpdate = deriveInboundStatusUpdate(order, normalizedStatus, updatePayload);

    const logEntries = [];

    if (statusUpdate && statusUpdate.nextStatus && statusUpdate.nextStatus !== order.status) {
      updatePayload.status = statusUpdate.nextStatus;
      updatePayload.lastStatusUpdateAt = timestamp;

      if (statusUpdate.nextStatus === 'delivered_to_us') {
        if (statusUpdate.markKitDelivered || isKitOrder(order)) {
          updatePayload.kitDeliveredToUsAt = timestamp;
        }
        if (statusUpdate.autoReceive || (!isKitOrder(order) && !order.receivedAt)) {
          updatePayload.receivedAt = timestamp;
          updatePayload.autoReceived = true;
        }
      } else if (statusUpdate.nextStatus === 'received') {
        updatePayload.receivedAt = timestamp;
        updatePayload.autoReceived = true;
      }
      logEntries.push({
        type: 'status',
        message: `Status changed to ${formatStatusLabel(statusUpdate.nextStatus)} via inbound tracking.`,
        metadata: { trackingNumber, source: 'inbound_tracking' },
      });
    }

    const { order: updatedOrder } = await updateOrderBoth(order.id, updatePayload, {
      autoLogStatus: false,
      logEntries,
      existingOrder: order,
      skipReload: true,
    });

    let emailSent = false;
    if (statusUpdate && statusUpdate.nextStatus === 'received') {
      emailSent = await sendDeviceReceivedNotification(updatedOrder, {
        trackingNumber,
      });
    }

    return {
      order: updatedOrder,
      tracking: trackingData,
      normalizedStatus,
      statusUpdate,
      emailSent,
    };
  }

  async function sendDeviceReceivedNotification(order, options = {}) {
    if (!order || !order.id) {
      return false;
    }

    if (order.receivedNotificationSentAt) {
      return false;
    }

    const email = order.shippingInfo?.email;
    if (!email) {
      return false;
    }

    const customerName = order.shippingInfo?.fullName || 'there';
    const htmlBody = applyTemplate(DEVICE_RECEIVED_EMAIL_HTML, {
      '**CUSTOMER_NAME**': customerName,
      '**ORDER_ID**': order.id,
    });

    try {
      await sendMailWithFallback({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Your SecondHandCell Device Has Arrived',
        html: htmlBody,
      });

      await recordCustomerEmail(order.id, 'Received confirmation email sent to customer.', {
        trackingNumber: options?.trackingNumber || getInboundTrackingNumber(order) || null,
        auto: true,
      }, {
        additionalUpdates: {
          receivedNotificationSentAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      });

      return true;
    } catch (error) {
      console.error(`Failed to send automatic received notification for order ${order.id}:`, error);
      return false;
    }
  }

  async function refreshEmailLabelTrackingById(orderId) {
    if (!orderId) {
      const error = new Error('Order ID is required');
      error.statusCode = 400;
      throw error;
    }

    const doc = await ordersCollection.doc(orderId).get();
    if (!doc.exists) {
      const error = new Error('Order not found');
      error.statusCode = 404;
      throw error;
    }

    const order = { id: doc.id, ...doc.data() };
    if (isStatusPastReceived(order)) {
      return { skipped: true, reason: 'Order already received/completed. Tracking refresh skipped.' };
    }
    const result = await syncInboundTrackingForOrder(order);

    if (result.skipped === 'no_tracking') {
      return { skipped: true, reason: 'No inbound tracking number on file for this order.' };
    }

    if (result.skipped === 'no_data') {
      return { skipped: true, reason: 'Tracking API returned no inbound data for this order.' };
    }

    return {
      message: 'Label tracking synchronized.',
      order: { id: result.order.id, status: result.order.status },
      tracking: result.tracking ? result.tracking : result.order.labelTrackingStatus,
      statusUpdate: result.statusUpdate || null,
    };
  }

  router.put('/orders/:id/shipping-info', async (req, res) => {
    try {
      const orderId = req.params.id;
      const incoming = req.body && typeof req.body === 'object' ? req.body : {};

      if (!orderId) {
        return res.status(400).json({ error: 'Order ID is required.' });
      }

      const orderRef = ordersCollection.doc(orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) {
        return res.status(404).json({ error: 'Order not found.' });
      }

      const existingOrder = orderSnap.data() || {};
      const fieldLabels = {
        fullName: 'Full name',
        email: 'Email',
        phone: 'Phone',
        streetAddress: 'Street address',
        city: 'City',
        state: 'State',
        zipCode: 'ZIP / Postal code',
      };

      const updatePayload = {};
      const providedFields = Object.keys(fieldLabels).filter((field) =>
        Object.prototype.hasOwnProperty.call(incoming, field)
      );

      if (!providedFields.length) {
        return res.status(400).json({ error: 'No shipping fields were provided.' });
      }

      for (const field of providedFields) {
        const label = fieldLabels[field];
        let value = incoming[field];
        if (typeof value === 'string') {
          value = value.trim();
        }

        if (!value) {
          return res.status(400).json({ error: `${label} is required.` });
        }

        if (field === 'state') {
          value = String(value).toUpperCase();
          if (value.length !== 2) {
            return res
              .status(400)
              .json({ error: 'State must use the 2-letter abbreviation.' });
          }
        }

        updatePayload[`shippingInfo.${field}`] = value;
      }

      const mergedShippingInfo = {
        ...(existingOrder.shippingInfo || {}),
        ...providedFields.reduce((acc, field) => {
          acc[field] = updatePayload[`shippingInfo.${field}`];
          return acc;
        }, {}),
      };

      const logEntries = [
        {
          type: 'update',
          message: `Updated shipping address: ${formatShippingAddressForLog(mergedShippingInfo)}`,
        },
      ];

      const { order } = await updateOrderBoth(orderId, updatePayload, {
        autoLogStatus: false,
        logEntries,
        existingOrder: order,
        skipReload: true,
      });

      res.json({
        message: 'Shipping address updated.',
        shippingInfo: order.shippingInfo || {},
      });
    } catch (error) {
      console.error('Error updating shipping info:', error);
      res.status(500).json({ error: 'Failed to update shipping address.' });
    }
  });

  router.put('/orders/:id/status', async (req, res) => {
    try {
      const { status } = req.body;
      const orderId = req.params.id;
      if (!status) return res.status(400).json({ error: 'Status is required' });

      const notifyCustomer = req.body?.notifyCustomer !== false;
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      const statusUpdate = { status, lastStatusUpdateAt: timestamp };
      if (status === 'kit_sent') {
        statusUpdate.kitSentAt = timestamp;
      }
      if (status === 'needs_printing') {
        statusUpdate.needsPrintingAt = timestamp;
      }

      const { order } = await updateOrderBoth(orderId, statusUpdate);

      let emailLogMessage = null;
      const emailMetadata = { status };

      if (notifyCustomer) {
        let customerNotificationPromise = Promise.resolve();
        let customerEmailHtml = '';
        const customerName = order.shippingInfo?.fullName || 'there';

        switch (status) {
          case 'received': {
            customerEmailHtml = DEVICE_RECEIVED_EMAIL_HTML
              .replace(/\*\*CUSTOMER_NAME\*\*/g, customerName)
              .replace(/\*\*ORDER_ID\*\*/g, order.id);

            customerNotificationPromise = sendMailWithFallback({
              from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
              to: order.shippingInfo.email,
              subject: 'Your SecondHandCell Device Has Arrived',
              html: customerEmailHtml,
            });
            emailLogMessage = 'Received confirmation email sent to customer.';
            emailMetadata.trackingNumber = order.trackingNumber || order.inboundTrackingNumber || null;
            break;
          }
          case 'completed': {
            const payoutAmount = getOrderPayout(order);
            const wasReoffered = !!(order.reOffer && Object.keys(order.reOffer).length);
            const completedTemplate = getOrderCompletedEmailTemplate({ includeTrustpilot: !wasReoffered });
            customerEmailHtml = applyTemplate(completedTemplate, {
              '**CUSTOMER_NAME**': customerName,
              '**ORDER_ID**': order.id,
              '**DEVICE_SUMMARY**': buildDeviceSummary(order),
              '**ORDER_TOTAL**': formatCurrencyValue(payoutAmount),
              '**PAYMENT_METHOD**': formatDisplayText(order.paymentMethod, 'Not specified'),
            });

            customerNotificationPromise = sendMailWithFallback({
              from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
              to: order.shippingInfo.email,
              subject: 'Your SecondHandCell Order is Complete',
              html: customerEmailHtml,
            });
            emailLogMessage = 'Order completion email sent to customer.';
            emailMetadata.payoutAmount = formatCurrencyValue(payoutAmount);
            emailMetadata.wasReoffered = wasReoffered;
            break;
          }
          default: {
            break;
          }
        }

        customerNotificationPromise
          .then(async () => {
            if (emailLogMessage) {
              await recordCustomerEmail(orderId, emailLogMessage, emailMetadata);
            }
          })
          .catch((emailError) => {
            console.error(`Failed to send customer status email for order ${orderId}:`, emailError);
          });
      }

      const responseMessage = notifyCustomer
        ? `Order marked as ${status}`
        : `Order marked as ${status} without emailing the customer.`;

      res.json({ message: responseMessage, notifyCustomer });
    } catch (err) {
      console.error('Error updating status:', err);
      res.status(500).json({ error: 'Failed to update status' });
    }
  });

  router.post('/orders/:id/send-review-request', async (req, res) => {
    try {
      const orderId = req.params.id;
      const docRef = ordersCollection.doc(orderId);
      const doc = await docRef.get();

      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = { id: doc.id, ...doc.data() };
      const customerEmail = order.shippingInfo?.email;
      if (!customerEmail) {
        return res.status(400).json({ error: 'Order does not have a customer email on file.' });
      }

      const customerName = order.shippingInfo?.fullName || 'there';
      const payoutAmount = getOrderPayout(order);

      const reviewEmailHtml = applyTemplate(REVIEW_REQUEST_EMAIL_HTML, {
        '**CUSTOMER_NAME**': customerName,
        '**ORDER_ID**': order.id,
        '**DEVICE_SUMMARY**': buildDeviceSummary(order),
        '**ORDER_TOTAL**': formatCurrencyValue(payoutAmount),
      });

      await sendMailWithFallback({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to: customerEmail,
        subject: 'Quick review? Share your SecondHandCell experience',
        html: reviewEmailHtml,
      });

      await recordCustomerEmail(
        orderId,
        'Review request email sent to customer.',
        { status: order.status },
        {
          additionalUpdates: {
            reviewRequestSentAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        }
      );

      res.json({ message: 'Review request email sent successfully.' });
    } catch (error) {
      console.error('Error sending review request:', error);
      res.status(500).json({ error: 'Failed to send review request email.' });
    }
  });

  router.post('/orders/:id/mark-kit-sent', async (req, res) => {
    try {
      const orderId = req.params.id;
      const timestamp = admin.firestore.FieldValue.serverTimestamp();

      const { order } = await updateOrderBoth(orderId, {
        status: 'kit_sent',
        kitSentAt: timestamp,
        lastStatusUpdateAt: timestamp,
      });

      res.json({
        message: `Order ${orderId} marked as kit sent`,
        orderId,
        status: order.status,
      });
    } catch (error) {
      console.error('Error marking kit as sent:', error);
      res.status(500).json({ error: 'Failed to mark kit as sent' });
    }
  });

  router.post('/orders/:id/refresh-kit-tracking', async (req, res) => {
    try {
      const payload = await refreshKitTrackingById(req.params.id);
      res.json(payload);
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error('Error refreshing kit tracking:', error);
      res.status(500).json({ error: 'Failed to refresh kit tracking' });
    }
  });

  router.post('/orders/:id/sync-outbound-tracking', async (req, res) => {
    try {
      const orderId = req.params.id;
      const doc = await ordersCollection.doc(orderId).get();

      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = { id: doc.id, ...doc.data() };
      const trackingNumber = order.outboundTrackingNumber;
      if (!trackingNumber) {
        return res.status(400).json({ error: 'No outbound tracking number on file.' });
      }

      const shipEngineKey = process.env.SHIPENGINE_KEY;
      if (!shipEngineKey) {
        return res.status(500).json({ error: 'ShipEngine API key not configured.' });
      }

      const carrierCode = resolveCarrierCode(order, 'outbound', DEFAULT_CARRIER_CODE);
      const trackingUrl = buildTrackingUrl({
        trackingNumber,
        carrierCode,
        defaultCarrierCode: DEFAULT_CARRIER_CODE,
      });

      const response = await httpClient.get(trackingUrl, {
        headers: { 'API-Key': shipEngineKey },
      });

      const trackingData = response?.data && typeof response.data === 'object'
        ? response.data
        : null;

      const timestamp = admin.firestore.FieldValue.serverTimestamp();

      if (!trackingData) {
        await updateOrderBoth(orderId, {
          outboundTrackingLastSyncedAt: timestamp,
        }, {
          autoLogStatus: false,
          logEntries: [
            {
              type: 'tracking',
              message: 'Outbound tracking sync attempted but ShipEngine returned no data.',
              metadata: { trackingNumber },
            },
          ],
          existingOrder: order,
          skipReload: true,
        });

        return res.json({
          message: 'ShipEngine returned no outbound tracking data. Order was left unchanged.',
          order: { id: orderId, status: order.status },
          tracking: null,
        });
      }

      const normalizedStatus = mapShipEngineStatus(trackingData.status_code || trackingData.statusCode);
      const updatePayload = {
        outboundTrackingStatus: trackingData.status_code || trackingData.statusCode || null,
        outboundTrackingStatusDescription: trackingData.status_description || trackingData.statusDescription || null,
        outboundTrackingCarrierCode: trackingData.carrier_code || trackingData.carrierCode || null,
        outboundTrackingCarrierStatusCode: trackingData.carrier_status_code || trackingData.carrierStatusCode || null,
        outboundTrackingCarrierStatusDescription: trackingData.carrier_status_description || trackingData.carrierStatusDescription || null,
        outboundTrackingEstimatedDelivery: trackingData.estimated_delivery_date || trackingData.estimatedDeliveryDate || null,
        outboundTrackingLastSyncedAt: timestamp,
      };

      if (Array.isArray(trackingData.events)) {
        updatePayload.outboundTrackingEvents = trackingData.events;
      } else if (Array.isArray(trackingData.activities)) {
        updatePayload.outboundTrackingEvents = trackingData.activities;
      }

      if (normalizedStatus && shouldPromoteKitStatus(order.status, normalizedStatus)) {
        updatePayload.status = normalizedStatus;
        updatePayload.lastStatusUpdateAt = timestamp;

        if (normalizedStatus === 'kit_delivered') {
          updatePayload.kitDeliveredAt = timestamp;
        }
        if ((normalizedStatus === KIT_TRANSIT_STATUS || normalizedStatus === 'kit_in_transit') && !order.kitSentAt) {
          updatePayload.kitSentAt = timestamp;
        }
      }

      const { order: updatedOrder } = await updateOrderBoth(orderId, updatePayload, {
        existingOrder: order,
        skipReload: true,
      });

      res.json({
        message: 'Outbound tracking synchronized.',
        orderId,
        status: updatedOrder.status,
        tracking: trackingData,
      });
    } catch (error) {
      console.error('Error syncing outbound tracking:', error.response?.data || error);
      res.status(500).json({ error: 'Failed to sync outbound tracking' });
    }
  });

  router.post('/orders/:id/sync-label-tracking', async (req, res) => {
    try {
      const payload = await refreshEmailLabelTrackingById(req.params.id);
      res.json(payload);
    } catch (error) {
      const message = error?.message || 'Failed to sync label tracking';
      const statusCode = error?.statusCode || 500;
      console.error('Error syncing label tracking:', error.response?.data || error);
      res.status(statusCode).json({ error: message });
    }
  });

  router.post('/orders/:id/re-offer', async (req, res) => {
    try {
      const { newPrice, reasons, comments } = req.body;
      const orderId = req.params.id;

      if (!newPrice || !reasons || !Array.isArray(reasons) || reasons.length === 0) {
        return res.status(400).json({ error: 'New price and at least one reason are required' });
      }

      const orderRef = ordersCollection.doc(orderId);
      const orderDoc = await orderRef.get();
      if (!orderDoc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = { id: orderDoc.id, ...orderDoc.data() };

      await updateOrderBoth(orderId, {
        reOffer: {
          newPrice,
          reasons,
          comments,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          autoAcceptDate: admin.firestore.Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
        status: 're-offered-pending',
      }, {
        existingOrder: order,
        skipReload: true,
      });

      let reasonString = reasons.join(', ');
      if (comments) reasonString += `; ${comments}`;

      const safeReason = escapeHtml(reasonString).replace(/\n/g, '<br>');
      const originalQuoteValue = Number(order.estimatedQuote || order.originalQuote || 0).toFixed(2);
      const newOfferValue = Number(newPrice).toFixed(2);
      const customerName = order.shippingInfo.fullName || 'there';
      const acceptUrl = `${process.env.APP_FRONTEND_URL}/reoffer-action.html?orderId=${orderId}&action=accept`;
      const returnUrl = `${process.env.APP_FRONTEND_URL}/reoffer-action.html?orderId=${orderId}&action=return`;

      const customerEmailHtml = buildEmailLayout({
        title: 'Updated offer available',
        accentColor: '#6366f1',
        includeTrustpilot: false,
        bodyHtml: `
          <p>Hi ${escapeHtml(customerName)},</p>
          <p>Thanks for sending in your device. After inspecting order <strong>#${escapeHtml(order.id)}</strong>, we have a revised offer for you.</p>
          <div style="background:#eef2ff; border:1px solid #c7d2fe; border-radius:18px; padding:20px 24px; margin:28px 0;">
            <p style="margin:0 0 12px; color:#312e81;"><strong>Original Quote:</strong> $${originalQuoteValue}</p>
            <p style="margin:0; color:#1e1b4b; font-size:20px; font-weight:700;">New Offer: $${newOfferValue}</p>
          </div>
          <p style="margin-bottom:12px;">Reason for the change:</p>
          <p style="background:#fef3c7; border-radius:14px; border:1px solid #fde68a; color:#92400e; padding:14px 18px; margin:0 0 28px;">${safeReason}</p>
          <p style="margin-bottom:20px;">Choose how you'd like to proceed:</p>
          <div style="text-align:center; margin-bottom:20px;">
            <a href="${acceptUrl}" class="button-link" style="background-color:#16a34a;">Accept offer ($${newOfferValue})</a>
          </div>
          <div style="text-align:center; margin-bottom:24px;">
            <a href="${returnUrl}" class="button-link" style="background-color:#dc2626;">Return device instead</a>
          </div>
          <p>Questions or feedback? Reply to this email—we're here to help.</p>
      `,
      });

      await sendMailWithFallback({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to: order.shippingInfo.email,
        subject: `Re-offer for Order #${order.id}`,
        html: customerEmailHtml,
      });

      await recordCustomerEmail(
        orderId,
        'Re-offer email sent to customer.',
        {
          newPrice: Number(newPrice).toFixed(2),
          originalQuote: Number(order.estimatedQuote || order.originalQuote || 0).toFixed(2),
        }
      );

      res.json({ message: 'Re-offer submitted successfully', newPrice, orderId: order.id });
    } catch (err) {
      console.error('Error submitting re-offer:', err);
      res.status(500).json({ error: 'Failed to submit re-offer' });
    }
  });

  router.post('/orders/:id/return-label', async (req, res) => {
    try {
      const doc = await ordersCollection.doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ error: 'Order not found' });
      const order = { id: doc.id, ...doc.data() };

      const buyerShippingInfo = order.shippingInfo;
      const orderIdForLabel = order.id || 'N/A';

      const secondHandCellAddress = {
        name: 'Second Hand Cell',
        company_name: 'Second Hand Cell',
        phone: '3475591707',
        address_line1: '1602 MCDONALD AVE STE REAR ENTRANCE',
        city_locality: 'Brooklyn',
        state_province: 'NY',
        postal_code: '11230-6336',
        country_code: 'US',
      };

      const buyerAddress = {
        name: buyerShippingInfo.fullName,
        phone: '3475591707',
        address_line1: buyerShippingInfo.streetAddress,
        city_locality: buyerShippingInfo.city,
        state_province: buyerShippingInfo.state,
        postal_code: buyerShippingInfo.zipCode,
        country_code: 'US',
      };

      const isReturnToCustomer = order.status === 're-offered-declined';
      const shipFromAddress = isReturnToCustomer
        ? secondHandCellAddress
        : buyerAddress;
      const shipToAddress = isReturnToCustomer
        ? buyerAddress
        : secondHandCellAddress;

      const returnPackageData = {
        service_code: 'usps_ground_advantage',
        dimensions: { unit: 'inch', height: 2, width: 4, length: 6 },
        weight: { ounces: 8, unit: 'ounce' },
      };

      const returnLabelData = await createShipEngineLabel(
        shipFromAddress,
        shipToAddress,
        `${orderIdForLabel}-RETURN`,
        returnPackageData
      );

      const returnTrackingNumber = returnLabelData.tracking_number;

      await updateOrderBoth(req.params.id, {
        status: 'return-label-generated',
        returnLabelUrl: returnLabelData.label_download?.pdf,
        returnTrackingNumber: returnTrackingNumber,
      }, {
        existingOrder: order,
        skipReload: true,
      });

      const customerMailOptions = {
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to: order.shippingInfo.email,
        subject: 'Your SecondHandCell Return Label',
        html: `
        <p>Hello ${order.shippingInfo.fullName},</p>
        <p>As requested, here is your return shipping label for your device (Order ID: ${order.id}):</p>
        <p>Return Tracking Number: <strong>${returnTrackingNumber || 'N/A'}</strong></p>
        <a href="${returnLabelData.label_download?.pdf}">Download Return Label</a>
        <p>Thank you,</p>
        <p>The SecondHandCell Team</p>
      `,
      };

      await sendMailWithFallback(customerMailOptions);

      await recordCustomerEmail(
        order.id,
        'Return label email sent to customer.',
        { trackingNumber: returnTrackingNumber },
        {
          additionalUpdates: {
            returnLabelEmailSentAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        }
      );

      res.json({
        message: 'Return label generated successfully.',
        returnLabelUrl: returnLabelData.label_download?.pdf,
        returnTrackingNumber: returnTrackingNumber,
        orderId: order.id,
      });
    } catch (err) {
      console.error('Error generating return label:', err.response?.data || err);
      res.status(500).json({ error: 'Failed to generate return label' });
    }
  });

  router.post('/orders/:id/auto-requote', async (req, res) => {
    try {
      const orderId = req.params.id;
      if (!orderId) {
        return res.status(400).json({ error: 'Order ID is required.' });
      }

      const docRef = ordersCollection.doc(orderId);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found.' });
      }

      const order = { id: doc.id, ...doc.data() };
      const status = (order.status || '').toString().toLowerCase();

      if (MANUAL_AUTO_REQUOTE_INELIGIBLE_STATUSES.has(status)) {
        return res
          .status(409)
          .json({ error: 'Order status is not eligible for manual auto-requote.' });
      }

      if (order.autoRequote?.manual === true) {
        return res.status(409).json({ error: 'This order has already been manually auto-requoted.' });
      }

      const customerEmail = order.shippingInfo?.email;
      if (!customerEmail) {
        return res.status(409).json({ error: 'Order is missing a customer email address.' });
      }

      const lastEmailMs = getLastCustomerEmailMillis(order);
      const lastEmailTimestamp = lastEmailMs
        ? admin.firestore.Timestamp.fromMillis(lastEmailMs)
        : null;

      const baseAmount = Number(order.reOffer?.newPrice ?? getOrderPayout(order));
      if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
        return res.status(409).json({ error: 'No valid quoted amount available for auto-requote.' });
      }

      const reducedAmount = Number((baseAmount * 0.25).toFixed(2));
      if (!Number.isFinite(reducedAmount) || reducedAmount <= 0) {
        return res.status(409).json({ error: 'Unable to calculate the adjusted payout amount.' });
      }

      const customerName = order.shippingInfo?.fullName || 'there';
      const baseDisplay = baseAmount.toFixed(2);
      const reducedDisplay = reducedAmount.toFixed(2);
      const timestampField = admin.firestore.FieldValue.serverTimestamp();

      const autoRequotePayload = {
        reducedFrom: Number(baseDisplay),
        reducedTo: reducedAmount,
        manual: true,
        initiatedBy: req.body?.initiatedBy || 'admin_manual_auto_requote',
        completedAt: timestampField,
      };

      if (lastEmailTimestamp) {
        autoRequotePayload.lastCustomerEmailAt = lastEmailTimestamp;
      }

      const { order: updatedOrder } = await updateOrderBoth(orderId, {
        status: 'completed',
        finalPayoutAmount: reducedAmount,
        finalOfferAmount: reducedAmount,
        finalPayout: reducedAmount,
        requoteAcceptedAt: timestampField,
        autoRequote: autoRequotePayload,
      }, {
        logEntries: [
          {
            type: 'auto_requote',
            message: `Order manually finalized at $${reducedDisplay} after unresolved customer communication.`,
            metadata: {
              previousStatus: order.status || null,
              reducedFrom: Number(baseDisplay),
              reducedTo: reducedAmount,
              reductionPercent: 75,
            },
          },
        ],
        existingOrder: order,
        skipReload: true,
      });

      const emailHtml = buildEmailLayout({
        title: 'Order finalized at adjusted payout',
        accentColor: '#dc2626',
        includeTrustpilot: false,
        bodyHtml: `
        <p>Hi ${escapeHtml(customerName)},</p>
        <p>Since we have not received a response after multiple emails, we’ve finalized order <strong>#${escapeHtml(order.id)}</strong> at a payout that is 75% less than the previous quote of $${baseDisplay}.</p>
        <p>Your new payout amount is <strong>$${reducedDisplay}</strong>. You will receive your payment shortly.</p>
        <p>If you have any questions, just reply to this email and our team will be happy to help.</p>
      `,
      });

      await sendMailWithFallback({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to: customerEmail,
        subject: `Order #${order.id} finalized at adjusted payout`,
        html: emailHtml,
      });

      await recordCustomerEmail(
        orderId,
        'Manual auto-requote email sent to customer.',
        {
          status: 'completed',
          reducedFrom: baseDisplay,
          reducedTo: reducedDisplay,
        },
        { logType: 'auto_requote_email' }
      );

      res.json({
        message: `Order finalized at $${reducedDisplay} after admin confirmation.`,
        order: { id: updatedOrder.id, status: updatedOrder.status, finalPayoutAmount: reducedAmount },
      });
    } catch (error) {
      console.error('Error performing manual auto-requote:', error);
      res.status(500).json({ error: 'Failed to finalize the order with the adjusted payout.' });
    }
  });

  router.post('/orders/:id/cancel', async (req, res) => {
    try {
      const orderId = req.params.id;
      const doc = await ordersCollection.doc(orderId).get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = { id: doc.id, ...doc.data() };
      const reason = req.body?.reason || 'cancelled_by_admin';
      const initiatedBy = req.body?.initiatedBy || req.body?.cancelledBy || null;
      const notifyCustomer = req.body?.notifyCustomer !== false;
      const shouldVoidLabels = req.body?.voidLabels !== false;

      const { order: updatedOrder, voidResults } = await cancelOrderAndNotify(order, {
        auto: false,
        reason,
        initiatedBy,
        notifyCustomer,
        voidLabels: shouldVoidLabels,
      });

      const attemptedCount = Array.isArray(voidResults) ? voidResults.length : 0;
      const approvedCount = Array.isArray(voidResults)
        ? voidResults.filter((entry) => entry && entry.approved).length
        : 0;
      const deniedCount = Math.max(0, attemptedCount - approvedCount);

      let message = `Order ${orderId} has been cancelled.`;
      if (attemptedCount > 0) {
        if (approvedCount > 0) {
          message += ` ${approvedCount} shipping label${approvedCount === 1 ? '' : 's'} voided successfully.`;
        }
        if (deniedCount > 0) {
          message += ` ${deniedCount} label${deniedCount === 1 ? '' : 's'} could not be voided automatically.`;
        }
      } else if (shouldVoidLabels) {
        message += ' No active shipping labels required voiding.';
      }

      res.json({
        message,
        order: updatedOrder,
        voidResults,
      });
    } catch (error) {
      console.error('Error cancelling order:', error);
      const message = typeof error?.message === 'string' ? error.message : 'Failed to cancel order';
      const statusCode = message.includes('only available') ? 400 : 500;
      res.status(statusCode).json({ error: message });
    }
  });

  router.post('/accept-offer-action', async (req, res) => {
    try {
      const { orderId } = req.body;
      if (!orderId) {
        return res.status(400).json({ error: 'Order ID is required' });
      }
      const docRef = ordersCollection.doc(orderId);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const orderData = { id: doc.id, ...doc.data() };
      if (orderData.status !== 're-offered-pending') {
        return res
          .status(409)
          .json({ error: 'This offer has already been accepted or declined.' });
      }

      await updateOrderBoth(orderId, {
        status: 're-offered-accepted',
        acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {
        existingOrder: orderData,
        skipReload: true,
      });

      const customerHtmlBody = `
      <p>Thank you for accepting the revised offer for Order <strong>#${orderData.id}</strong>.</p>
      <p>We've received your confirmation, and payment processing will now begin.</p>
    `;

      await sendMailWithFallback({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to: orderData.shippingInfo.email,
        subject: `Offer Accepted for Order #${orderData.id}`,
        html: customerHtmlBody,
      });

      await recordCustomerEmail(
        orderId,
        'Re-offer acceptance confirmation email sent to customer.',
        { status: 're-offered-accepted' }
      );

      res.json({ message: 'Offer accepted successfully.', orderId: orderData.id });
    } catch (err) {
      console.error('Error accepting offer:', err);
      res.status(500).json({ error: 'Failed to accept offer' });
    }
  });

  router.post('/return-phone-action', async (req, res) => {
    try {
      const { orderId } = req.body;
      if (!orderId) {
        return res.status(400).json({ error: 'Order ID is required' });
      }
      const docRef = ordersCollection.doc(orderId);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const orderData = { id: doc.id, ...doc.data() };
      if (orderData.status !== 're-offered-pending') {
        return res
          .status(409)
          .json({ error: 'This offer has already been accepted or declined.' });
      }

      await updateOrderBoth(orderId, {
        status: 're-offered-declined',
        declinedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {
        existingOrder: orderData,
        skipReload: true,
      });

      const customerHtmlBody = `
      <p>We have received your request to decline the revised offer and have your device returned. We are now processing your request and will send a return shipping label to your email shortly.</p>
    `;

      await sendMailWithFallback({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to: orderData.shippingInfo.email,
        subject: `Return Requested for Order #${orderData.id}`,
        html: customerHtmlBody,
      });

      await recordCustomerEmail(
        orderId,
        'Return request confirmation email sent to customer.',
        { status: 're-offered-declined' }
      );

      res.json({ message: 'Return requested successfully.', orderId: orderData.id });
    } catch (err) {
      console.error('Error requesting return:', err);
      res.status(500).json({ error: 'Failed to request return' });
    }
  });

  router.delete('/orders/:id', async (req, res) => {
    try {
      const orderId = req.params.id;
      const orderRef = ordersCollection.doc(orderId);
      const orderDoc = await orderRef.get();

      if (!orderDoc.exists) {
        return res.status(404).json({ error: 'Order not found.' });
      }

      const orderData = orderDoc.data();
      const userId = orderData.userId;

      await orderRef.delete();

      if (userId) {
        const userOrderRef = usersCollection.doc(userId).collection('orders').doc(orderId);
        await userOrderRef.delete();
      }

      res.status(200).json({ message: `Order ${orderId} deleted successfully.` });
    } catch (err) {
      console.error('Error deleting order:', err);
      res.status(500).json({ error: 'Failed to delete order.' });
    }
  });

  return {
    router,
    refreshKitTrackingById,
    refreshEmailLabelTrackingById,
  };
};
