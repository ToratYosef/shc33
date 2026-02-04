const express = require('express');
const router = express.Router();
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const axios = require('axios');
const { URLSearchParams } = require('url');
const { DEFAULT_CARRIER_CODE } = require('../helpers/shipengine');

// RESTORE FIX: Ensure app is initialized before using 'admin.firestore()'
if (admin.apps.length === 0) {
    admin.initializeApp();
}

const db = admin.firestore(); 
const inventoryCollection = db.collection('wholesaleInventory');
const ordersCollection = db.collection('wholesaleOrders');
const offersCollection = db.collection('wholesaleOffers');
const adminsCollection = db.collection('admins');

const STRIPE_API_BASE_URL = 'https://api.stripe.com/v1';
const SHIPENGINE_API_BASE_URL = 'https://api.shipengine.com/v1';
const DEFAULT_IMAGE_BASE = 'https://raw.githubusercontent.com/toratyosef/BuyBacking/main/';
const DEFAULT_SUCCESS_URL = 'https://secondhandcell.com/buy/order-submitted.html?order={ORDER_ID}';
const DEFAULT_CANCEL_URL = 'https://secondhandcell.com/buy/checkout.html?offer={OFFER_ID}';

// Initialize Stripe Library (must be done after key retrieval functions are defined)
let stripe;
function initializeStripe() {
    const secretKey = getStripeSecretKey();
    if (secretKey && !stripe) {
        try {
            // NOTE: In a real project, you would 'npm install stripe' and then require it here.
            const Stripe = require('stripe');
            stripe = Stripe(secretKey, {
                apiVersion: '2020-08-27', // Use a stable API version
            });
        } catch (e) {
            console.error("Stripe library failed to load or initialize:", e);
        }
    }
}


function readConfigValue(path, fallback = null) {
    try {
        return path.split('.').reduce((current, key) => {
            if (current && Object.prototype.hasOwnProperty.call(current, key)) {
                return current[key];
            }
            return undefined;
        }, functions.config()) ?? fallback;
    } catch (error) {
        return fallback;
    }
}

function getStripeSecretKey() {
    return (
        readConfigValue('stripe.secret') ||
        process.env.STRIPE_SECRET_KEY ||
        process.env.STRIPE_SECRET
    );
}

function getStripePublishableKey() {
    return (
        readConfigValue('stripe.publishable') ||
        process.env.STRIPE_PUBLISHABLE_KEY ||
        process.env.STRIPE_PUBLIC_KEY
    );
}

function getStripeWebhookSecret() {
    // Fetches the Stripe Webhook Secret from environment/config
    // The user MUST set this in their Firebase Environment config or .env file
    return (
        readConfigValue('stripe.webhook_secret') ||
        process.env.STRIPE_WEBHOOK_SECRET
    );
}

function getShipEngineKey() {
    return (
        readConfigValue('shipengine.key') ||
        process.env.SHIPENGINE_KEY_TEST
    );
}

function getShipEngineCarrierCode() {
    return (
        readConfigValue('shipengine.sandbox_carrier_code') ||
        process.env.SHIPENGINE_SANDBOX_CARRIER_CODE ||
        DEFAULT_CARRIER_CODE
    );
}

function getShipEngineServiceCode() {
    return (
        readConfigValue('shipengine.sandbox_service_code') ||
        process.env.SHIPENGINE_SANDBOX_SERVICE_CODE ||
        null
    );
}

function getShipFromAddress() {
    const configured = readConfigValue('shipengine.from');
    if (configured && typeof configured === 'object') {
        return configured;
    }
    return {
        name: process.env.SHIPENGINE_FROM_NAME || 'SecondHandCell Warehouse',
        phone: process.env.SHIPENGINE_FROM_PHONE || '2015551234',
        company_name: process.env.SHIPENGINE_FROM_COMPANY || 'SecondHandCell',
        address_line1: process.env.SHIPENGINE_FROM_ADDRESS1 || '1206 McDonald Ave',
        address_line2: process.env.SHIPENGINE_FROM_ADDRESS2 || 'Ste Rear',
        city_locality: process.env.SHIPENGINE_FROM_CITY || 'Brooklyn',
        state_province: process.env.SHIPENGINE_FROM_STATE || 'NY',
        postal_code: process.env.SHIPENGINE_FROM_POSTAL || '11230',
        country_code: process.env.SHIPENGINE_FROM_COUNTRY || 'US'
    };
}

