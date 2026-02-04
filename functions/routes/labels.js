const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { getStorage } = require('firebase-admin/storage');
const { getFirestore } = require('firebase-admin/firestore');
const { createShipStationLabel } = require('../services/shipstation');
const { sendZendeskComment } = require('../services/zendesk');
const { sendEmail } = require('../services/notifications');
const { ordersCollection, usersCollection, updateOrderBoth } = require('../helpers/db');
const { generateCustomLabelPdf } = require('../helpers/pdf');
const { SHIPPING_LABEL_EMAIL_HTML, SHIPPING_KIT_EMAIL_HTML } = require('../helpers/templates');
const functions = require('firebase-functions');
const db = getFirestore();
const storage = getStorage();
const { DEFAULT_CARRIER_CODE } = require('../helpers/shipengine');

// Generate initial shipping label(s) and send email to buyer
router.post("/generate-label/:id", async (req, res) => {
    try {
        const doc = await ordersCollection.doc(req.params.id).get();
        if (!doc.exists) return res.status(404).json({ error: "Order not found" });

        const order = { id: doc.id, ...doc.data() };
        const buyerShippingInfo = order.shippingInfo;
        const weightInOunces = 1; // Default to 1 ounce

        const swiftBuyBackAddress = {
            name: "SHC Returns",
            company: "SecondHandCell",
            phone: "555-555-5555",
            street1: "1602 McDonald Ave Ste Rear",
            street2: "(24th Ave Entrance)",
            city: "Brooklyn",
            state: "NY",
            postalCode: "11223",
            country: "US",
        };

        const buyerAddress = {
            name: buyerShippingInfo.fullName,
            phone: "555-555-5555",
            street1: buyerShippingInfo.streetAddress,
            street2: "", // Added to match ShipStation API schema
            city: buyerShippingInfo.city,
            state: buyerShippingInfo.state,
            postalCode: buyerShippingInfo.zipCode,
            country: "US",
        };

        const timestamp = admin.firestore.FieldValue.serverTimestamp();
        let updateData = { status: "label_generated" };
        const logEntries = [];
        let internalHtmlBody = "";
        let customerEmailSubject = "";
        let customerMailOptions;
        let mainLabelData, mainTrackingNumber, outboundLabelData, inboundLabelData;
        let customerLabelPdfBuffer;

        if (order.shippingPreference === "Shipping Kit Requested") {
            [outboundLabelData, inboundLabelData] = await Promise.all([
                createShipStationLabel(
                    swiftBuyBackAddress,
                    buyerAddress,
                    "stamps_com", // Corrected Carrier Code
                    "usps_ground_advantage", // Service Code
                    "package", // Package Code
                    weightInOunces,
                    false, // testLabel
                    order.id // Pass the order ID
                ),
                createShipStationLabel(
                    buyerAddress,
                    swiftBuyBackAddress,
                    "stamps_com", // Corrected Carrier Code
                    "usps_ground_advantage",
                    "package",
                    weightInOunces,
                    false, // testLabel
                    order.id // Pass the order ID
                )
            ]);
            
            // Upload both labels to storage
            const [outboundLabelUrl, inboundLabelUrl] = await Promise.all([
                uploadLabelToCloudStorage(`outbound-${order.id}`, outboundLabelData.labelData),
                uploadLabelToCloudStorage(`inbound-${order.id}`, inboundLabelData.labelData)
            ]);

            mainLabelData = inboundLabelData.labelData;
            mainTrackingNumber = inboundLabelData.trackingNumber;

            const outboundCarrierCode =
                outboundLabelData?.carrierCode ||
                outboundLabelData?.carrier_code ||
                DEFAULT_CARRIER_CODE;
            const inboundCarrierCode =
                inboundLabelData?.carrierCode || inboundLabelData?.carrier_code || DEFAULT_CARRIER_CODE;

            updateData = {
                ...updateData,
                outboundLabelUrl: outboundLabelUrl, // Save URL for outbound label
                inboundLabelUrl: inboundLabelUrl, // Save URL for inbound label
                outboundTrackingNumber: outboundLabelData.trackingNumber,
                inboundTrackingNumber: inboundLabelData.trackingNumber,
                trackingNumber: inboundLabelData.trackingNumber, // Set primary tracking for simplicity
                outboundCarrierCode,
                inboundCarrierCode,
                kitLabelGeneratedAt: timestamp,
                labelDeliveryMethod: 'kit',
            };

            logEntries.push({
                type: 'label',
                message: 'Shipping kit labels generated and emailed to customer',
                metadata: {
                    outboundTrackingNumber: outboundLabelData.trackingNumber || null,
                    inboundTrackingNumber: inboundLabelData.trackingNumber || null,
                },
            });

            customerEmailSubject = `Your SecondHandCell Shipping Kit for Order #${order.id} is on its Way!`;
            const customerEmailHtml = SHIPPING_KIT_EMAIL_HTML
                .replace(/\*\*CUSTOMER_NAME\*\*/g, order.shippingInfo.fullName)
                .replace(/\*\*ORDER_ID\*\*/g, order.id)
                .replace(/\*\*TRACKING_NUMBER\*\*/g, outboundLabelData.trackingNumber || "N/A")
                .replace(/\*\*LABEL_DOWNLOAD_LINK\*\*/g, outboundLabelUrl); // Use outbound URL for customer email
                
            customerMailOptions = {
                from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
                to: order.shippingInfo.email,
                subject: customerEmailSubject,
                html: customerEmailHtml,
            };

            internalHtmlBody = `
                <p><strong>Shipping Kit Order:</strong> Labels generated for Order <strong>#${order.id}</strong>.</p>
                <p><strong>Outbound Kit Label (SHC -> Customer):</strong></p>
                <ul>
                    <li>Tracking: <strong>${outboundLabelData.trackingNumber || "N/A"}</strong></li>
                </ul>
                <p><strong>Inbound Device Label (Customer -> SHC):</strong></p>
                <ul>
                    <li>Tracking: <strong>${inboundLabelData.trackingNumber || "N/A"}</strong></li>
                </ul>
                <p>The outbound kit tracking has been sent to the customer. Awaiting inbound shipment.</p>
            `;

        } else if (order.shippingPreference === "Email Label Requested") {
            const customerLabelData = await createShipStationLabel(
                buyerAddress,
                swiftBuyBackAddress,
                "stamps_com", // Corrected Carrier Code
                "usps_ground_advantage",
                "package",
                weightInOunces,
                false, // testLabel
                order.id // Pass the order ID
            );
            
            mainLabelData = customerLabelData.labelData;
            mainTrackingNumber = customerLabelData.trackingNumber;
            customerLabelPdfBuffer = await generateCustomLabelPdf(order);

            const uspsLabelUrl = await uploadLabelToCloudStorage(order.id, mainLabelData);

            const labelCarrierCode =
                mainLabelData.carrier_code ||
                mainLabelData.carrierCode ||
                DEFAULT_CARRIER_CODE;

            updateData = {
                ...updateData,
                trackingNumber: mainTrackingNumber,
                uspsLabelUrl: uspsLabelUrl,
                emailedAt: timestamp,
                labelDeliveryMethod: 'email',
                labelTrackingCarrierCode: labelCarrierCode,
                labelTrackingStatus: mainLabelData.status_code || mainLabelData.statusCode || 'LABEL_CREATED',
                labelTrackingStatusDescription: mainLabelData.status_description || mainLabelData.statusDescription || 'Label created',
                labelTrackingCarrierStatusCode: mainLabelData.carrier_status_code || mainLabelData.carrierStatusCode || null,
                labelTrackingCarrierStatusDescription: mainLabelData.carrier_status_description || mainLabelData.carrierStatusDescription || null,
                labelTrackingLastSyncedAt: timestamp,
            };

            logEntries.push({
                type: 'label',
                message: 'Shipping label emailed to customer',
                metadata: {
                    trackingNumber: mainTrackingNumber || null,
                    deliveryMethod: 'email',
                },
            });

            customerEmailSubject = `Your SecondHandCell Shipping Label for Order #${order.id}`;
            const customerEmailHtml = SHIPPING_LABEL_EMAIL_HTML
                .replace(/\*\*CUSTOMER_NAME\*\*/g, order.shippingInfo.fullName)
                .replace(/\*\*ORDER_ID\*\*/g, order.id)
                .replace(/\*\*TRACKING_NUMBER\*\*/g, mainTrackingNumber || "N/A")
                .replace(/\*\*LABEL_DOWNLOAD_LINK\*\*/g, uspsLabelUrl);

            customerMailOptions = {
                from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
                to: order.shippingInfo.email,
                subject: customerEmailSubject,
                html: customerEmailHtml,
                attachments: [{
                    filename: `SecondHandCell-InternalLabel-${order.id}.pdf`,
                    content: customerLabelPdfBuffer,
                    contentType: 'application/pdf',
                }],
            };

            internalHtmlBody = `
                <p>The shipping label for Order <strong>#${order.id}</strong> (email label option) has been successfully generated and sent to the customer.</p>
                <p>Tracking Number: <strong>${mainTrackingNumber || "N/A"}</strong></p>
                <p>A custom internal label has also been generated and attached to the email for the customer to place on the device bag.</p>
            `;
        } else {
            throw new Error(`Unknown shipping preference: ${order.shippingPreference}`);
        }

        await updateOrderBoth(req.params.id, updateData, { logEntries });

        await Promise.all([
            sendEmail(customerMailOptions),
            sendZendeskComment(order, `Shipping Label Generated for Order #${order.id}`, internalHtmlBody, false),
        ]);

        res.json({ message: "Label(s) generated successfully", orderId: order.id, trackingNumber: mainTrackingNumber });
    } catch (err) {
        console.error("Error generating label:", err.response?.data || err.message || err);
        res.status(500).json({ error: "Failed to generate label" });
    }
});

