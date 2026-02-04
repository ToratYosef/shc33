const admin = require('firebase-admin');
const { randomUUID } = require('crypto');
const { FAKE_ORDER_PROFILES } = require('./fake-order-profiles');

const DEVICE_TEMPLATES = [
  { brand: 'Apple', device: 'iPhone 13 Pro', storage: '256GB', carrier: 'Unlocked', modelSlug: 'iphone-13-pro', baseQuote: 485 },
  { brand: 'Apple', device: 'iPhone 14', storage: '128GB', carrier: 'T-Mobile', modelSlug: 'iphone-14', baseQuote: 420 },
  { brand: 'Samsung', device: 'Galaxy S23 Ultra', storage: '512GB', carrier: 'Unlocked', modelSlug: 'galaxy-s23-ultra', baseQuote: 510 },
  { brand: 'Google', device: 'Pixel 8 Pro', storage: '256GB', carrier: 'Unlocked', modelSlug: 'pixel-8-pro', baseQuote: 440 },
  { brand: 'Apple', device: 'iPhone 12 Mini', storage: '128GB', carrier: 'AT&T', modelSlug: 'iphone-12-mini', baseQuote: 320 },
  { brand: 'Samsung', device: 'Galaxy Note 20', storage: '256GB', carrier: 'Verizon', modelSlug: 'galaxy-note-20', baseQuote: 335 },
  { brand: 'Apple', device: 'iPhone 11 Pro Max', storage: '512GB', carrier: 'Unlocked', modelSlug: 'iphone-11-pro-max', baseQuote: 300 },
  { brand: 'Apple', device: 'iPhone SE (3rd Gen)', storage: '128GB', carrier: 'Unlocked', modelSlug: 'iphone-se-2022', baseQuote: 240 },
  { brand: 'Samsung', device: 'Galaxy Z Flip 4', storage: '256GB', carrier: 'Unlocked', modelSlug: 'galaxy-z-flip-4', baseQuote: 360 },
  { brand: 'Google', device: 'Pixel 7a', storage: '128GB', carrier: 'Unlocked', modelSlug: 'pixel-7a', baseQuote: 275 }
];

const PAYMENT_METHODS = [
  { key: 'paypal', buildDetails: (profile) => ({ paypalEmail: profile.email }) },
  { key: 'zelle', buildDetails: (profile) => ({ zelleEmail: profile.email }) },
  {
    key: 'echeck',
    buildDetails: (profile) => ({
      accountNumber: `10${Math.abs(profile.fullName.length * 9173).toString().padStart(6, '0')}`,
      routingNumber: '021000021',
    }),
  },
  { key: 'check', buildDetails: () => ({}) }
];

const USPS_TRACKING_BASE_URL = 'https://tools.usps.com/go/TrackConfirmAction?tLabels=';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getFirestore() {
  return admin.firestore();
}

function generateTrackingNumber(seed) {
  const base = BigInt(Date.now()) + BigInt(seed * 97 + 13);
  const digits = base.toString();
  const raw = `9400${digits}`;
  if (raw.length >= 22) {
    return raw.slice(0, 22);
  }
  return raw.padEnd(22, '0');
}

function pickDevicePreset(seed = 0) {
  const index = Math.abs(seed) % DEVICE_TEMPLATES.length;
  return DEVICE_TEMPLATES[index];
}

function pickPaymentMethod(seed = 0) {
  const index = Math.abs(seed) % PAYMENT_METHODS.length;
  return PAYMENT_METHODS[index];
}

async function reserveFakeProfiles(count) {
  if (!count || count <= 0) {
    return [];
  }

  const db = getFirestore();
  const cursorRef = db.collection('counters').doc('fakeOrderProfiles');
  const reserved = [];

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(cursorRef);
    let cursor = snapshot.exists && Number.isFinite(snapshot.data().lastIndex)
      ? snapshot.data().lastIndex
      : -1;

    for (let i = 0; i < count; i += 1) {
      cursor = (cursor + 1) % FAKE_ORDER_PROFILES.length;
      reserved.push({ profileIndex: cursor, profile: FAKE_ORDER_PROFILES[cursor] });
    }

    transaction.set(cursorRef, { lastIndex: cursor }, { merge: true });
  });

  return reserved;
}