function slugify(value) {
    return value
        .toString()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

async function authenticate(req) {
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.*)$/i);
    if (!match) {
        return null;
    }
    try {
        const decoded = await admin.auth().verifyIdToken(match[1]);
        return decoded;
    } catch (error) {
        console.warn('Failed to verify ID token for wholesale route:', error.message);
        return null;
    }
}

async function requireAdmin(req) {
    const bypassToken =
        readConfigValue('wholesale.admin_token') || process.env.WHOLESALE_ADMIN_TOKEN || null;
    if (bypassToken && req.headers['x-admin-token'] === bypassToken) {
        return { uid: 'token-bypass' };
    }
    const decoded = await authenticate(req);
    if (!decoded?.uid) {
        return null;
    }
    try {
        const adminDoc = await adminsCollection.doc(decoded.uid).get();
        if (!adminDoc.exists) {
            return null;
        }
        return decoded;
    } catch (error) {
        console.error('Error verifying admin membership:', error);
        return null;
    }
}

function normalizeInventoryItem(raw = {}, imageBasePath = DEFAULT_IMAGE_BASE) {
    const brand = (raw.brand || '').toString().trim();
    const model = (raw.model || '').toString().trim();
    const id = raw.id || slugify(`${brand}-${model}` || `device-${Date.now()}`);
    const highlights = Array.isArray(raw.highlights) ? raw.highlights.map((entry) => entry.toString()) : [];
    const storages = Array.isArray(raw.storages)
        ? raw.storages.map((variant, index) => ({
              variant: variant.variant || `Variant ${index + 1}`,
              asking: variant.asking || {},
              stock: variant.stock || {}
          }))
        : [];
    const image = raw.image || (raw.imagePath ? `${imageBasePath}${raw.imagePath}` : null);

    return {
        id,
        brand,
        model,
        tagline: raw.tagline || '',
        image,
        highlights,
        storages
    };
}

function buildPackageList({ boxCount, weightPerBox, dimensions }) {
    const count = Number(boxCount) || 1;
    const weight = Number(weightPerBox) || 1;
    const dims = dimensions || {};
    const length = Number(dims.length) || 12;
    const width = Number(dims.width) || 10;
    const height = Number(dims.height) || 8;
    return Array.from({ length: Math.max(count, 1) }).map(() => ({
        weight: { value: weight, unit: 'pound' },
        dimensions: {
            length,
            width,
            height,
            unit: 'inch'
        }
    }));
}

async function estimateShippingRate(shipping, packages) {
    const key = getShipEngineKey();
    if (!key || !shipping || shipping.preference === 'pickup') {
        return null;
    }
    const carrierCode = getShipEngineCarrierCode();
    const serviceCode = getShipEngineServiceCode();
    try {
        const response = await axios.post(
            `${SHIPENGINE_API_BASE_URL}/rates/estimate`,
            {
                carrier_code: carrierCode,
                service_code: serviceCode || undefined,
                ship_to: {
                    name: shipping.contact?.name || shipping.company || 'Wholesale Buyer',
                    phone: shipping.contact?.phone || shipping.phone || '0000000000',
                    company_name: shipping.company || shipping.contact?.company || 'Wholesale Buyer',
                    address_line1: shipping.address?.line1,
                    address_line2: shipping.address?.line2 || undefined,
                    city_locality: shipping.address?.city,
                    state_province: shipping.address?.state,
                    postal_code: shipping.address?.postalCode,
                    country_code: shipping.address?.country || 'US'
                },
                ship_from: getShipFromAddress(),
                packages
            },
            {
                headers: {
                    'API-Key': key,
                    'Content-Type': 'application/json'
                },
                timeout: 20000
            }
        );
        const data = response.data;
        if (Array.isArray(data) && data.length) {
            return data[0];
        }
        return data || null;
    } catch (error) {
        console.error('ShipEngine estimate failed:', error.response?.data || error.message);
        return null;
    }
}