router.post("/orders/:id/return-label", async (req, res) => {
    try {
        const doc = await ordersCollection.doc(req.params.id).get();
        if (!doc.exists) return res.status(404).json({ error: "Order not found" });
        const order = { id: doc.id, ...doc.data() };

        const seccondHandCellAddress = {
            name: "SHC Returns",
            company: "SecondHandCell",
            phone: "555-555-5555",
            street1: "1602 McDonald Ave Ste Rear",
            street2: "(24th Ave Entrance)",
            city: "Brooklyn",
            state: "NY",
            postalCode: "11223",
            country: "US",
        };

        const buyerShippingInfo = order.shippingInfo;
        const buyerAddress = {
            name: buyerShippingInfo.fullName,
            phone: "555-555-5555",
            street1: buyerShippingInfo.streetAddress,
            street2: "",
            city: buyerShippingInfo.city,
            state: buyerShippingInfo.state,
            postalCode: buyerShippingInfo.zipCode,
            country: "US",
        };

        const returnLabelData = await createShipStationLabel(
            seccondHandCellAddress,
            buyerAddress,
            "stamps_com", // Corrected carrier code
            "usps_ground_advantage",
            "package",
            1,
            false, // testLabel
            order.id // Pass the order ID
        );

        const returnTrackingNumber = returnLabelData.trackingNumber;
        const returnLabelUrl = await uploadLabelToCloudStorage(`return-${order.id}`, returnLabelData.labelData);

        await updateOrderBoth(req.params.id, {
            status: "return-label-generated",
            returnLabelUrl: returnLabelUrl,
            returnTrackingNumber: returnTrackingNumber,
        });

        const customerMailOptions = {
            from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
            to: order.shippingInfo.email,
            subject: "Your SecondHandCell Return Label",
            html: `
                <p>Hello ${order.shippingInfo.fullName},</p>
                <p>As requested, here is your return shipping label for your device (Order ID: ${order.id}):</p>
                <p>Return Tracking Number: <strong>${returnTrackingNumber || "N/A"}</strong></p>
                <p>Please open the attached PDF to download and print your label.</p>
                <p>Thank you,</p>
                <p>The SecondHandCell Team</p>
            `,
            attachments: [{
                filename: `SecondHandCell-ReturnLabel-${order.id}.pdf`,
                content: Buffer.from(returnLabelData.labelData, 'base64'),
                contentType: 'application/pdf',
            }],
        };

        const internalSubject = `Return Label Sent for Order #${order.id}`;
        const internalHtmlBody = `<p>A return label for Order <strong>#${order.id}</strong> has been generated and sent to the customer.</p><p>Return Tracking Number: <strong>${returnTrackingNumber || "N/A"}</strong></p>`;

        await Promise.all([
            sendEmail(customerMailOptions),
            sendZendeskComment(order, internalSubject, internalHtmlBody, false),
        ]);

        res.json({
            message: "Return label generated successfully.",
            labelUrl: returnLabelUrl,
            trackingNumber: returnTrackingNumber,
            orderId: order.id,
        });
    } catch (err) {
        console.error("Error generating return label:", err.response?.data || err);
        res.status(500).json({ error: "Failed to generate return label" });
    }
});

// Helper function to upload the base64 label data to Cloud Storage
async function uploadLabelToCloudStorage(id, base64Data) {
    const bucket = storage.bucket('your-firebase-project-id.appspot.com');
    const fileName = `shipping-labels/${id}.pdf`;
    const file = bucket.file(fileName);

    await file.save(Buffer.from(base64Data, 'base64'), {
        metadata: { contentType: 'application/pdf' },
    });

    await file.makePublic();

    return `https://storage.googleapis.com/${bucket.name}/${fileName}`;
}

module.exports = router;