function getFakeOrderDayContext(now = new Date(), offsetMinutes = 0) {
  const offsetMs = Number.isFinite(offsetMinutes) ? offsetMinutes * 60 * 1000 : 0;
  const adjusted = new Date(now.getTime() + offsetMs);
  const dayKey = adjusted.toISOString().slice(0, 10);
  const startOfDayAdjusted = new Date(`${dayKey}T00:00:00.000Z`);
  const startOfDay = new Date(startOfDayAdjusted.getTime() - offsetMs);
  return { dayKey, startOfDay };
}

function buildFakeOrderPayload({
  orderId,
  profile,
  profileIndex = 0,
  dayKey,
  sequence,
  createdAt = new Date(),
}) {
  const devicePreset = pickDevicePreset(profileIndex + sequence);
  const payment = pickPaymentMethod(profileIndex + sequence);
  const timestamp = admin.firestore.Timestamp.fromDate(createdAt);
  const estimatedQuote = Math.max(150, devicePreset.baseQuote - ((sequence % 4) * 7));
  const trackingNumber = generateTrackingNumber(sequence + profileIndex);
  const trackingUrl = `${USPS_TRACKING_BASE_URL}${trackingNumber}`;
  const paymentDetails = payment.buildDetails(profile);

  const activityLogEntry = {
    id: randomUUID(),
    type: 'status',
    message: 'Simulated order auto-cancelled on creation.',
    metadata: { simulation: true, status: 'cancelled' },
    at: timestamp,
  };

  const noteEntry = {
    id: randomUUID(),
    type: 'update',
    message: 'Simulated order inserted for analytics counters.',
    metadata: { simulation: true },
    at: timestamp,
  };

  return {
    id: orderId,
    orderId,
    orderNumber: orderId,
    createdAt: timestamp,
    orderSubmittedAt: timestamp,
    createdAtMillis: createdAt.getTime(),
    updatedAt: timestamp,
    lastStatusUpdateAt: timestamp,
    status: 'cancelled',
    cancelledAt: timestamp,
    cancellationReason: 'simulation_auto_cancelled',
    cancellationDetails: { initiatedBy: 'system', simulation: true },
    fakeOrderDateKey: dayKey,
    fakeOrderSequence: sequence,
    fakeOrderProfileId: profile.profileId,
    isFakeOrder: true,
    orderSource: 'simulation',
    tags: ['simulation', 'auto-cancelled'],
    notes: 'Auto-generated order for dashboard counts.',
    shippingPreference: 'Email Label Requested',
    shippingPreferenceNormalized: 'email_label_requested',
    shippingInfo: {
      fullName: profile.fullName,
      email: profile.email,
      phone: profile.phoneNumber,
      phoneNumber: profile.phoneNumber,
      streetAddress: profile.streetAddress,
      city: profile.city,
      state: profile.state,
      zipCode: profile.zipCode,
      country: profile.country,
    },
    contactEmail: profile.email,
    contactPhone: profile.phoneNumber,
    paymentMethod: payment.key,
    paymentDetails,
    estimatedQuote,
    quotedPrice: estimatedQuote,
    orderTotal: 0,
    payoutTotal: 0,
    brand: devicePreset.brand,
    device: devicePreset.device,
    deviceCategory: 'Phone',
    modelSlug: devicePreset.modelSlug,
    storage: devicePreset.storage,
    carrier: devicePreset.carrier,
    trackingNumber,
    inboundTrackingNumber: trackingNumber,
    trackingCarrierCode: 'usps',
    trackingCarrierName: 'USPS',
    trackingUrl,
    fakeTrackingNumber: trackingNumber,
    fakeTrackingUrl: trackingUrl,
    balanceEmailSentAt: null,
    activityLog: [activityLogEntry, noteEntry],
  };
}

module.exports = {
  reserveFakeProfiles,
  buildFakeOrderPayload,
  getFakeOrderDayContext,
  MS_PER_DAY,
};