// ----------------------------------------------------
// NEW FUNCTION: Create a Payment Intent for on-page payment
// ----------------------------------------------------
async function createStripePaymentIntent({
    orderId,
    offerId,
    buyer,
    totalAmount,
    shippingAmount,
    currency = 'usd',
    metadata = {}
}) {
    const secretKey = getStripeSecretKey();
    if (!secretKey) {
        throw new Error('Stripe secret key not configured');
    }

    // Stripe uses the smallest currency unit (cents)
    const totalAmountInCents = Math.max(Math.round((totalAmount + shippingAmount) * 100), 50); 
    
    // Set up form data for application/x-www-form-urlencoded
    const params = new URLSearchParams();
    params.append('amount', totalAmountInCents.toString());
    params.append('currency', currency);
    params.append('payment_method_types[]', 'card'); // Allow card payments
    
    // Optional: Add buyer email as description or setup future customer object
    if (buyer?.email) {
        params.append('description', `Wholesale Order ${orderId} from ${buyer.email}`);
    }

    // Add metadata for tracking
    params.append('metadata[order_id]', orderId);
    params.append('metadata[offer_id]', offerId);
    params.append('metadata[user_id]', buyer?.uid || '');
    
    Object.entries(metadata).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        params.append(`metadata[${key}]`, value.toString());
    });
    
    const response = await axios.post(`${STRIPE_API_BASE_URL}/payment_intents`, params, {
        headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });

    return response.data; // Includes the client_secret
}
// ----------------------------------------------------

router.get('/inventory', async (req, res) => {
    try {
        const snapshot = await inventoryCollection.orderBy('brand').get();
        const items = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        res.json({ items, imageBase: DEFAULT_IMAGE_BASE, publishableKey: getStripePublishableKey() });
    } catch (error) {
        console.error('Failed to load wholesale inventory:', error);
        res.status(500).json({ error: 'Failed to load wholesale inventory' });
    }
});

router.post('/inventory/import', async (req, res) => {
    const adminUser = await requireAdmin(req);
    if (!adminUser) {
        return res.status(403).json({ error: 'Admin authentication required' });
    }
    const { items = [], imageBasePath } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'Provide an array of inventory items' });
    }
    const imageBase = imageBasePath || DEFAULT_IMAGE_BASE;
    const batch = db.batch();
    const normalizedItems = items.map((item) => normalizeInventoryItem(item, imageBase));
    normalizedItems.forEach((item) => {
        const docRef = inventoryCollection.doc(item.id);
        batch.set(docRef, item, { merge: true });
    });
    try {
        await batch.commit();
        res.json({ message: 'Inventory imported', items: normalizedItems });
    } catch (error) {
        console.error('Failed to import inventory:', error);
        res.status(500).json({ error: 'Failed to import inventory' });
    }
});

// MODIFIED ROUTE: Creates a Payment Intent instead of a Checkout Session
router.post('/orders/checkout', async (req, res) => {
    const decoded = await authenticate(req);
    if (!decoded?.uid) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const payload = req.body || {};
    const { offerId, items, totals, shipping, buyer } = payload;
    if (!offerId || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'Offer details are required' });
    }
    if (!shipping || !shipping.address) {
        return res.status(400).json({ error: 'Shipping details are required' });
    }

    const packages = buildPackageList({
        boxCount: shipping.boxCount,
        weightPerBox: shipping.weightPerBox,
        dimensions: shipping.dimensions
    });

    const shippingEstimate = await estimateShippingRate(shipping, packages);
    const shippingAmount = shippingEstimate?.shipping_amount?.amount || 0;

    const offerTotal = totals?.offerTotal || items.reduce((sum, line) => {
        const price = Number(line.acceptedPrice || line.counterPrice || line.offerPrice || 0);
        return sum + price * (Number(line.quantity) || 0);
    }, 0);
    
    const finalTotal = offerTotal + shippingAmount;

    const orderRef = ordersCollection.doc();
    const orderId = orderRef.id;

    try {
        const paymentIntent = await createStripePaymentIntent({
            orderId,
            offerId,
            buyer: {
                uid: decoded.uid,
                email: buyer?.email || decoded.email || '',
                name: buyer?.name || decoded.name || ''
            },
            totalAmount: offerTotal,
            shippingAmount: shippingAmount,
            metadata: {
                shipping_preference: shipping.preference || '',
                box_count: shipping.boxCount || '',
                weight_per_box: shipping.weightPerBox || ''
            }
        });

        await orderRef.set({
            offerId,
            userId: decoded.uid,
            buyer: {
                uid: decoded.uid,
                email: buyer?.email || decoded.email || '',
                name: buyer?.name || decoded.name || ''
            },
            items,
            totals: {
                units: totals?.units || items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
                offerTotal,
                shippingEstimate: shippingAmount,
                finalTotal: finalTotal // Store the final amount including shipping
            },
            shipping,
            packages,
            shippingEstimate,
            stripe: {
                paymentIntentId: paymentIntent.id,
                clientSecret: paymentIntent.client_secret, // CRITICAL: Store and return the client_secret
                publishableKey: getStripePublishableKey()
            },
            status: 'payment_pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (payload.saveOfferSnapshot) {
            // Update the offer document with the Payment Intent info, especially the clientSecret
            await offersCollection.doc(offerId).set({
                ...payload.saveOfferSnapshot,
                userId: decoded.uid,
                orderId,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                payment: {
                    orderId: orderId,
                    clientSecret: paymentIntent.client_secret,
                    publishableKey: getStripePublishableKey(),
                    shippingEstimate: shippingEstimate,
                    boxCount: shipping.boxCount,
                    totalAmount: finalTotal // Total amount client should see
                }
            }, { merge: true });
        }

        // Return clientSecret, totalAmount, and publishableKey for the Payment Element to initialize
        res.json({
            orderId,
            clientSecret: paymentIntent.client_secret,
            shippingEstimate,
            totalAmount: finalTotal, // ADDED to return the calculated total
            publishableKey: getStripePublishableKey()
        });
    } catch (error) {
        console.error('Failed to create payment intent:', error.response?.data || error.message);
        res.status(500).json({ error: 'Unable to create Stripe Payment Intent' });
    }
});

