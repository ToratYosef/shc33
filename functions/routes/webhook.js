const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { ordersCollection, updateOrderBoth } = require('../db/db');
const functions = require('firebase-functions');
const { info, error } = require('firebase-functions/logger');

// Middleware to verify ShipStation webhook signature
const verifyShipStationSignature = (req, res, next) => {
    const signature = req.headers['x-shipstation-signature'];
    const secret = functions.config().shipstation.webhook_secret;

    if (!signature) {
        error('Webhook received without signature header.');
        return res.status(401).send('Unauthorized: Signature missing.');
    }

    try {
        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(JSON.stringify(req.body));
        const calculatedSignature = hmac.digest('base64');

        if (calculatedSignature !== signature) {
            error('Invalid ShipStation webhook signature.');
            return res.status(401).send('Unauthorized: Invalid signature.');
        }
    } catch (err) {
        error('Error verifying ShipStation signature:', err);
        return res.status(500).send('Internal Server Error.');
    }
    next();
};

// ShipStation Webhook Endpoint
router.post('/webhook/shipstation', verifyShipStationSignature, async (req, res) => {
    try {
        const event = req.body;
        info('Received ShipStation webhook event:', event);

        // Find the order using the tracking number
        const trackingNumber = event.resource_url.split('/')[4];
        const snapshot = await ordersCollection.where('trackingNumber', '==', trackingNumber).limit(1).get();

        if (snapshot.empty) {
            info('Order not found for tracking number:', trackingNumber);
            return res.status(404).send('Order not found');
        }

        const orderDoc = snapshot.docs[0];
        const orderId = orderDoc.id;
        let newStatus = '';
        let updateData = {};

        switch (event.event_type) {
            case 'SHIPMENT_SHIPPED':
            case 'SHIPMENT_TRACKING':
                newStatus = 'in_transit';
                break;
            case 'SHIPMENT_DELIVERED':
                newStatus = 'delivered';
                break;
            case 'SHIPMENT_VOIDED':
                newStatus = 'voided';
                break;
            default:
                info('Ignoring unknown event type:', event.event_type);
                return res.status(200).send('Ignored');
        }
        
        // Update Firestore
        if (newStatus) {
            updateData.status = newStatus;
            await updateOrderBoth(orderId, updateData);
        }

        res.status(200).send('Webhook received successfully');
    } catch (err) {
        error('Error processing ShipStation webhook:', err);
        res.status(500).send('Failed to process webhook');
    }
});

module.exports = router;
