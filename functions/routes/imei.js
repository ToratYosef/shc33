const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { updateOrderBoth } = require('../db/db');
const { sendEmail } = require('../services/notifications');
const { BLACKLISTED_EMAIL_HTML } = require('../helpers/templates');
const functions = require('firebase-functions');
const {
    checkEsn,
    checkCarrierLock,
    checkSamsungCarrierInfo,
    isAppleDeviceHint,
    isSamsungDeviceHint,
} = require('../services/phonecheck');

// NEW ENDPOINT for IMEI/ESN Check
router.post('/check-esn', async (req, res) => {
    const {
        imei,
        orderId,
        customerName,
        customerEmail,
        carrier,
        deviceType,
        brand,
        checkAll,
    } = req.body || {};

    if (!imei || !orderId) {
        return res.status(400).json({ error: 'IMEI and Order ID are required.' });
    }

    try {
        let checkAllFlag = false;
        if (typeof checkAll === 'boolean') {
            checkAllFlag = checkAll;
        } else if (typeof checkAll === 'number') {
            checkAllFlag = checkAll !== 0;
        } else if (typeof checkAll === 'string') {
            checkAllFlag = ['1', 'true', 'yes'].includes(checkAll.trim().toLowerCase());
        }

        const trimmedImei = String(imei).trim();
        const esnResult = await checkEsn({
            imei: trimmedImei,
            carrier,
            deviceType,
            brand,
            checkAll: checkAllFlag,
        });

        let carrierLockResult = null;
        const appleHintValues = [
            brand,
            deviceType,
            esnResult?.normalized?.brand,
            esnResult?.normalized?.model,
            esnResult?.normalized?.deviceName,
        ];

        if (isAppleDeviceHint(...appleHintValues)) {
            try {
                carrierLockResult = await checkCarrierLock({
                    imei: trimmedImei,
                    deviceType: 'Apple',
                });
            } catch (carrierError) {
                console.error(`Carrier lock lookup failed for order ${orderId}:`, carrierError);
            }
        }

        let samsungCarrierInfoResult = null;
        const samsungHintValues = [
            brand,
            deviceType,
            esnResult?.normalized?.brand,
            esnResult?.normalized?.model,
            esnResult?.normalized?.deviceName,
        ];

        if (isSamsungDeviceHint(...samsungHintValues)) {
            try {
                samsungCarrierInfoResult = await checkSamsungCarrierInfo({
                    identifier: trimmedImei,
                });
            } catch (samsungError) {
                console.error(`Samsung carrier info lookup failed for order ${orderId}:`, samsungError);
            }
        }

        const normalized = {
            ...(carrierLockResult?.normalized || {}),
            ...esnResult.normalized,
        };

        if (samsungCarrierInfoResult?.normalized) {
            normalized.samsungCarrierInfo = samsungCarrierInfoResult.normalized;

            if (!normalized.model && samsungCarrierInfoResult.normalized.modelDescription) {
                normalized.model = samsungCarrierInfoResult.normalized.modelDescription;
            }
            if (!normalized.modelNumber && samsungCarrierInfoResult.normalized.modelNumber) {
                normalized.modelNumber = samsungCarrierInfoResult.normalized.modelNumber;
            }
            if (!normalized.carrier && samsungCarrierInfoResult.normalized.carrier) {
                normalized.carrier = samsungCarrierInfoResult.normalized.carrier;
            }
            if (!normalized.warrantyStatus && samsungCarrierInfoResult.normalized.warranty) {
                normalized.warrantyStatus = samsungCarrierInfoResult.normalized.warranty;
            }
        }

        const rawResponses = { esn: esnResult.raw };
        if (carrierLockResult) {
            rawResponses.carrierLock = carrierLockResult.raw;
        }
        if (samsungCarrierInfoResult) {
            rawResponses.samsungCarrier = samsungCarrierInfoResult.raw;
        }
        normalized.raw = rawResponses;

        const updateData = {
            imei: String(imei).trim(),
            imeiChecked: true,
            imeiCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            imeiCheckResult: normalized,
            fulfilledOrders: {
                imei: String(imei).trim(),
                rawResponse: esnResult.raw,
            },
        };

        if (typeof normalized.blacklisted === 'boolean') {
            updateData.status = normalized.blacklisted ? 'blacklisted' : 'imei_checked';
        }

        await updateOrderBoth(orderId, updateData);

        if (normalized.blacklisted && customerEmail) {
            const statusReason = normalized.summary || normalized.remarks || 'Blacklisted';
            const blacklistEmailHtml = BLACKLISTED_EMAIL_HTML
                .replace(/\*\*CUSTOMER_NAME\*\*/g, customerName || 'Customer')
                .replace(/\*\*ORDER_ID\*\*/g, orderId)
                .replace(/\*\*STATUS_REASON\*\*/g, statusReason);

            const mailOptions = {
                from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
                to: customerEmail,
                subject: `Important Notice Regarding Your Device for Order #${orderId}`,
                html: blacklistEmailHtml,
            };

            try {
                await sendEmail(mailOptions);
            } catch (emailError) {
                console.error(`Failed to send blacklist notification for order ${orderId}:`, emailError);
            }
        }

        res.json(normalized);
    } catch (error) {
        console.error('Error during IMEI check:', error);
        if (error.code && typeof error.code === 'string' && error.code.startsWith('phonecheck/')) {
            const statusCode = typeof error.status === 'number' ? error.status : 502;
            return res.status(statusCode >= 400 ? statusCode : 502).json({ error: error.message || 'Phonecheck IMEI lookup failed.' });
        }
        res.status(500).json({ error: 'Failed to perform IMEI check.' });
    }
});

module.exports = router;