// NEW ROUTE: Stripe Webhook Handler
// This must be placed before any body-parsing middleware in the main app file
// BUT since this is a router, we use express.raw to ensure raw body is accessible.
router.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    // initialize Stripe library for this request
    initializeStripe(); 
    
    const signature = req.headers['stripe-signature'];
    const webhookSecret = getStripeWebhookSecret();
    let event;

    if (!stripe || !webhookSecret) {
        console.error("Stripe library or Webhook Secret is missing.");
        // We still return 200 to prevent Stripe retries if the key is missing, 
        // as the problem is internal config, not the event itself.
        return res.status(200).send('Stripe configuration error.'); 
    }

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            signature,
            webhookSecret
        );
    } catch (err) {
        console.error(`⚠️ Webhook Signature Verification Failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const { order_id, offer_id, user_id } = paymentIntent.metadata || {};

        console.log(`PaymentIntent ${paymentIntent.id} succeeded for Order ${order_id}.`);

        if (offer_id && user_id) {
            const now = admin.firestore.FieldValue.serverTimestamp();
            const paymentUpdate = {
                paymentIntentStatus: paymentIntent.status || 'succeeded',
                paymentIntentId: paymentIntent.id,
                latestChargeId: paymentIntent.latest_charge || null,
                amountReceived: paymentIntent.amount_received || null,
                currency: paymentIntent.currency || 'usd',
                paymentStatus: 'succeeded'
            };

            try {
                const userOfferRef = db.collection('wholesale').doc(user_id).collection('offers').doc(offer_id);
                const globalOfferRef = offersCollection.doc(offer_id);

                const offerStatusUpdate = {
                    status: 'completed',
                    statusDisplay: 'Completed',
                    completedAt: now,
                    paidAt: now,
                    payment: paymentUpdate
                };

                await Promise.all([
                    userOfferRef.set(offerStatusUpdate, { merge: true }),
                    globalOfferRef.set(offerStatusUpdate, { merge: true })
                ]);
                console.log(`Offer ${offer_id} marked as completed in wholesale collections.`);

                if (order_id) {
                    const orderRef = ordersCollection.doc(order_id);
                    await orderRef.set({
                        status: 'completed',
                        statusDisplay: 'Completed',
                        completedAt: now,
                        paymentStatus: 'succeeded',
                        stripe: paymentUpdate
                    }, { merge: true });
                    console.log(`Wholesale Order ${order_id} marked as completed.`);
                }

            } catch (firestoreError) {
                console.error(`Firestore update error for PI ${paymentIntent.id}:`, firestoreError);
                return res.status(500).send('Internal Server Error during Firestore update.');
            }
        } else {
            console.warn(`PaymentIntent ${paymentIntent.id} missing required metadata (order_id/offer_id/user_id).`);
        }
    } else if (event.type === 'payment_intent.payment_failed') {
        const paymentIntent = event.data.object;
        const { order_id, offer_id, user_id } = paymentIntent.metadata || {};
        console.log(`PaymentIntent ${paymentIntent.id} failed.`);

        if (offer_id && user_id) {
            const now = admin.firestore.FieldValue.serverTimestamp();
            const paymentUpdate = {
                paymentIntentStatus: paymentIntent.status || 'failed',
                paymentIntentId: paymentIntent.id,
                latestChargeId: paymentIntent.latest_charge || null,
                amountReceived: paymentIntent.amount_received || null,
                currency: paymentIntent.currency || 'usd',
                paymentStatus: 'declined',
                lastErrorMessage: paymentIntent.last_payment_error?.message || null
            };

            try {
                const userOfferRef = db.collection('wholesale').doc(user_id).collection('offers').doc(offer_id);
                const globalOfferRef = offersCollection.doc(offer_id);

                const offerStatusUpdate = {
                    status: 'payment_failed',
                    statusDisplay: 'Payment Declined',
                    failedAt: now,
                    payment: paymentUpdate
                };

                await Promise.all([
                    userOfferRef.set(offerStatusUpdate, { merge: true }),
                    globalOfferRef.set(offerStatusUpdate, { merge: true })
                ]);
                console.log(`Offer ${offer_id} marked as payment_failed in wholesale collections.`);

                if (order_id) {
                    const orderRef = ordersCollection.doc(order_id);
                    await orderRef.set({
                        status: 'payment_failed',
                        statusDisplay: 'Payment Declined',
                        failedAt: now,
                        paymentStatus: 'declined',
                        stripe: paymentUpdate
                    }, { merge: true });
                    console.log(`Wholesale Order ${order_id} marked as payment_failed.`);
                }

            } catch (e) {
                console.error(`Failed to mark offer ${offer_id} as payment_failed:`, e);
            }
        }
    }
    
    // Return a 200 response to Stripe to acknowledge receipt of the event
    res.json({ received: true });
});

router.get('/orders', async (req, res) => {
    const adminUser = await requireAdmin(req);
    if (!adminUser) {
        return res.status(403).json({ error: 'Admin authentication required' });
    }
    try {
        const snapshot = await ordersCollection.orderBy('createdAt', 'desc').limit(100).get();
        const orders = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        res.json({ orders });
    } catch (error) {
        console.error('Failed to list wholesale orders:', error);
        res.status(500).json({ error: 'Failed to list orders' });
    }
});

router.post('/orders/:orderId/label', async (req, res) => {
    const adminUser = await requireAdmin(req);
    if (!adminUser) {
        return res.status(403).json({ error: 'Admin authentication required' });
    }
    const { orderId } = req.params;
    const orderRef = ordersCollection.doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) {
        return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderDoc.data();
    const shipengineKey = getShipEngineKey();
    if (!shipengineKey) {
        return res.status(500).json({ error: 'ShipEngine key not configured' });
    }
    const carrierCode = req.body?.carrierCode || getShipEngineCarrierCode();
    const serviceCode = req.body?.serviceCode || getShipEngineServiceCode();
    const packages = req.body?.packages || order.packages || buildPackageList({});
    const shipTo = req.body?.shipTo || {
        name: order.shipping?.contact?.name || order.shipping?.company || 'Wholesale Buyer',
        phone: order.shipping?.contact?.phone || order.shipping?.phone || '0000000000',
        company_name: order.shipping?.company || 'Wholesale Buyer',
        address_line1: order.shipping?.address?.line1,
        address_line2: order.shipping?.address?.line2,
        city_locality: order.shipping?.address?.city,
        state_province: order.shipping?.address?.state,
        postal_code: order.shipping?.address?.postalCode,
        country_code: order.shipping?.address?.country || 'US'
    };

    try {
        const response = await axios.post(
            `${SHIPENGINE_API_BASE_URL}/labels`,
            {
                carrier_code: carrierCode,
                service_code: serviceCode || undefined,
                ship_to: shipTo,
                ship_from: getShipFromAddress(),
                packages
            },
            {
                headers: {
                    'API-Key': shipengineKey,
                    'Content-Type': 'application/json'
                }
            }
        );

        const label = response.data;
        
        // --- FIX: Advance status from 'paid' or 'payment_pending' to 'fulfillment_in_progress' ---
        let fulfillmentStatus = order.status;
        if (order.status === 'payment_pending' || order.status === 'paid') {
            fulfillmentStatus = 'fulfillment_in_progress';
        }
        // --------------------------------------------------------------------------------------
        
        await orderRef.update({
            shippingLabel: label,
            trackingNumber: label.tracking_number,
            shipEngineLabelId: label.label_id,
            labelPurchasedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: fulfillmentStatus
        });

        res.json({ label });
    } catch (error) {
        console.error('Failed to create ShipEngine label:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to create shipping label' });
    }
});

module.exports = router;
