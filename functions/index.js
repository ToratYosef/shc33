const functions = require("firebase-functions/v1");
const express = require("express");
const cors = require("cors");
const { admin, initFirebaseAdmin } = require("./helpers/firebaseAdmin");
const axios = require("axios");
const nodemailer = require("nodemailer");
const { randomUUID } = require("crypto");
const { generateCustomLabelPdf, generateBagLabelPdf, mergePdfBuffers } = require('./helpers/pdf');
const {
  checkEsn,
  checkCarrierLock,
  checkSamsungCarrierInfo,
  isAppleDeviceHint,
  isSamsungDeviceHint,
} = require('./services/phonecheck');
const {
  DEFAULT_CARRIER_CODE,
  buildKitTrackingUpdate,
  buildTrackingUrl,
  resolveCarrierCode,
  fetchTrackingData,
  KIT_TRANSIT_STATUS,
  PHONE_TRANSIT_STATUS,
  normalizeInboundTrackingStatus,
  resolveUspsServiceAndWeightByDeviceCount,
} = require('./helpers/shipengine');
const { isStatusPastReceived, isBalanceEmailStatus } = require('./helpers/order-status');
const { getShipStationCredentials } = require('./services/shipstation');
const wholesaleRouter = require('./routes/wholesale'); // <-- wholesale.js is loaded here
const createEmailsRouter = require('./routes/emails');
const createOrdersRouter = require('./routes/orders');

initFirebaseAdmin();
const {
  reserveFakeProfiles,
  buildFakeOrderPayload,
  getFakeOrderDayContext,
  MS_PER_DAY,
} = require('./helpers/fake-order-generator');
const db = admin.firestore();
const ordersCollection = db.collection("orders");
const usersCollection = db.collection("users");
const adminsCollection = db.collection("admins"); // This collection should only contain manually designated admin UIDs
const chatsCollection = db.collection("chats");
const devicesCollection = db.collection("devices");
const supportTicketsCollection = db.collection("support_tickets");

function firebaseNotificationsEnabled() {
  const raw = String(process.env.FIREBASE_NOTIFICATIONS_ENABLED || 'true').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

function isAuthDisabled() {
  const raw = String(process.env.DISABLE_AUTH || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function getCallableAuth(context) {
  if (context?.auth) {
    return context.auth;
  }
  if (isAuthDisabled()) {
    return { uid: 'public', token: { email: 'public@localhost' } };
  }
  return null;
}

const FAKE_ORDER_TARGET_PER_DAY = Number(process.env.FAKE_ORDER_TARGET_PER_DAY || 20);
const FAKE_ORDER_MAX_PER_RUN = Number(process.env.FAKE_ORDER_MAX_PER_RUN || 3);
const FAKE_ORDER_TZ_OFFSET_MINUTES = Number(process.env.FAKE_ORDER_TZ_OFFSET_MINUTES ?? -300);
// ---- ONLY ONCE AT TOP OF FILE (if not already required) ----
// const functions = require("firebase-functions");
const { XMLParser } = require("fast-xml-parser");
const { parse: parseCsv } = require("csv-parse/sync");

// ---------------- REPRICER HELPERS ----------------

const CONDITION_XML_MAP = {
  flawless: "prices_likenew",
  good: "prices_good",
  fair: "prices_poor",
  damaged: "prices_faulty",
};

function normalizeName(name) {
  return String(name || "").trim().toUpperCase();
}

// Clean currency-like values: "$270.00", "270,00", "  270 " -> 270
function toNumber(val) {
  if (val === undefined || val === null) return null;
  const cleaned = String(val).replace(/[^0-9.\-]/g, ""); // remove $, commas, etc.
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
}

// Cached feed index so we don't refetch XML on every run
let cachedFeedIndex = null;
let cachedFeedIndexTime = 0;
const FEED_CACHE_MS = 5 * 60 * 1000; // 5 minutes

// Build index from XML (optionally using XML provided by client)
async function buildFeedIndex(xmlOverride) {
  const now = Date.now();

  // If no override and cache is fresh, reuse
  if (!xmlOverride && cachedFeedIndex && now - cachedFeedIndexTime < FEED_CACHE_MS) {
    return cachedFeedIndex;
  }

  let xmlText;

  if (xmlOverride && typeof xmlOverride === "string" && xmlOverride.trim()) {
    // Use client-provided XML
    xmlText = xmlOverride;
  } else {
    // Fetch feed.xml on backend
    const feedUrl = "https://secondhandcell.com/sellcell/feed.xml";
    const response = await fetch(feedUrl);
    if (!response.ok) {
      throw new Error("Failed to fetch feed.xml: " + response.status);
    }
    xmlText = await response.text();
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
  });
  const parsed = parser.parse(xmlText);

  let devices = [];
  if (Array.isArray(parsed.device)) {
    devices = parsed.device;
  } else if (parsed.device) {
    devices = [parsed.device];
  } else if (parsed.feed && parsed.feed.device) {
    if (Array.isArray(parsed.feed.device)) {
      devices = parsed.feed.device;
    } else {
      devices = [parsed.feed.device];
    }
  }

  const index = {};

  // key: `${DEVICE_NAME}|${CAPACITY}`
  // value: { flawless: topPrice, good: topPrice, fair: topPrice, damaged: topPrice }
  devices.forEach((d) => {
    const deviceName = normalizeName(d.device_name);
    const capacity = String(d.capacity || "").trim();
    const keyBase = `${deviceName}|${capacity}`;

    Object.keys(CONDITION_XML_MAP).forEach((condKey) => {
      const xmlSectionName = CONDITION_XML_MAP[condKey];
      const section = d[xmlSectionName];
      if (!section) return;

      let prices = section.price;
      if (!prices) return;
      if (!Array.isArray(prices)) prices = [prices];

      const competitorPrices = prices
        .filter((p) => {
          const merchant = String(p.merchant_name || "").trim().toLowerCase();
          // exclude secondhandcell
          return merchant !== "secondhandcell";
        })
        .map((p) => toNumber(p.merchant_price))
        .filter((n) => n !== null);

      if (!competitorPrices.length) return;

      const top = Math.max(...competitorPrices);

      if (!index[keyBase]) index[keyBase] = {};
      index[keyBase][condKey] = top;
    });
  });

  if (!xmlOverride) {
    cachedFeedIndex = index;
    cachedFeedIndexTime = now;
  }

  return index;
}

// Uses "amz" column from CSV, cleaning "$270.00" etc.
async function getAmazonPrice(row) {
  const n = toNumber(row.amz);
  if (n && n > 0) return n;
  return null; // no scraper yet
}

// ---------------- REPRICER FUNCTION ----------------

exports.repriceFeed = functions.https.onRequest(async (req, res) => {
  try {
    // CORS (simple & permissive for this tool)
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("Only POST allowed");
      return;
    }

    const csvInput = req.body && req.body.csv;
    const xmlInput = req.body && req.body.xml; // optional: raw XML string from frontend

    if (!csvInput || typeof csvInput !== "string") {
      res.status(400).send("Missing 'csv' field in JSON body");
      return;
    }

    // Parse CSV (expects header: name,storage,lock_status,condition,price,amz)
    const records = parseCsv(csvInput, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    // Build SellCell feed index
    const feedIndex = await buildFeedIndex(xmlInput);

    const resultRows = [];

    for (const row of records) {
      const name = row.name;
      const storage = row.storage;
      const lock_status = row.lock_status;
      const conditionRaw = row.condition;
      const condition = String(conditionRaw || "").toLowerCase();

      const key = `${normalizeName(name)}|${storage}`;
      const feedEntry = feedIndex[key];

      let feed_price = null;
      if (feedEntry && Object.prototype.hasOwnProperty.call(feedEntry, condition)) {
        feed_price = feedEntry[condition];
      }

      // No competitor price → return mostly empty
      if (!feed_price) {
        resultRows.push({
          ...row,
          original_feed_price: null,
          amazon_price: null,
          after_amazon: null,
          sellcell_fee: null,
          shipping_fee: 15,
          condition_fee: null,
          total_walkaway: null,
          profit: null,
          profit_pct: null,
          new_price: null,
          new_profit: null,
          new_profit_pct: null,
        });
        continue;
      }

      // Amazon price from CSV
      const amazon_price = await getAmazonPrice(row);

      // No Amazon price → only feed shown
      if (!amazon_price || Number.isNaN(Number(amazon_price))) {
        resultRows.push({
          ...row,
          original_feed_price: feed_price,
          amazon_price: null,
          after_amazon: null,
          sellcell_fee: null,
          shipping_fee: 15,
          condition_fee: null,
          total_walkaway: null,
          profit: null,
          profit_pct: null,
          new_price: null,
          new_profit: null,
          new_profit_pct: null,
        });
        continue;
      }

      // ----- PRICING MATH -----

      const feedPriceNum = toNumber(feed_price);
      const amazonPriceNum = toNumber(amazon_price);

      // after Amazon (amazon_price*0.92 - 10)
      const after_amazon = amazonPriceNum * 0.92 - 10;

      // SellCell fee: 8% capped at $30
      const sellcell_fee = Math.min(after_amazon * 0.08, 30);

      const after_sellcell = after_amazon - sellcell_fee;
      const shipping_fee = 15;

      let condition_fee = 0;
      if (condition === "flawless" || condition === "good") {
        condition_fee = 10;
      } else if (condition === "fair") {
        condition_fee = 30;
      } else if (condition === "damaged") {
        condition_fee = 50;
      }

      const total_walkaway = after_sellcell - shipping_fee - condition_fee;

      const original_price = feedPriceNum;
      const profit = total_walkaway - original_price;
      const profit_pct = profit / original_price;

      let new_price;
      if (profit_pct >= 0.15) {
        // Already ≥ 15%, bump buy price by $1
        new_price = original_price + 1;
      } else {
        // Force exactly 15% profit:
        // total_walkaway = 1.15 * buy_price → buy_price = total_walkaway / 1.15
        new_price = total_walkaway / 1.15;
      }

      new_price = Math.round(new_price * 100) / 100;

      const new_profit = total_walkaway - new_price;
      const new_profit_pct = new_profit / new_price;

      resultRows.push({
        ...row,
        original_feed_price: feedPriceNum,
        amazon_price: amazonPriceNum,
        after_amazon,
        sellcell_fee,
        shipping_fee,
        condition_fee,
        total_walkaway,
        profit,
        profit_pct,
        new_price,
        new_profit,
        new_profit_pct,
      });
    }

    res.json({ rows: resultRows });
  } catch (err) {
    console.error(err);
    res.status(500).send(err && err.message ? err.message : "Server error");
  }
});

function isValidImei(imei) {
  if (typeof imei !== "string" || !/^\d{15}$/.test(imei)) {
    return false;
  }

  let sum = 0;
  for (let index = 0; index < imei.length; index += 1) {
    const digitIndexFromRight = imei.length - 1 - index;
    let digit = Number(imei[digitIndexFromRight]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }

  return sum % 10 === 0;
}

function sanitizeDocumentId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split('/');
  return parts[parts.length - 1] || null;
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function normalizeStatusValue(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase().replace(/[\s-]+/g, '_');
}

function buildOrderDeviceKey(orderId, deviceIndex = 0) {
  const baseOrderId = sanitizeDocumentId(orderId) || String(orderId || '').trim();
  const parsedIndex = Number.parseInt(deviceIndex, 10);
  const safeIndex = Number.isInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : 0;
  return `${baseOrderId}::${safeIndex}`;
}

function collectOrderDeviceKeys(order = {}) {
  const orderId = sanitizeDocumentId(order.id || order.orderId || order.orderID);
  const keySet = new Set();

  if (Array.isArray(order.items) && order.items.length > 0) {
    for (let index = 0; index < order.items.length; index += 1) {
      keySet.add(buildOrderDeviceKey(orderId, index));
    }
  } else {
    keySet.add(buildOrderDeviceKey(orderId, 0));
  }

  const mapCandidates = [
    order.deviceStatusByKey,
    order.reOfferByDevice,
    order.reofferByDevice,
  ];

  for (const candidate of mapCandidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }
    for (const key of Object.keys(candidate)) {
      if (typeof key === 'string' && key.trim()) {
        keySet.add(key.trim());
      }
    }
  }

  return Array.from(keySet);
}

function deriveOrderStatusFromDevices(order = {}, nextDeviceStatusByKey = null) {
  const deviceStatusByKey = nextDeviceStatusByKey && typeof nextDeviceStatusByKey === 'object'
    ? nextDeviceStatusByKey
    : (order.deviceStatusByKey || {});
  const deviceKeys = collectOrderDeviceKeys({ ...order, deviceStatusByKey });

  const terminalStatuses = new Set([
    'completed',
    're_offered_accepted',
    're_offered_auto_accepted',
    're_offered_declined',
    'return_label_generated',
    'returned',
    'paid',
  ]);

  const normalizedStatuses = deviceKeys
    .map((key) => normalizeStatusValue(deviceStatusByKey[key] || order.status))
    .filter(Boolean);

  if (!normalizedStatuses.length || normalizedStatuses.length !== deviceKeys.length) {
    return null;
  }

  if (!normalizedStatuses.every((status) => terminalStatuses.has(status))) {
    return null;
  }

  if (normalizedStatuses.some((status) => status.includes('declined') || status.includes('return'))) {
    return 're-offered-declined';
  }

  if (normalizedStatuses.some((status) => status.includes('accepted'))) {
    return 're-offered-accepted';
  }

  if (normalizedStatuses.every((status) => status === 'completed' || status === 'paid')) {
    return 'completed';
  }

  return null;
}

function isStatusEligibleForImeiCheck(status) {
  if (!status) {
    return true;
  }
  if (status === 'received' || status === 'device_received') {
    return true;
  }
  if (status.includes('received')) {
    return true;
  }
  if (status === 'imei_checked' || status === 'blacklisted') {
    return true;
  }
  return false;
}

function resolveDeviceDocumentIdFromOrder(order = {}) {
  const candidates = [
    order.deviceFirestoreDocId,
    order.deviceFirestoreDocID,
    order.deviceInventoryId,
    order.deviceInventoryID,
    order.deviceId,
    order.deviceID,
    order.inventoryDeviceId,
    order.inventoryDeviceID,
    order.device?.id,
    order.device?.deviceId,
    order.deviceInfo?.id,
    order.deviceInfo?.deviceId,
    order.deviceStatus?.id,
    order.deviceStatus?.deviceId,
  ];

  for (const candidate of candidates) {
    const sanitized = sanitizeDocumentId(candidate);
    if (sanitized) {
      return sanitized;
    }
  }

  return sanitizeDocumentId(order.id);
}

function resolveOrderIdFromDevice(device = {}) {
  const candidates = [
    device.orderId,
    device.orderID,
    device.order?.id,
    device.order?.orderId,
    device.orderInfo?.id,
    device.orderInfo?.orderId,
    device.meta?.orderId,
  ];

  for (const candidate of candidates) {
    const sanitized = sanitizeDocumentId(candidate);
    if (sanitized) {
      return sanitized;
    }
  }

  return null;
}

async function seedFakeOrdersForDay(now = new Date()) {
  if (!Number.isFinite(FAKE_ORDER_TARGET_PER_DAY) || FAKE_ORDER_TARGET_PER_DAY <= 0) {
    return { created: 0 };
  }

  const { dayKey, startOfDay } = getFakeOrderDayContext(now, FAKE_ORDER_TZ_OFFSET_MINUTES);
  const existingSnapshot = await ordersCollection.where('fakeOrderDateKey', '==', dayKey).get();
  const createdToday = existingSnapshot.size;

  if (createdToday >= FAKE_ORDER_TARGET_PER_DAY) {
    return { created: 0, dayKey };
  }

  const elapsedMs = Math.max(0, now.getTime() - startOfDay.getTime());
  const clampedElapsed = Math.min(elapsedMs, MS_PER_DAY);
  const progress = clampedElapsed / MS_PER_DAY;
  const expectedCount = Math.min(
    FAKE_ORDER_TARGET_PER_DAY,
    Math.ceil(progress * FAKE_ORDER_TARGET_PER_DAY)
  );
  const remainingCapacity = FAKE_ORDER_TARGET_PER_DAY - createdToday;
  const shortfall = expectedCount - createdToday;
  let toCreate = Math.min(remainingCapacity, Math.max(shortfall, 0));

  if (toCreate <= 0 && progress >= 1 && remainingCapacity > 0) {
    toCreate = remainingCapacity;
  }

  toCreate = Math.min(FAKE_ORDER_MAX_PER_RUN, toCreate);

  if (toCreate <= 0) {
    return { created: 0, dayKey };
  }

  const reservedProfiles = await reserveFakeProfiles(toCreate);
  let createdCount = 0;

  for (let index = 0; index < toCreate; index += 1) {
    const profileEntry = reservedProfiles[index];
    if (!profileEntry) {
      continue;
    }
    const orderId = await generateNextOrderNumber();
    const createdAt = new Date(now.getTime() - index * 60000);
    const payload = buildFakeOrderPayload({
      orderId,
      profile: profileEntry.profile,
      profileIndex: profileEntry.profileIndex,
      dayKey,
      sequence: createdToday + index + 1,
      createdAt,
    });

    await ordersCollection.doc(orderId).set(payload);
    createdCount += 1;
  }

  return { created: createdCount, dayKey };
}

const app = express();
const API_ACTION_LOGGING_ENABLED = !['0', 'false', 'off', 'no'].includes(
  String(process.env.API_ACTION_LOGGING_ENABLED || 'true').trim().toLowerCase()
);

function summarizeApiActionContext(req) {
  const body = req && typeof req.body === 'object' && req.body ? req.body : {};
  const params = req && typeof req.params === 'object' && req.params ? req.params : {};
  const labels = Array.isArray(body.labels) ? body.labels.length : 0;
  const orderId =
    params.id ||
    params.orderId ||
    body.orderId ||
    body.id ||
    null;

  const parts = [];
  if (orderId) parts.push(`order=${orderId}`);
  if (body.type) parts.push(`type=${body.type}`);
  if (labels) parts.push(`labels=${labels}`);
  if (req?.user?.uid) parts.push(`uid=${req.user.uid}`);

  return parts.join(' ');
}

const allowedOrigins = [
  "https://toratyosef.github.io",
  "https://buyback-a0f05.web.app",
  "https://secondhandcell.com",
  "https://www.secondhandcell.com",
  "https://admin.secondhandcell.com",
  "http://admin.secondhandcell.com",
  "https://cautious-pancake-69p475gq54q4f5qp4-3001.app.github.dev",
];

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  return false;
};

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", corsOptions.methods.join(","));
  res.header(
    "Access-Control-Allow-Headers",
    corsOptions.allowedHeaders.join(",")
  );

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  return cors(corsOptions)(req, res, next);
});

app.use(express.json());

app.use((req, res, next) => {
  if (!API_ACTION_LOGGING_ENABLED) {
    return next();
  }

  const startedAtMs = Date.now();
  const context = summarizeApiActionContext(req);
  const requestLine = `[API] -> ${req.method} ${req.originalUrl || req.url}${context ? ` | ${context}` : ''}`;
  console.log(requestLine);

  res.on('finish', () => {
    const durationMs = Date.now() - startedAtMs;
    const responseLine = `[API] <- ${req.method} ${req.originalUrl || req.url} ${res.statusCode} ${durationMs}ms${context ? ` | ${context}` : ''}`;
    console.log(responseLine);
  });

  return next();
});

app.use('/wholesale', wholesaleRouter);

function normalizeIssueReason(value) {
  if (!value) {
    return '';
  }
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function toTitleCase(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

const ISSUE_COPY = {
  fmi_active: {
    title: 'iCloud / FMI ON',
    problem: 'Find My iPhone (FMI) is still enabled. The device is locked to your Apple ID.',
    why: 'We cannot use or resell the device while it is linked to your Apple ID.',
    fixOptions: [
      {
        title: 'Option 1 – Remove Using iCloud (Most Common)',
        prerequisite: 'If You Still Have Access to Apple ID',
        steps: [
          'Go to: https://www.icloud.com',
          'Sign in with your Apple ID.',
          'Click "Find iPhone"',
          'Click "All Devices"',
          'Select the affected device.',
          'Click "Remove from Account"',
          'Confirm removal.',
          'Important: If it says "Erase iPhone" first, click that, wait for it to complete, THEN click Remove from Account.'
        ]
      },
      {
        title: 'Option 2 – From Another Apple Device',
        steps: [
          'Open Settings',
          'Tap your name (Apple ID at top)',
          'Scroll down to the device list',
          'Tap the device',
          'Tap "Remove from Account"'
        ]
      },
      {
        title: 'If You Don\'t Have Access to the Account',
        note: 'You must either recover your Apple ID at https://iforgot.apple.com OR provide the original purchase receipt so Apple can unlock it'
      }
    ],
    afterComplete: 'Once complete, press the button below to mark as resolved. We will verify and update: Status: ✅ Received & Cleared'
  },

  password_locked: {
    title: 'Screen Lock / Passcode Lock',
    problem: 'The device is locked with a passcode.',
    why: 'We need access to the device to verify its condition and complete processing.',
    fixOptions: [
      {
        title: 'If You Remember the PIN',
        steps: [
          'Option A: Reply securely with the device passcode so we can complete processing.',
          'Option B: Remove the passcode via iCloud (follow the FMI removal steps above)'
        ]
      },
      {
        title: 'If You Don\'t Have the Device',
        steps: [
          'Remove it from your account using iCloud (Apple) or Google Device Activity (Android)',
          'Note: If we cannot access the device, the offer may need to be adjusted.'
        ]
      }
    ],
    afterComplete: 'Once complete, press the button below to mark as resolved. Status: ✅ Received & Accessible'
  },

  stolen: {
    title: 'Blacklisted / Carrier Blocked',
    problem: 'The device is reported lost, stolen, or has an unpaid balance.',
    why: 'Blacklisted devices cannot be used or resold on carrier networks.',
    commonReasons: [
      'Insurance claim filed',
      'Phone reported lost',
      'Unpaid carrier bill',
      'Device still under financing'
    ],
    fixOptions: [
      {
        title: 'If Reported Lost/Stolen',
        steps: [
          'Call your carrier and request: "Please remove the blacklist from this IMEI"',
          'Carriers:',
          '  • Verizon: 800-922-0204',
          '  • AT&T: 800-331-0500',
          '  • T-Mobile: 877-746-0909'
        ]
      },
      {
        title: 'If Balance Due (BAL DUE)',
        steps: [
          'Pay off remaining device balance',
          'Request carrier to unlock and clear IMEI',
          'Ask them to confirm: "IMEI is clean and fully paid"'
        ]
      }
    ],
    afterComplete: 'Once complete, press the button below to mark as resolved. Status: ✅ Received & Clean'
  },

  outstanding_balance: {
    title: 'Blacklisted / Carrier Blocked - Outstanding Balance',
    problem: 'The device has an unpaid balance with the carrier.',
    why: 'Unpaid balances prevent the device from being used on any carrier network.',
    fixOptions: [
      {
        title: 'How To Clear',
        steps: [
          'Contact your carrier directly',
          'Check the remaining device balance',
          'Pay off any outstanding payments or device financing',
          'Request confirmation once paid in full and IMEI is cleared',
          'Ask them to confirm: "IMEI is clean and fully paid"'
        ]
      }
    ],
    afterComplete: 'Once complete, press the button below to mark as resolved. Status: ✅ Received & Paid'
  },

  google_frp_active: {
    title: 'Google Lock (FRP ON)',
    problem: 'Google account is still signed in. Factory Reset Protection (FRP) is active.',
    why: 'We cannot use or resell the device while FRP is active and linked to your Google account.',
    fixOptions: [
      {
        title: 'Option 1 – Remove Device From Google Account',
        prerequisite: 'If You Have Access to Your Google Account',
        steps: [
          'Go to: https://myaccount.google.com/device-activity',
          'Sign into your Google account.',
          'Find the affected device.',
          'Click "Sign Out"',
          'Confirm removal.'
        ]
      },
      {
        title: 'Option 2 – Direct Device Removal',
        prerequisite: 'If You Still Have the Device',
        steps: [
          'Go to: Settings → Accounts → Remove Google Account',
          'Follow device prompts to complete removal'
        ]
      },
      {
        title: 'If You Forgot the Google Account',
        note: 'Recover it here: https://accounts.google.com/signin/recovery'
      }
    ],
    afterComplete: 'Once complete, press the button below to mark as resolved. We will verify and update: Status: ✅ Received & Cleared'
  }
};

function buildIssueList(order) {
  const issues = [];
  const qcIssuesByDevice = order?.qcIssuesByDevice;

  if (qcIssuesByDevice && typeof qcIssuesByDevice === 'object' && !Array.isArray(qcIssuesByDevice)) {
    Object.keys(qcIssuesByDevice).forEach((deviceKey) => {
      const issueMap = qcIssuesByDevice[deviceKey];
      if (!issueMap || typeof issueMap !== 'object' || Array.isArray(issueMap)) {
        return;
      }
      Object.keys(issueMap).forEach((reasonKey) => {
        const issue = issueMap[reasonKey] || {};
        const reason = normalizeIssueReason(issue.reason || reasonKey);
        if (!reason) {
          return;
        }
        issues.push({
          deviceKey,
          reason,
          resolved: Boolean(issue.resolved) || Boolean(issue.resolvedAt),
          notes: issue.notes || '',
        });
      });
    });
  }

  if (!issues.length) {
    const fallbackReason = normalizeIssueReason(
      order?.lastConditionEmailReason || order?.conditionEmailReason || ''
    );
    if (fallbackReason) {
      const fallbackKey = buildOrderDeviceKey(order?.id || order?.orderId || '', 0);
      issues.push({
        deviceKey: fallbackKey,
        reason: fallbackReason,
        resolved: false,
        notes: order?.lastConditionEmailNotes || '',
      });
    }
  }

  return issues;
}

app.get('/fix-issue/:orderId', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    if (!orderId) {
      return res.status(400).send('Order ID is required.');
    }

    const orderRef = ordersCollection.doc(orderId);
    const snapshot = await orderRef.get();
    if (!snapshot.exists) {
      return res.status(404).send('Order not found.');
    }

    const order = { id: snapshot.id, ...snapshot.data() };
    const requestedDeviceKey = req.query.deviceKey ? String(req.query.deviceKey).trim() : '';
    const issues = buildIssueList(order);
    const visibleIssues = requestedDeviceKey
      ? issues.filter((issue) => issue.deviceKey === requestedDeviceKey)
      : issues;
    const safeOrderId = escapeHtml(orderId);
    const confirmUrl = `/fix-issue/${encodeURIComponent(orderId)}/confirm`;

    const getDeviceInfo = (deviceKey) => {
      if (!deviceKey) return { number: 1, model: 'Device', storage: '' };
      const parts = String(deviceKey).split('::');
      const idx = Number(parts[1]);
      const deviceNumber = Number.isFinite(idx) ? idx + 1 : 1;
      const items = Array.isArray(order.items) ? order.items : [];
      const item = Number.isFinite(idx) ? items[idx] : null;
      const model = item?.deviceName || item?.model || order?.device || order?.deviceName || 'Device';
      const storage = item?.storage || item?.capacity || order?.storage || '';
      return { number: deviceNumber, model, storage };
    };

    // Group issues by device
    const issuesByDevice = {};
    visibleIssues.forEach(issue => {
      if (!issuesByDevice[issue.deviceKey]) {
        issuesByDevice[issue.deviceKey] = [];
      }
      issuesByDevice[issue.deviceKey].push(issue);
    });

    const allIssueCards = [];
    
    Object.keys(issuesByDevice).forEach(deviceKey => {
      const deviceInfo = getDeviceInfo(deviceKey);
      const deviceIssues = issuesByDevice[deviceKey];
      
      deviceIssues.forEach((issue, index) => {
        const copy = ISSUE_COPY[issue.reason] || {
          title: toTitleCase(issue.reason),
          problem: 'Please resolve this issue so we can continue processing.'
        };
        const safeDeviceKey = escapeHtml(issue.deviceKey);
        const safeReason = escapeHtml(issue.reason);
        const safeNotes = issue.notes ? `<div class="issue-notes">📌 Note: ${escapeHtml(issue.notes)}</div>` : '';
        const statusBadge = issue.resolved ? 'resolved' : 'pending';
        const statusLabel = issue.resolved ? 'Resolved' : 'Needs Action';
        
        // Build fix instructions HTML from new comprehensive format
        let fixInstructionsHtml = '';
        if (copy.problem || copy.why || copy.fixOptions) {
          fixInstructionsHtml = '<div class="fix-instructions">';
          
          // Problem section
          if (copy.problem) {
            fixInstructionsHtml += `
              <div class="fix-section">
                <div class="fix-section-title">📋 Problem:</div>
                <p class="fix-section-content">${escapeHtml(copy.problem)}</p>
              </div>
            `;
          }
          
          // Why it matters section
          if (copy.why) {
            fixInstructionsHtml += `
              <div class="fix-section">
                <div class="fix-section-title">❓ Why This Matters:</div>
                <p class="fix-section-content">${escapeHtml(copy.why)}</p>
              </div>
            `;
          }
          
          // Common reasons (for stolen/blacklist)
          if (copy.commonReasons && Array.isArray(copy.commonReasons)) {
            fixInstructionsHtml += `
              <div class="fix-section">
                <div class="fix-section-title">⚠️ Common Reasons:</div>
                <ul class="fix-reasons-list">
                  ${copy.commonReasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}
                </ul>
              </div>
            `;
          }
          
          // Fix options
          if (copy.fixOptions && Array.isArray(copy.fixOptions)) {
            fixInstructionsHtml += '<div class="fix-options-container">';
            copy.fixOptions.forEach((option, optIdx) => {
              fixInstructionsHtml += '<div class="fix-option">';
              
              if (option.title) {
                fixInstructionsHtml += `<div class="fix-option-title">✅ ${escapeHtml(option.title)}</div>`;
              }
              
              if (option.prerequisite) {
                fixInstructionsHtml += `<div class="fix-prerequisite">${escapeHtml(option.prerequisite)}</div>`;
              }
              
              if (option.steps && Array.isArray(option.steps)) {
                fixInstructionsHtml += '<ol class="fix-steps">';
                option.steps.forEach(step => {
                  fixInstructionsHtml += `<li>${escapeHtml(step)}</li>`;
                });
                fixInstructionsHtml += '</ol>';
              }
              
              if (option.note) {
                fixInstructionsHtml += `<div class="fix-note">📌 ${escapeHtml(option.note)}</div>`;
              }
              
              fixInstructionsHtml += '</div>';
            });
            fixInstructionsHtml += '</div>';
          }
          
          // After complete section
          if (copy.afterComplete) {
            fixInstructionsHtml += `
              <div class="fix-section after-complete">
                <div class="fix-section-title">📍 After You Complete This:</div>
                <p class="fix-section-content">${escapeHtml(copy.afterComplete)}</p>
              </div>
            `;
          }
          
          fixInstructionsHtml += '</div>';
        }

        const buttonsHtml = issue.resolved
          ? '<div class="issue-actions"><button class="issue-button primary" disabled>✓ Resolved</button></div>'
          : `
            <div class="issue-actions">
              <button class="issue-button primary" data-device-key="${safeDeviceKey}" data-reason="${safeReason}" data-action="resolve">
                ✓ Mark as Resolved
              </button>
              <button class="issue-button secondary" data-device-key="${safeDeviceKey}" data-reason="${safeReason}" data-action="received">
                📦 Mark as Received
              </button>
            </div>
          `;

        allIssueCards.push(`
          <div class="issue-column ${issue.resolved ? 'resolved' : ''}" data-issue-index="${index}">
            <div class="issue-column-header">
              <div class="device-badge">
                <span class="device-icon-small">📱</span>
                <span class="device-label">${escapeHtml(deviceInfo.model)}</span>
              </div>
              <span class="issue-badge ${statusBadge}">${statusLabel}</span>
            </div>
            <div class="issue-column-content">
              <div class="issue-title">
                <span>${escapeHtml(copy.title)}</span>
              </div>
              ${safeNotes}
              ${fixInstructionsHtml}
              <div class="issue-feedback" aria-live="polite"></div>
            </div>
            ${buttonsHtml}
          </div>
        `);
      });
    });
    
    const deviceCardsHtml = allIssueCards.length > 0
      ? `<div class="issues-grid">${allIssueCards.join('')}</div>`
      : '<div class="empty-state"><div class="empty-state-icon">✓</div><h3>All Clear!</h3><p>No outstanding issues were found for this order.</p></div>';

    const hasIssues = visibleIssues.length > 0;
    const orderStatusClass = hasIssues ? '' : 'completed';
    const orderStatusLabel = hasIssues ? 'Needs Attention' : 'All Clear';

    res.status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Issue Resolution - SecondHandCell</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
      :root {
        --site-indigo: #4f46e5;
        --site-indigo-dark: #4338ca;
        --site-green: #16a34a;
        --site-navy: #0f172a;
        color-scheme: light;
      }

      /* Utility */
      .hidden {
        display: none !important;
      }

      /* ================================
         HEADER
      ================================ */

      .site-header {
        position: sticky;
        top: 0;
        z-index: 1000;
        width: 100%;
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(14px);
        box-shadow: 0 10px 30px -20px rgba(15, 23, 42, 0.6);
        border-bottom: 1px solid rgba(226, 232, 240, 0.7);
      }

      .site-header__inner {
        max-width: 1200px;
        margin: 0 auto;
        padding: 0.65rem 1.1rem;
        display: flex;
        align-items: center;
        gap: 0.85rem;
        justify-content: space-between;
      }

      /* Logo Left */
      .logo-container-left {
        flex: 1;
        display: flex;
        align-items: center;
      }

      .logo-link {
        display: inline-flex;
        align-items: center;
        height: 2.75rem;
      }

      .logo-image {
        height: 150%;
        max-height: 4rem;
        width: auto;
      }

      /* Center Wordmark */
      .logo-text-container-center {
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.1rem;
      }

      .logo-wordmark {
        font-weight: 500;
        font-size: clamp(1.35rem, 3vw, 2.25rem);
        letter-spacing: -0.02em;
        white-space: nowrap;
      }

      .logo-wordmark__primary {
        color: #111827;
      }

      .logo-wordmark__accent {
        color: var(--site-green);
      }

      .logo-tagline {
        font-size: clamp(0.65rem, 1.2vw, 0.95rem);
        color: var(--site-green);
        margin: 0;
        white-space: nowrap;
      }

      .logo-tagline span {
        color: var(--site-navy);
        font-weight: 500;
      }

      /* Right Auth */
      .header-auth-nav {
        flex: 1;
        display: flex;
        justify-content: flex-end;
        align-items: center;
      }

      .site-header__auth-wrapper {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        position: relative;
      }

      .site-header__login {
        font-weight: 600;
        background: var(--site-indigo);
        color: #fff;
        padding: 0.55rem 1.15rem;
        border-radius: 999px;
        transition: background 0.2s ease;
        text-decoration: none;
      }

      .site-header__login:hover {
        background: var(--site-indigo-dark);
      }

      /* User circle */
      .user-monogram {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2.5rem;
        height: 2.5rem;
        border-radius: 999px;
        background: #dbeafe;
        color: #1d4ed8;
        font-weight: 600;
        cursor: pointer;
      }

      /* Dropdown */
      .auth-dropdown {
        position: absolute;
        right: 0;
        top: calc(100% + 0.35rem);
        min-width: 12rem;
        background: #fff;
        border-radius: 0.75rem;
        box-shadow: 0 20px 30px -24px rgba(15, 23, 42, 0.8);
        padding: 0.35rem 0;
        display: none;
        flex-direction: column;
        z-index: 10000;
      }

      .auth-dropdown.is-visible {
        display: flex;
      }

      .auth-dropdown a,
      .auth-dropdown button {
        padding: 0.65rem 1rem;
        text-align: left;
        font-weight: 600;
        background: transparent;
        border: none;
        color: #1f2937;
        cursor: pointer;
        text-decoration: none;
      }

      .auth-dropdown a:hover,
      .auth-dropdown button:hover {
        background: rgba(79, 70, 229, 0.08);
      }

      .btn-red-logout {
        color: #dc2626;
      }

      .btn-red-logout:hover {
        background-color: #fef2f2;
      }

      /* ================================
         BODY & MAIN CONTENT
      ================================ */
      /* ================================
         BODY & MAIN CONTENT
      ================================ */
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: #0f172a;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
      }
      .relative {
        position: relative;
      }
      .inline-flex {
        display: inline-flex;
      }
      .flex-col {
        flex-direction: column;
      }
      .items-center {
        align-items: center;
      }
      .no-underline {
        text-decoration: none;
      }
      .main-content {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 40px 24px;
      }
      .card {
        max-width: 600px;
        width: 100%;
        background: #ffffff;
        border-radius: 20px;
        box-shadow: 0 25px 60px rgba(0, 0, 0, 0.2);
        padding: 40px;
        text-align: center;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 28px;
        color: #1e293b;
        font-weight: 700;
      }
      .subtitle {
        margin: 0 0 24px;
        color: #64748b;
        font-size: 16px;
        line-height: 1.6;
      }
      .order {
        margin: 20px 0;
        font-weight: 600;
        font-size: 18px;
        color: #0f172a;
        padding: 12px 20px;
        background: #f1f5f9;
        border-radius: 10px;
        display: inline-block;
      }
      .issues {
        margin-top: 30px;
        display: grid;
        gap: 18px;
      }
      .issue-card {
        border: 2px solid #e2e8f0;
        border-radius: 16px;
        padding: 20px;
        background: linear-gradient(to bottom, #ffffff, #f8fafc);
        transition: all 0.3s ease;
      }
      .issue-card:hover {
        border-color: #cbd5e1;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      }
      .issue-header {
        display: flex;
        gap: 12px;
        justify-content: space-between;
        align-items: flex-start;
      }
      .issue-title {
        font-weight: 700;
        font-size: 17px;
        color: #1e293b;
        text-align: left;
      }
      .issue-detail {
        font-size: 14px;
        color: #64748b;
        margin-top: 6px;
        text-align: left;
      }
      .issue-status {
        font-size: 11px;
        font-weight: 700;
        padding: 6px 12px;
        border-radius: 9999px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        white-space: nowrap;
      }
      .issue-status.pending {
        background: #fef3c7;
        color: #92400e;
      }
      .issue-status.resolved {
        background: #dcfce7;
        color: #166534;
      }
      .issue-meta {
        margin-top: 12px;
        font-size: 13px;
        color: #64748b;
        text-align: left;
      }
      .issue-notes {
        margin: 12px 0 0;
        font-size: 14px;
        color: #334155;
        background: #ffffff;
        border-radius: 10px;
        padding: 12px 14px;
        border: 1px solid #e2e8f0;
        text-align: left;
      }
      .issue-button {
        margin-top: 16px;
        background: linear-gradient(135deg, #10b981, #059669);
        color: #ffffff;
        border: none;
        border-radius: 9999px;
        padding: 14px 36px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 10px 25px rgba(16, 185, 129, 0.3);
        transition: all 0.2s ease;
      }
      .issue-button:hover:not([disabled]) {
        transform: translateY(-2px);
        box-shadow: 0 14px 30px rgba(16, 185, 129, 0.4);
      }
      .issue-button[disabled] {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .issue-feedback {
        margin-top: 12px;
        font-size: 14px;
        font-weight: 500;
      }
      .fix-instructions {
        background: #eff6ff;
        border-left: 3px solid #3b82f6;
        padding: 12px 16px;
        border-radius: 8px;
        margin: 12px 0;
      }
      .fix-section {
        margin-bottom: 16px;
      }
      .fix-section-title {
        font-weight: 700;
        font-size: 14px;
        color: #1e40af;
        margin: 0 0 8px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .fix-section-content {
        font-size: 13px;
        color: #334155;
        margin: 0;
        line-height: 1.5;
      }
      .fix-reasons-list {
        margin: 0;
        padding-left: 20px;
        font-size: 13px;
        color: #334155;
      }
      .fix-reasons-list li {
        margin-bottom: 6px;
      }
      .fix-options-container {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: 12px;
      }
      .fix-option {
        background: #f0f9ff;
        border: 1px solid #bfdbfe;
        border-radius: 6px;
        padding: 12px;
      }
      .fix-option-title {
        font-weight: 700;
        font-size: 13px;
        color: #0369a1;
        margin-bottom: 8px;
      }
      .fix-prerequisite {
        font-size: 12px;
        color: #0c4a6e;
        font-style: italic;
        margin-bottom: 8px;
        padding: 6px 8px;
        background: #e0f2fe;
        border-radius: 4px;
      }
      .fix-steps {
        margin: 8px 0;
        padding-left: 20px;
        font-size: 13px;
        color: #334155;
      }
      .fix-steps li {
        margin-bottom: 6px;
        line-height: 1.4;
      }
      .fix-note {
        font-size: 12px;
        color: #7c3aed;
        margin-top: 8px;
        padding: 6px 8px;
        background: #f5f3ff;
        border-radius: 4px;
        border-left: 2px solid #7c3aed;
      }
      .after-complete {
        background: #f0fdd4;
        border-left: 3px solid #16a34a;
        margin-top: 16px;
        padding: 12px;
        border-radius: 6px;
      }
      .after-complete .fix-section-title {
        color: #166534;
      }
      .after-complete .fix-section-content {
        color: #166534;
      }

      /* ================================
         LOGIN MODAL
      ================================ */
      .shc-auth-modal {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.55);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 18px;
        z-index: 2000;
        overflow-y: auto;
      }

      .shc-auth-modal.is-visible { display: flex; }

      .shc-auth-card {
        width: min(520px, 100%);
        background: #fff;
        border-radius: 20px;
        box-shadow: 0 30px 80px -40px rgba(15,23,42,0.6);
        padding: 28px;
        position: relative;
      }

      .shc-auth-close {
        position: absolute;
        top: 12px;
        right: 12px;
        background: transparent;
        border: none;
        color: #94a3b8;
        font-size: 22px;
        cursor: pointer;
      }

      .shc-auth-tabs {
        display: grid;
        grid-template-columns: repeat(2, minmax(0,1fr));
        gap: 8px;
        margin: 16px 0 12px;
      }

      .shc-auth-tab {
        padding: 12px;
        border-radius: 12px;
        border: 1px solid #e2e8f0;
        background: #f8fafc;
        font-weight: 700;
        color: #475569;
        cursor: pointer;
      }

      .shc-auth-tab.is-active {
        border-color: #5b21b6;
        color: #111827;
        box-shadow: 0 5px 18px -12px rgba(91,33,182,0.6);
      }

      .shc-auth-field {
        width: 100%;
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid #cbd5e1;
        margin-bottom: 12px;
        font-size: 15px;
      }

      .shc-auth-primary {
        width: 100%;
        padding: 13px 16px;
        border-radius: 14px;
        border: none;
        background: linear-gradient(120deg,#5b21b6,#2563eb);
        color: #fff;
        font-weight: 800;
        cursor: pointer;
        box-shadow: 0 20px 40px -28px rgba(37,99,235,0.9);
      }

      .shc-auth-google {
        width: 100%;
        padding: 12px 16px;
        border-radius: 14px;
        border: 1px solid #e2e8f0;
        background: #fff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        font-weight: 700;
        color: #0f172a;
        cursor: pointer;
      }

      .shc-auth-or {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 14px 0;
        color: #94a3b8;
        font-size: 14px;
      }

      .shc-auth-or::before,
      .shc-auth-or::after {
        content: "";
        flex: 1;
        height: 1px;
        background: #e2e8f0;
      }

      .shc-auth-meta {
        text-align: center;
        font-size: 14px;
        color: #475569;
        margin-top: 10px;
      }

      .shc-auth-link {
        color: #2563eb;
        font-weight: 700;
        text-decoration: none;
      }

      .shc-auth-link:hover { text-decoration: underline; }

      .shc-auth-message {
        display: none;
        margin-top: 8px;
        padding: 10px 12px;
        border-radius: 12px;
        font-weight: 600;
        font-size: 14px;
      }

      .shc-auth-message.is-visible { display: block; }

      .shc-auth-message.is-error {
        background: #fef2f2;
        color: #b91c1c;
        border: 1px solid #fecdd3;
      }

      .shc-auth-message.is-success {
        background: #ecfdf3;
        color: #15803d;
        border: 1px solid #bbf7d0;
      }

      .shc-auth-google img { width: 18px; height: 18px; }

      .shc-auth-header { text-align: center; }

      .shc-auth-title {
        font-size: 24px;
        font-weight: 800;
        color: #0f172a;
        margin: 0;
      }

      .shc-auth-subtitle {
        margin: 6px 0 0;
        color: #475569;
        font-weight: 500;
      }

      .shc-auth-form { display: none; }
      .shc-auth-form.is-visible { display: block; }

      .shc-monogram {
        cursor: pointer !important;
        user-select: none;
        -webkit-user-select: none;
        pointer-events: auto !important;
      }

      .shc-auth-dropdown {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        background: #fff;
        border: 1px solid #e2e8f0;
        border-radius: 14px;
        box-shadow: 0 30px 80px -48px rgba(15,23,42,0.55);
        padding: 10px;
        min-width: 180px;
        display: none;
        z-index: 10000;
      }

      .shc-auth-dropdown.is-visible { display: block; }

      .shc-auth-dropdown a,
      .shc-auth-dropdown button {
        width: 100%;
        display: block;
        text-align: left;
        padding: 10px 12px;
        border-radius: 10px;
        color: #0f172a;
        font-weight: 600;
        border: none;
        background: transparent;
        cursor: pointer;
      }

      .shc-auth-dropdown a:hover,
      .shc-auth-dropdown button:hover {
        background: #f1f5f9;
      }
    </style>
  </head>
  <body>
    <header class="site-header site-header--mobile-compact relative" data-site-header>
      <div class="site-header__inner site-header__inner--centered">
        <div class="logo-container-left">
          <a href="https://secondhandcell.com" class="logo-link" aria-label="SecondHandCell home">
            <img
              src="https://secondhandcell.com/assets/logo.webp"
              alt="SecondHandCell Logo"
              class="logo-image"
              width="320"
              height="320"
              onerror="this.onerror=null;this.src='https://placehold.co/200x64/ffffff/1e293b?text=SecondHandCell';"
            >
          </a>
        </div>

        <div class="logo-text-container-center">
          <a href="https://secondhandcell.com" aria-label="Go to homepage" class="inline-flex flex-col items-center no-underline">
            <div class="logo-wordmark">
              <span class="logo-wordmark__primary">Second</span><span class="logo-wordmark__accent">HandCell</span>
            </div>
            <p class="logo-tagline">Turn Your Old <span>Phone Into Cash!</span></p>
          </a>
        </div>

        <nav class="header-auth-nav" aria-label="Account navigation">
          <div id="authStatusContainer" class="site-header__auth-wrapper">
            <a href="#" id="loginNavBtn" class="site-header__login">Login/Sign Up</a>
            <div id="userMonogram" class="user-monogram hidden"></div>
            <div id="authDropdown" class="auth-dropdown hidden">
              <a href="https://secondhandcell.com/my-account.html" class="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-100">My Account</a>
              <a href="https://secondhandcell.com/track-order.html" class="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-100">Track an Order</a>
              <button id="logoutBtn" class="btn-red-logout">Sign Out</button>
            </div>
          </div>
        </nav>
      </div>
    </header>
    
    <main class="main-content">
      <div class="page-header">
        <h1 class="page-title">Issue Resolution</h1>
        <p class="page-subtitle">Resolve any issues with your order below. We'll continue processing once everything is cleared.</p>
      </div>
      
      <div class="order-card">
        <div class="order-header">
          <span class="order-id">Order #${safeOrderId}</span>
          <span class="order-status ${orderStatusClass}">${orderStatusLabel}</span>
        </div>
        
        ${hasIssues ? `
          <div class="device-grid">
            ${deviceCardsHtml}
          </div>
        ` : `
          <div class="empty-state">
            <div class="empty-state-icon">✓</div>
            <div class="empty-state-title">All Clear!</div>
            <div class="empty-state-message">No issues found with this order. Great work!</div>
          </div>
        `}
      </div>
    </main>
    
    <footer class="bg-slate-800 text-white">
      <div class="container mx-auto px-4 py-12">
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div class="lg:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-8">
            <div>
              <h3 class="text-xl font-bold mb-4">SecondHandCell</h3>
              <p class="text-slate-400">Your trusted partner for selling used tech. Quick quotes, fair prices, and hassle-free service.</p>
            </div>

            <div>
              <h3 class="text-xl font-bold mb-4">Quick Links</h3>
              <ul class="space-y-2">
                <li><a href="https://secondhandcell.com/index.html" class="text-slate-400 hover:text-white transition duration-300">Home</a></li>
                <li><a href="https://secondhandcell.com/about.html" class="text-slate-400 hover:text-white transition duration-300">About Us</a></li>
                <li><a href="https://secondhandcell.com/privacy.html" class="text-slate-400 hover:text-white transition duration-300">Privacy Policy</a></li>
                <li><a href="https://secondhandcell.com/terms.html" class="text-slate-400 hover:text-white transition duration-300">Terms &amp; Conditions</a></li>
              </ul>
            </div>

            <div>
              <h3 class="text-xl font-bold mb-4">Contact Us</h3>
              <p class="text-slate-400">Email: support@secondhandcell.com</p>
            </div>
          </div>

          <div class="bg-slate-700 p-6 rounded-lg">
            <h3 class="text-xl font-bold mb-2 text-white">Stay Updated</h3>
            <p class="text-slate-300 mb-4">Sign up for updates, price increases, and more!</p>
            <form id="footerEmailSignupForm" class="flex flex-col sm:flex-row gap-2">
              <input
                type="email"
                id="footerEmail"
                placeholder="Enter your email"
                class="w-full flex-grow border border-slate-400 bg-slate-800 text-white p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              >
              <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-blue-700">Sign Up</button>
            </form>
            <div id="footerSignupMessage" class="mt-3 text-sm text-center"></div>
          </div>
        </div>

        <div class="bg-slate-800 text-white p-6 rounded-xl shadow-lg mt-8 text-center border-2 border-red-600">
          <p class="text-lg font-bold">IMPORTANT NOTICE</p>
          <p class="mt-2 text-sm md:text-base">We do not purchase blacklisted or lost/stolen devices. All devices are verified through a legal compliance check.</p>
        </div>

        <div class="mt-8">
          <div class="flex flex-wrap items-center justify-center gap-6 sm:flex-row sm:justify-center sm:gap-8 lg:justify-start">
            <a href="https://www.sellcell.com/" target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center">
              <img
                src="https://secondhandcell.com/assets/sellcell.webp"
                width="150"
                height="107"
                alt="SellCell Accredited Buyer"
                loading="lazy"
                class="h-20 w-auto object-contain"
              >
            </a>

            <a href="https://www.trustpilot.com/evaluate/secondhandcell.com" target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center">
              <img
                src="https://secondhandcell.com/assets/stars-4.svg"
                alt="Trustpilot 5 star rating"
                loading="lazy"
                class="h-12 w-auto object-contain"
              >
            </a>
          </div>
        </div>

        <div class="border-t border-slate-700 mt-8 pt-6 text-center text-slate-400 text-sm">
          <p>&copy; 2026 SecondHandCell. All rights reserved.</p>
        </div>
      </div>
    </footer>
    <script>
      (function () {
        var buttons = document.querySelectorAll('.issue-button');
        function setFeedback(container, message, color) {
          if (!container) return;
          container.textContent = message;
          container.style.color = color || '#475569';
        }
        buttons.forEach(function (button) {
          button.addEventListener('click', function () {
            if (button.disabled) return;
            var deviceKey = button.getAttribute('data-device-key');
            var reason = button.getAttribute('data-reason');
            var action = button.getAttribute('data-action') || 'resolve';
            var card = button.closest('.issue-card');
            var feedback = card ? card.querySelector('.issue-feedback') : null;
            var statusLabel = card ? card.querySelector('.issue-status') : null;
            button.disabled = true;
            
            var actionMessage = action === 'received' ? 'Marking as received...' : 'Sending confirmation...';
            var successMessage = action === 'received' ? 'Marked as received!' : 'Confirmed. Thank you!';
            
            setFeedback(feedback, actionMessage, '#64748b');
            fetch('${confirmUrl}', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceKey: deviceKey, reason: reason, action: action }),
            })
              .then(function (response) {
                if (!response.ok) {
                  throw new Error('Request failed. Please try again.');
                }
                return response.json();
              })
              .then(function () {
                setFeedback(feedback, successMessage, '#16a34a');
                if (statusLabel) {
                  statusLabel.textContent = action === 'received' ? 'Received' : 'Resolved';
                  statusLabel.classList.remove('pending');
                  statusLabel.classList.add('resolved');
                }
              })
              .catch(function (error) {
                button.disabled = false;
                setFeedback(feedback, error.message || 'Unable to process. Please try again.', '#dc2626');
              });
          });
        });
      })();
    </script>

    <script type="module" src="https://secondhandcell.com/assets/js/global-auth.js" defer></script>

    <script>
      const createModal = () => {
        if (document.getElementById("loginModal")) return document.getElementById("loginModal");

        const overlay = document.createElement("div");
        overlay.id = "loginModal";
        overlay.className = "shc-auth-modal";
        overlay.style.display = "none";

        overlay.innerHTML = \`
          <div class="shc-auth-card" role="dialog" aria-modal="true" aria-labelledby="shc-auth-title">
            <button class="shc-auth-close" type="button" aria-label="Close authentication modal">&times;</button>
            <div class="shc-auth-header">
              <p class="shc-auth-title" id="shc-auth-title">Your SecondHandCell Account</p>
              <p class="shc-auth-subtitle">Sign in or create an account to keep your quote in sync.</p>
            </div>
            <div class="shc-auth-tabs" role="tablist">
              <button class="shc-auth-tab is-active" id="loginTabBtn" type="button" data-tab="login">Login</button>
              <button class="shc-auth-tab" id="signupTabBtn" type="button" data-tab="signup">Sign Up</button>
            </div>
            <div id="authMessage" class="shc-auth-message" role="alert"></div>

            <form id="loginForm" class="shc-auth-form is-visible" novalidate>
              <button type="button" id="googleLoginBtn" class="shc-auth-google">
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google icon"/>
                Login with Google
              </button>
              <div class="shc-auth-or"><span>or</span></div>
              <input type="email" id="loginEmail" class="shc-auth-field" placeholder="Email address" autocomplete="email" required />
              <input type="password" id="loginPassword" class="shc-auth-field" placeholder="Password" autocomplete="current-password" required />
              <button type="submit" class="shc-auth-primary">Login</button>
              <p class="shc-auth-meta">Forgot your password? <a href="#" id="forgotPasswordLink" class="shc-auth-link" onclick="event.preventDefault()">Reset it</a></p>
            </form>

            <form id="signupForm" class="shc-auth-form" novalidate>
              <button type="button" id="googleSignupBtn" class="shc-auth-google">
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google icon"/>
                Sign up with Google
              </button>
              <div class="shc-auth-or"><span>or</span></div>
              <input type="text" id="signupName" class="shc-auth-field" placeholder="Full name" autocomplete="name" required />
              <input type="email" id="signupEmail" class="shc-auth-field" placeholder="Email address" autocomplete="email" required />
              <input type="password" id="signupPassword" class="shc-auth-field" placeholder="Password (min 6 characters)" autocomplete="new-password" required />
              <button type="submit" class="shc-auth-primary">Create Account</button>
              <p class="shc-auth-meta">Already have an account? <a href="#" id="switchToLogin" class="shc-auth-link" onclick="event.preventDefault()">Login</a></p>
            </form>
          </div>
        \`;

        document.body.appendChild(overlay);
        
        // Setup event listeners
        const closeBtn = overlay.querySelector('.shc-auth-close');
        const loginTabBtn = overlay.querySelector('#loginTabBtn');
        const signupTabBtn = overlay.querySelector('#signupTabBtn');
        const switchToLoginLink = overlay.querySelector('#switchToLogin');
        
        const closeModal = () => {
          overlay.style.display = 'none';
        };
        
        const showTab = (tabName) => {
          const forms = overlay.querySelectorAll('.shc-auth-form');
          const tabs = overlay.querySelectorAll('.shc-auth-tab');
          forms.forEach(f => f.classList.remove('is-visible'));
          tabs.forEach(t => t.classList.remove('is-active'));
          
          overlay.querySelector('#' + (tabName === 'login' ? 'loginForm' : 'signupForm')).classList.add('is-visible');
          overlay.querySelector('#' + (tabName === 'login' ? 'loginTabBtn' : 'signupTabBtn')).classList.add('is-active');
        };
        
        closeBtn.addEventListener('click', closeModal);
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) closeModal();
        });
        
        loginTabBtn.addEventListener('click', () => showTab('login'));
        signupTabBtn.addEventListener('click', () => showTab('signup'));
        switchToLoginLink.addEventListener('click', (e) => {
          e.preventDefault();
          showTab('login');
        });
        
        return overlay;
      };

      // Initialize modal on page load
      document.addEventListener('DOMContentLoaded', () => {
        createModal();
        
        // Look for any elements that should trigger the modal
        document.addEventListener('click', (e) => {
          if (e.target.matches('[data-login-modal]') || e.target.closest('[data-login-modal]')) {
            e.preventDefault();
            const modal = document.getElementById('loginModal');
            if (modal) {
              modal.style.display = 'flex';
            }
          }
        });
      });
    </script>
  </body>
</html>`);
  } catch (error) {
    console.error('Failed to load fix-issue page:', error);
    return res.status(500).send('Unable to load issue resolution page.');
  }
});

app.post('/fix-issue/:orderId/confirm', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    if (!orderId) {
      return res.status(400).json({ error: 'Order ID is required.' });
    }

    const reason = normalizeIssueReason(req.body?.reason);
    const deviceKey = typeof req.body?.deviceKey === 'string' && req.body.deviceKey.trim()
      ? req.body.deviceKey.trim()
      : buildOrderDeviceKey(orderId, 0);
    if (!reason) {
      return res.status(400).json({ error: 'Issue reason is required.' });
    }

    const orderRef = ordersCollection.doc(orderId);
    const snapshot = await orderRef.get();
    if (!snapshot.exists) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const order = { id: snapshot.id, ...snapshot.data() };

    const updatePayload = {};
    const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();

    updatePayload[`qcIssuesByDevice.${deviceKey}.${reason}.resolvedAt`] = serverTimestamp;
    updatePayload[`qcIssuesByDevice.${deviceKey}.${reason}.resolved`] = true;
    updatePayload[`qcIssuesByDevice.${deviceKey}.${reason}.updatedAt`] = serverTimestamp;

    const updatedOrder = {
      ...order,
      qcIssuesByDevice: {
        ...(order.qcIssuesByDevice || {}),
        [deviceKey]: {
          ...((order.qcIssuesByDevice || {})[deviceKey] || {}),
          [reason]: {
            ...(((order.qcIssuesByDevice || {})[deviceKey] || {})[reason] || {}),
            resolved: true,
          },
        },
      },
    };

    const allIssues = buildIssueList(updatedOrder);
    const unresolvedIssues = allIssues.filter((issue) => !issue.resolved);
    const hasUnresolved = unresolvedIssues.length > 0;

    updatePayload.qcAwaitingResponse = hasUnresolved;

    const deviceIssues = allIssues.filter((issue) => issue.deviceKey === deviceKey);
    const deviceHasUnresolved = deviceIssues.some((issue) => !issue.resolved);
    updatePayload[`deviceStatusByKey.${deviceKey}`] = deviceHasUnresolved
      ? 'emailed'
      : 'issue_resolved';

    if (hasUnresolved) {
      updatePayload.status = 'emailed';
    }

    const logEntries = [
      {
        type: 'status_change',
        message: 'Customer confirmed issue resolved via fix-issue page.',
      },
    ];

    await updateOrderBoth(orderId, updatePayload, {
      autoLogStatus: false,
      logEntries,
    });

    return res.json({ ok: true, orderId, unresolvedCount: unresolvedIssues.length });
  } catch (error) {
    console.error('Failed to confirm issue resolution:', error);
    return res.status(500).json({ error: 'Unable to confirm issue resolution.' });
  }
});

const handleVerifyAddress = async (req, res) => {
  const {
    streetAddress,
    addressUnit,
    city,
    state,
    zip,
    country,
  } = req.body?.address || {};

  if (!streetAddress || !city || !state || !zip) {
    return res.status(400).json({ error: "Missing required address fields." });
  }

  const shipengineKey = getShipEngineApiKey();
  if (!shipengineKey) {
    return res.status(500).json({ error: "ShipEngine API key not configured." });
  }

  const payload = [
    {
      address_line1: streetAddress,
      address_line2: addressUnit || "",
      city_locality: city,
      state_province: state,
      postal_code: zip,
      country_code: country || "US",
    },
  ];

  try {
    const response = await axios.post(
      `${SHIPENGINE_API_BASE_URL}/addresses/validate`,
      payload,
      { headers: { "API-Key": shipengineKey } }
    );

    const result = Array.isArray(response.data) ? response.data[0] : response.data;
    const status = String(
      result?.status || result?.status_code || result?.validation_status || ""
    ).toLowerCase();

    return res.json({
      status,
      originalAddress: result?.original_address || payload[0],
      matchedAddress: result?.matched_address || null,
      messages: result?.messages || [],
    });
  } catch (error) {
    console.error(
      "ShipEngine address validation failed:",
      error.response?.data || error.message
    );
    return res.status(502).json({
      error: "Address validation failed.",
      detail: error.response?.data || error.message,
    });
  }
};

app.post("/verify-address", handleVerifyAddress);

app.post("/checkImei", async (req, res) => {
  const {
    orderId: requestOrderId,
    deviceId: requestDeviceId,
    imei: imeiRaw,
    carrier: carrierOverride,
    deviceType: deviceTypeOverride,
    brand: brandOverride,
    checkAll,
  } = req.body || {};

  const imei = typeof imeiRaw === "string" ? imeiRaw.trim() : "";

  if (!isValidImei(imei)) {
    return res.status(400).json({ error: "Invalid IMEI. Expecting a 15-digit Luhn-compliant value." });
  }

  let orderId = sanitizeDocumentId(requestOrderId);
  let deviceDocId = sanitizeDocumentId(requestDeviceId);

  if (!orderId && !deviceDocId) {
    return res.status(400).json({ error: "orderId or deviceId is required." });
  }

  let orderRef = orderId ? ordersCollection.doc(orderId) : null;
  let orderData = null;

  if (orderRef) {
    try {
      const snapshot = await orderRef.get();
      if (snapshot.exists) {
        orderData = snapshot.data() || {};
      } else {
        orderId = null;
        orderRef = null;
      }
    } catch (error) {
      console.error(`Failed to load order ${orderId} for IMEI check:`, error);
      return res.status(500).json({ error: "Failed to load order for IMEI check." });
    }
  }

  let deviceRef = deviceDocId ? devicesCollection.doc(deviceDocId) : null;
  let deviceData = null;

  if (deviceRef) {
    try {
      const snapshot = await deviceRef.get();
      if (snapshot.exists) {
        deviceData = snapshot.data() || {};
      } else {
        deviceDocId = null;
        deviceRef = null;
      }
    } catch (error) {
      console.error(`Failed to load device ${deviceDocId} for IMEI check:`, error);
      return res.status(500).json({ error: "Failed to load device for IMEI check." });
    }
  }

  if (!orderData && deviceData) {
    const derivedOrderId = resolveOrderIdFromDevice(deviceData);
    if (derivedOrderId) {
      orderId = derivedOrderId;
      orderRef = ordersCollection.doc(orderId);
      try {
        const snapshot = await orderRef.get();
        if (snapshot.exists) {
          orderData = snapshot.data() || {};
        } else {
          orderId = null;
          orderRef = null;
        }
      } catch (error) {
        console.error(`Failed to load derived order ${orderId} for IMEI check:`, error);
        return res.status(500).json({ error: "Failed to load derived order for IMEI check." });
      }
    }
  }

  if (!deviceDocId && orderData) {
    const derivedDeviceDocId = resolveDeviceDocumentIdFromOrder(orderData);
    if (derivedDeviceDocId) {
      deviceDocId = derivedDeviceDocId;
      deviceRef = devicesCollection.doc(deviceDocId);
      try {
        const snapshot = await deviceRef.get();
        if (snapshot.exists) {
          deviceData = { ...(deviceData || {}), ...(snapshot.data() || {}) };
        }
      } catch (error) {
        console.error(`Failed to load derived device ${deviceDocId} for IMEI check:`, error);
      }
    }
  }

  if (!orderData && !deviceData) {
    return res.status(404).json({ error: "Device or order record not found." });
  }

  const statusCandidates = [
    normalizeStatusValue(orderData?.status),
    normalizeStatusValue(orderData?.currentStatus),
    normalizeStatusValue(orderData?.deviceStatus),
    normalizeStatusValue(deviceData?.status),
    normalizeStatusValue(deviceData?.currentStatus),
    normalizeStatusValue(deviceData?.deviceStatus),
  ].filter(Boolean);
  const status = statusCandidates[0] || null;

  if (status && !isStatusEligibleForImeiCheck(status)) {
    return res.status(400).json({ error: "Device status must be received before running an IMEI check." });
  }

  const carrier = pickFirstString(
    carrierOverride,
    orderData?.carrier,
    orderData?.carrierName,
    orderData?.device?.carrier,
    deviceData?.carrier,
    deviceData?.carrierName,
    deviceData?.device?.carrier,
  );

  const brand = pickFirstString(
    brandOverride,
    orderData?.brand,
    orderData?.manufacturer,
    orderData?.deviceBrand,
    orderData?.device?.brand,
    deviceData?.brand,
    deviceData?.brandName,
    deviceData?.manufacturer,
    deviceData?.device?.brand,
  );

  const deviceType = pickFirstString(
    deviceTypeOverride,
    orderData?.deviceType,
    orderData?.device_category,
    orderData?.category,
    deviceData?.deviceType,
    deviceData?.device_category,
    deviceData?.category,
  );

  let checkAllFlag = false;
  if (typeof checkAll === 'boolean') {
    checkAllFlag = checkAll;
  } else if (typeof checkAll === 'number') {
    checkAllFlag = checkAll !== 0;
  } else if (typeof checkAll === 'string') {
    checkAllFlag = ['1', 'true', 'yes'].includes(checkAll.trim().toLowerCase());
  }

  let esnResult;
  try {
    esnResult = await checkEsn({
      imei,
      carrier,
      brand,
      deviceType,
      checkAll: checkAllFlag,
    });
  } catch (error) {
    console.error('Phonecheck ESN request failed:', error);
    if (error.code && typeof error.code === 'string' && error.code.startsWith('phonecheck/')) {
      const statusCode = typeof error.status === 'number' ? error.status : 502;
      return res.status(statusCode >= 400 ? statusCode : 502).json({
        error: error.message || 'Phonecheck IMEI lookup failed.',
      });
    }
    return res.status(502).json({ error: 'Failed to verify IMEI with Phonecheck.' });
  }

  let carrierLockResult = null;
  const appleHintValues = [
    brand,
    deviceType,
    orderData?.brand,
    orderData?.device?.brand,
    orderData?.device?.model,
    orderData?.category,
    deviceData?.brand,
    deviceData?.device?.brand,
    deviceData?.device?.model,
    esnResult?.normalized?.brand,
    esnResult?.normalized?.model,
    esnResult?.normalized?.deviceName,
  ];

  if (isAppleDeviceHint(...appleHintValues)) {
    try {
      carrierLockResult = await checkCarrierLock({
        imei,
        deviceType: 'Apple',
      });
    } catch (carrierError) {
      console.error('Phonecheck carrier lock request failed:', carrierError);
    }
  }

  let samsungCarrierInfoResult = null;
  const samsungHintValues = [
    brand,
    deviceType,
    orderData?.brand,
    orderData?.manufacturer,
    orderData?.device?.brand,
    orderData?.device?.model,
    deviceData?.brand,
    deviceData?.manufacturer,
    deviceData?.device?.brand,
    deviceData?.device?.model,
    esnResult?.normalized?.brand,
    esnResult?.normalized?.model,
    esnResult?.normalized?.deviceName,
  ];

  if (isSamsungDeviceHint(...samsungHintValues)) {
    try {
      samsungCarrierInfoResult = await checkSamsungCarrierInfo({
        identifier: imei,
      });
    } catch (samsungError) {
      console.error('Phonecheck Samsung carrier info request failed:', samsungError);
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

  const updatePayload = {
    imei,
    imeiChecked: true,
    imeiCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
    imeiCheckResult: normalized,
  };

  if (typeof normalized.blacklisted === 'boolean') {
    updatePayload.status = normalized.blacklisted ? 'blacklisted' : 'imei_checked';
  }

  const updateTasks = [];

  if (orderId) {
    updateTasks.push(
      updateOrderBoth(orderId, updatePayload, {
        autoLogStatus: false,
        skipStatusTimestamp: typeof updatePayload.status === 'undefined',
      })
    );
  }

  if (deviceDocId) {
    updateTasks.push(
      devicesCollection
        .doc(deviceDocId)
        .set(updatePayload, { merge: true })
    );
  }

  try {
    await Promise.all(updateTasks);
  } catch (error) {
    console.error('Failed to persist IMEI results:', error);
    return res.status(500).json({ error: 'Failed to persist IMEI check results.' });
  }

  return res.json({ ok: true, result: normalized });
});

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const EMAIL_LOGO_URL =
  "https://secondhandcell.com/assets/logo-white.webp";
const COUNTDOWN_NOTICE_TEXT =
  "If we don't hear back, we may finalize your order at 75% less to keep your order moving.";
const TRUSTPILOT_REVIEW_LINK = "https://www.trustpilot.com/evaluate/secondhandcell.com";
const TRUSTPILOT_STARS_IMAGE_URL = "https://cdn.trustpilot.net/brand-assets/4.1.0/stars/stars-5.png";
function buildCountdownNoticeHtml() {
  return `
    <div style="margin-top: 24px; padding: 18px 20px; background-color: #ecfdf5; border-radius: 12px; border: 1px solid #bbf7d0; color: #065f46; font-size: 17px; line-height: 1.6;">
      <strong style="display:block; font-size:18px; margin-bottom:8px;">Friendly reminder</strong>
      If we don't hear back, we may finalize your device at <strong>75% less</strong> to keep your order moving.
    </div>
  `;
}

function appendCountdownNotice(text = "") {
  const trimmed = text.trim();
  if (!trimmed) {
    return COUNTDOWN_NOTICE_TEXT;
  }
  if (trimmed.includes(COUNTDOWN_NOTICE_TEXT)) {
    return trimmed;
  }
  return `${trimmed}\n\n${COUNTDOWN_NOTICE_TEXT}`;
}

const EXPIRING_REMINDER_ALLOWED_STATUSES = new Set([
  "order_pending",
  "shipping_kit_requested",
  "kit_needs_printing",
  "needs_printing",
  "label_generated",
  "emailed",
  "kit_on_the_way_to_us",
  KIT_TRANSIT_STATUS,
  PHONE_TRANSIT_STATUS,
  "phone_on_the_way",
]);

const KIT_REMINDER_ALLOWED_STATUSES = new Set([
  "kit_sent",
  "kit_delivered",
  "kit_on_the_way_to_us",
  KIT_TRANSIT_STATUS,
]);

const MANUAL_AUTO_REQUOTE_INELIGIBLE_STATUSES = new Set([
  'completed',
  'cancelled',
  'return-label-generated',
  're-offered-accepted',
  're-offered-declined',
  're-offered-auto-accepted',
  'requote_accepted',
]);
const AUTO_CANCEL_DELAY_MS = 15 * 24 * 60 * 60 * 1000;
const AUTO_CANCEL_MONITORED_STATUSES = [
  "order_pending",
  "shipping_kit_requested",
  "kit_needs_printing",
  "kit_sent",
  KIT_TRANSIT_STATUS,
  "kit_in_transit",
  "kit_on_the_way_to_us",
  "label_generated",
  "emailed",
  PHONE_TRANSIT_STATUS,
  "phone_on_the_way",
];

const AUTO_CANCELLATION_ENABLED = false;

const LABEL_REMINDER_STATUSES = new Set(["label_generated", "emailed"]);
const LABEL_REMINDER_FIRST_DELAY_MS = 5 * 24 * 60 * 60 * 1000;
const LABEL_REMINDER_SECOND_DELAY_MS = 10 * 24 * 60 * 60 * 1000;
const LABEL_REMINDER_MIN_GAP_MS = 24 * 60 * 60 * 1000;

const RETURN_REMINDER_DELAY_MS = 13 * 24 * 60 * 60 * 1000;
const RETURN_AUTO_VOID_DELAY_MS = 15 * 24 * 60 * 60 * 1000;
const INBOUND_TRACKABLE_STATUSES = new Set([
  "kit_delivered",
  KIT_TRANSIT_STATUS,
  "delivered_to_us",
  "kit_on_the_way_to_us",
  "label_generated",
  "emailed",
  PHONE_TRANSIT_STATUS,
  "phone_on_the_way",
]);

const CONDITION_EMAIL_FROM_ADDRESS =
  process.env.CONDITION_EMAIL_FROM ||
  process.env.EMAIL_FROM ||
  process.env.EMAIL_USER ||
  "no-reply@secondhandcell.com";

const CONDITION_EMAIL_BCC_RECIPIENTS = (process.env.CONDITION_EMAIL_BCC ||
  process.env.SALES_EMAIL ||
  "sales@secondhandcell.com")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const CONDITION_EMAIL_TEMPLATES = {
  outstanding_balance: {
    subject: "Action Required: Outstanding Balance Detected",
    headline: "Outstanding balance detected",
    message:
      "Our ESN verification shows the carrier still reports an outstanding balance tied to this device.",
    steps: [
      "Contact your carrier to clear the remaining balance on the device.",
      "Reply to this email with confirmation so we can re-run the check and release your payout.",
    ],
    showResolvedButton: true,
  },
  password_locked: {
    subject: "Device Locked: Action Needed",
    headline: "Device is password or account locked",
    message:
      "The device arrived locked with a password, pattern, or linked account which prevents testing and data removal.",
    steps: [
      "Send us the any passcode, password, PIN, or pattern required to unlock the device so that we can properly inspect it amd data wipe it.",
      "Reply to this email once the lock has been cleared so we can finish processing the order.",
    ],
    showResolvedButton: true,
  },
  stolen: {
    subject: "Important: Device Reported Lost or Stolen",
    headline: "Device flagged as lost or stolen",
    message:
      "The carrier database has flagged this ESN/IMEI as lost or stolen, so we cannot complete the buyback.",
    steps: [
      "If you believe this is an error, please contact your carrier to remove the flag.",
      "Provide any supporting documentation by replying to this email so we can review and re-run the check.",
    ],
    showResolvedButton: true,
  },
  fmi_active: {
    subject: "Find My / Activation Lock Detected",
    headline: "Find My or activation lock is still enabled",
    message:
      "The device still has Find My iPhone / Activation Lock (or the Android equivalent) enabled, which prevents refurbishment.",
    steps: [
      "Disable the lock from the device or from iCloud/Google using your account.",
      "Remove the device from your trusted devices list.",
      "Reply to this email once the lock has been removed so we can verify and continue.",
    ],
    showResolvedButton: true,
  },
};

function getGreetingName(fullName) {
  if (!fullName || typeof fullName !== "string") {
    return "there";
  }
  const [first] = fullName.trim().split(/\s+/);
  return first || "there";
}

function buildConditionEmail(reason, order, notes, deviceKey = null) {
  const template = CONDITION_EMAIL_TEMPLATES[reason];
  if (!template) {
    throw new Error("Unsupported condition email template.");
  }

  const shippingInfo = order && order.shippingInfo ? order.shippingInfo : {};
  const customerName = shippingInfo.fullName || shippingInfo.name || null;
  const greetingName = getGreetingName(customerName);
  const orderId = (order && order.id) || "your order";
  const trimmedNotes = typeof notes === "string" ? notes.trim() : "";

  const noteHtml = trimmedNotes
    ? `<p style="margin-top:16px;"><strong>Additional details from our technician:</strong><br>${escapeHtml(
        trimmedNotes
      ).replace(/\n/g, "<br>")}</p>`
    : "";
  const noteText = trimmedNotes
    ? `\n\nAdditional details from our technician:\n${trimmedNotes}`
    : "";

  const steps = Array.isArray(template.steps) ? template.steps : [];
  const stepsHtml = steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("");
  const stepsText = steps.map((step) => `• ${step}`).join("\n");

  const accentColorMap = {
    outstanding_balance: "#f97316",
    password_locked: "#6366f1",
    stolen: "#dc2626",
    fmi_active: "#f59e0b",
  };

  const deviceKeyParam = deviceKey ? `?deviceKey=${encodeURIComponent(deviceKey)}` : '';
  const resolvedButtonHtml = template.showResolvedButton
    ? `
      <div style="text-align:center; margin:32px 0 24px;">
        <a href="https://api.secondhandcell.com/api/orders/${escapeHtml(orderId)}/issue-resolved${deviceKeyParam}" 
           style="display:inline-block; padding:14px 32px; border-radius:9999px; background-color:#10b981; color:#ffffff !important; font-weight:600; text-decoration:none; font-size:17px; box-shadow:0 4px 12px rgba(16,185,129,0.3);">
          ✓ Issue Resolved
        </a>
        <p style="font-size:14px; color:#64748b; margin-top:12px;">Click this button once you've fixed the issue</p>
      </div>
    `
    : "";

  const bodyHtml = `
      <p>Hi ${escapeHtml(greetingName)},</p>
      <p>During our inspection of the device you sent in for order <strong>#${escapeHtml(orderId)}</strong>, we detected an issue:</p>
      <div style="background:#fff7ed; border-radius:14px; border:1px solid #fde68a; padding:18px 22px; margin:24px 0; color:#7c2d12;">
        <strong>${escapeHtml(template.headline)}</strong>
        <p style="margin:12px 0 0; color:#7c2d12;">${escapeHtml(template.message)}</p>
      </div>
      <p style="margin-bottom:16px;">Here's what to do next:</p>
      <ul style="padding-left:22px; color:#475569; margin:0 0 24px;">
        ${stepsHtml}
      </ul>
      ${noteHtml}
      <p>Reply to this email once you've taken care of the issue so we can recheck your device and keep your payout moving.</p>
      ${resolvedButtonHtml}
  `;

  const html = buildEmailLayout({
    title: template.headline,
    accentColor: accentColorMap[reason] || "#0ea5e9",
    includeTrustpilot: false,
    bodyHtml,
    includeCountdownNotice: true,
  });

  const text = appendCountdownNotice(`Hi ${greetingName},

During our inspection of the device you sent in for order #${orderId}, we detected an issue:

${template.headline}

${template.message}

${stepsText}${noteText}

Please reply to this email once the issue has been resolved so we can continue processing your payout.

Thank you,
SecondHandCell Team`);

  return { subject: template.subject, html, text };
}

const SHIPENGINE_API_BASE_URL = "https://api.shipengine.com/v1";
const AUTO_VOID_DELAY_MS = 28 * 24 * 60 * 60 * 1000; // 28 days
const AUTO_VOID_QUERY_LIMIT = 50;
const AUTO_VOID_RETRY_DELAY_MS = 12 * 60 * 60 * 1000; // 12 hours between automatic retry attempts
const AUTO_TRACKING_REFRESH_QUERY_LIMIT = 200;
const TRACKING_REFRESH_MIN_INTERVAL_MS = Math.max(
  0,
  Number(process.env.TRACKING_REFRESH_MIN_INTERVAL_MS || 10 * 60 * 1000)
);
const ADMIN_BULK_VOID_MIN_DAYS_DEFAULT = 27;
const ADMIN_BULK_VOID_QUERY_LIMIT = Math.max(50, Number(process.env.ADMIN_BULK_VOID_QUERY_LIMIT || 500));
const ADMIN_BULK_VOID_MAX_PER_RUN = Math.max(1, Number(process.env.ADMIN_BULK_VOID_MAX_PER_RUN || 12));
const TEST_ORDER_EMAILS = new Set(['eesetton@gmail.com', 'saulsetton16@gmail.com']);
const TEST_ORDER_ADDRESS_NEEDLE = '1966 west 3rd st';
const AUTO_REDUCED_PAYOUT_DELAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const AUTO_REDUCED_PAYOUT_QUERY_LIMIT = 300;
let automaticInboundTrackingRefreshInProgress = false;


function formatOrderAgeInDays(order = {}) {
  const anchorDate = toDate(order.labelGeneratedAt || order.kitLabelGeneratedAt || order.createdAt);
  if (!anchorDate) return 'Unknown';
  const days = (Date.now() - anchorDate.getTime()) / (24 * 60 * 60 * 1000);
  return `${days.toFixed(1)} days`;
}

function buildVoidedLabelCustomerEmail(order, approvedResults, options = {}) {
  const customerName = escapeHtml(order?.shippingInfo?.fullName || 'there');
  const orderId = escapeHtml(order?.id || '');
  const ageDescription = escapeHtml(options.ageDescription || formatOrderAgeInDays(order));
  const labelsMarkup = approvedResults
    .map((result) => {
      const labelName = escapeHtml(formatLabelDisplayNameFromKey(result.key));
      const labelId = escapeHtml(result.labelId || 'N/A');
      return `<li><strong>${labelName}</strong><span>Label ID: ${labelId}</span></li>`;
    })
    .join('');

  return `
    <style>
      .void-email-card { max-width: 640px; margin: 0 auto; padding: 28px; border-radius: 20px; background: #0f172a; color: #e2e8f0; font-family: Inter, Arial, sans-serif; }
      .void-email-card h1 { margin: 0 0 14px; font-size: 24px; color: #f8fafc; }
      .void-email-card p { margin: 0 0 14px; line-height: 1.6; }
      .void-email-card .meta { margin: 18px 0; padding: 14px 16px; border-radius: 14px; background: rgba(148, 163, 184, 0.18); }
      .void-email-card ul { margin: 12px 0 0; padding-left: 20px; }
      .void-email-card li { margin: 8px 0; }
      .void-email-card li span { display: block; color: #cbd5e1; font-size: 13px; }
    </style>
    <div class="void-email-card">
      <h1>Order #${orderId} cancelled</h1>
      <p>Hi ${customerName},</p>
      <p>Your prepaid shipping label has been voided automatically because we did not receive a response and your device was not sent in within the last 28 days.</p>
      <div class="meta">
        <p><strong>Order status:</strong> Cancelled</p>
        <p><strong>Order age:</strong> ${ageDescription}</p>
      </div>
      <p>The following label(s) were cancelled:</p>
      <ul>${labelsMarkup}</ul>
      <p style="margin-top:18px;">If you still want to sell your device, reply to this email and we can create a new label for you.</p>
      <p>— SecondHandCell Team</p>
    </div>
  `;
}

function buildManualVoidShippingCleanupPayload() {
  const cleanupFields = [
    'trackingNumber',
    'inboundTrackingNumber',
    'outboundTrackingNumber',
    'returnTrackingNumber',
    'uspsLabelUrl',
    'returnLabelUrl',
    'inboundLabelUrl',
    'outboundLabelUrl',
    'labelPdfUrl',
    'labelDownloadUrl',
    'labelDeliveryMethod',
    'labelTrackingStatus',
    'labelTrackingStatusDescription',
    'labelTrackingCarrierCode',
    'labelTrackingCarrierStatusCode',
    'labelTrackingCarrierStatusDescription',
    'labelTrackingEstimatedDelivery',
    'labelTrackingEvents',
    'labelTrackingLastSyncedAt',
    'outboundTrackingStatus',
    'outboundTrackingStatusDescription',
    'outboundTrackingCarrierCode',
    'outboundTrackingCarrierStatusCode',
    'outboundTrackingCarrierStatusDescription',
    'outboundTrackingEstimatedDelivery',
    'outboundTrackingEvents',
    'outboundTrackingLastSyncedAt',
    'shipEngineLabels',
    'shipEngineLabelId',
    'shipEngineLabelIds',
    'shipEngineLabelsLastUpdatedAt',
    'labelVoidStatus',
    'labelVoidMessage',
    'labelVoidedAt',
    'hasShipEngineLabel',
    'hasActiveShipEngineLabel',
    'kitLabelGeneratedAt',
    'emailedAt',
  ];

  const payload = {};
  for (const key of cleanupFields) {
    payload[key] = admin.firestore.FieldValue.delete();
  }
  payload.shippingLabelManuallyVoidedAt = admin.firestore.FieldValue.serverTimestamp();
  return payload;
}

function getShipEngineApiKey() {
  try {
    if (functions.config().shipengine && functions.config().shipengine.key) {
      return functions.config().shipengine.key;
    }
  } catch (error) {
    console.warn("Unable to read functions.config().shipengine.key:", error.message);
  }
  return process.env.SHIPENGINE_KEY || null;
}

function getLabelVoidNotificationEmail() {
  try {
    if (
      functions.config().notifications &&
      functions.config().notifications.void_labels_to
    ) {
      return functions.config().notifications.void_labels_to;
    }
    if (functions.config().email && functions.config().email.user) {
      return functions.config().email.user;
    }
  } catch (error) {
    console.warn("Unable to read notification email config:", error.message);
  }
  return (
    process.env.LABEL_VOID_NOTIFICATIONS_TO ||
    process.env.VOID_NOTIFICATION_EMAIL ||
    process.env.EMAIL_USER ||
    null
  );
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === "object") {
    if (typeof value.seconds === "number") {
      return new Date(value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6));
    }
    if (typeof value._seconds === "number") {
      return new Date(
        value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6)
      );
    }
  }
  return null;
}

function normalizeAddressText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getOrderAgeInDays(order = {}) {
  const anchorDate = toDate(order.labelGeneratedAt || order.kitLabelGeneratedAt || order.emailedAt || order.createdAt);
  if (!anchorDate) {
    return null;
  }
  const ageDays = (Date.now() - anchorDate.getTime()) / (24 * 60 * 60 * 1000);
  return Number.isFinite(ageDays) ? Number(ageDays.toFixed(1)) : null;
}

function getPendingVoidSelections(order = {}) {
  const labels = normalizeShipEngineLabelMap(order);
  return Object.entries(labels)
    .filter(([, entry]) => entry && entry.id && isLabelPendingVoid(entry))
    .map(([key, entry]) => ({ key, id: entry.id }));
}

function isAlreadyProcessedForBulkVoid(order = {}) {
  const status = normalizeStatusValue(order.status);
  return status === 'cancelled' || status === 'canceled';
}

function hasAnyVoidedLabel(order = {}) {
  const labels = normalizeShipEngineLabelMap(order);
  const labelMarkedVoided = Object.values(labels).some((entry) => {
    if (!entry || !entry.id) return false;
    const status = getLabelStatus(entry);
    return status === 'voided' || Boolean(entry.voidedAt);
  });

  if (labelMarkedVoided) {
    return true;
  }

  return normalizeStatusValue(order.labelVoidStatus) === 'voided' || Boolean(order.labelVoidedAt);
}

function getVoidedLabelIds(order = {}) {
  const labels = normalizeShipEngineLabelMap(order);
  return Object.values(labels)
    .filter((entry) => {
      if (!entry || !entry.id) return false;
      const status = getLabelStatus(entry);
      return status === 'voided' || Boolean(entry.voidedAt);
    })
    .map((entry) => entry.id)
    .filter(Boolean);
}

function isTestOrderMatch(order = {}) {
  const email = String(
    order?.shippingInfo?.email || order?.email || order?.customerEmail || order?.userEmail || ''
  )
    .trim()
    .toLowerCase();

  const addressCombined = normalizeAddressText([
    order?.shippingInfo?.address,
    order?.shippingInfo?.address1,
    order?.shippingInfo?.addressLine1,
    order?.shippingInfo?.street,
    order?.shippingAddress?.address,
    order?.shippingAddress?.address1,
    order?.shippingAddress?.addressLine1,
    order?.shippingAddress?.street,
  ].filter(Boolean).join(' '));

  return TEST_ORDER_EMAILS.has(email) || addressCombined.includes(TEST_ORDER_ADDRESS_NEEDLE);
}

async function sendBulkVoidSummaryEmail({
  title,
  subject,
  reason,
  cancelledEntries = [],
  skippedEntries = [],
  failedEntries = [],
}) {
  const recipient = getLabelVoidNotificationEmail();
  if (!recipient) {
    console.warn('Bulk void summary email skipped: no admin recipient configured.');
    return;
  }

  const cancelledLines = cancelledEntries.length
    ? cancelledEntries.map((entry) => {
      const ageLabel = entry.ageDays === null ? 'Unknown age' : `${entry.ageDays} days old`;
      return `• Order #${entry.orderId} | ${ageLabel} | Labels: ${entry.labelIds?.length ? entry.labelIds.join(', ') : 'N/A'}`;
    })
    : ['• None'];

  const skippedLines = skippedEntries.slice(0, 25).map((entry) => `• #${entry.orderId}: ${entry.reason}`);
  const failedLines = failedEntries.slice(0, 25).map((entry) => `• #${entry.orderId}: ${entry.reason}`);

  const textBody = [
    title,
    `Reason: ${reason}`,
    '',
    `Cancelled: ${cancelledEntries.length}`,
    ...cancelledLines,
    '',
    `Skipped: ${skippedEntries.length}`,
    ...(skippedLines.length ? skippedLines : ['• None']),
    '',
    `Failed: ${failedEntries.length}`,
    ...(failedLines.length ? failedLines : ['• None']),
  ].join('\n');

  const htmlBody = buildEmailLayout({
    title,
    accentColor: '#0ea5e9',
    includeTrustpilot: false,
    bodyHtml: `
      <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
      <p><strong>Cancelled:</strong> ${cancelledEntries.length}</p>
      <ul style="padding-left:22px; color:#475569;">
        ${cancelledLines.map((line) => `<li>${escapeHtml(line.substring(2))}</li>`).join('')}
      </ul>
      <p><strong>Skipped:</strong> ${skippedEntries.length}</p>
      <ul style="padding-left:22px; color:#475569;">
        ${(skippedLines.length ? skippedLines : ['• None']).map((line) => `<li>${escapeHtml(line.substring(2))}</li>`).join('')}
      </ul>
      <p><strong>Failed:</strong> ${failedEntries.length}</p>
      <ul style="padding-left:22px; color:#475569;">
        ${(failedLines.length ? failedLines : ['• None']).map((line) => `<li>${escapeHtml(line.substring(2))}</li>`).join('')}
      </ul>
    `,
  });

  try {
    await transporter.sendMail({
      from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
      to: recipient,
      subject,
      text: textBody,
      html: htmlBody,
    });
  } catch (error) {
    console.error('[Bulk Void Summary] Failed to send admin summary email:', error?.message || error);
  }
}

function getMostRecentTrackingRefreshAt(order = {}, mode = 'inbound') {
  if (mode === 'kit') {
    return (
      toDate(order.kitTrackingLastRefreshedAt) ||
      toDate(order.outboundTrackingLastSyncedAt) ||
      toDate(order.lastTrackingRefreshAt) ||
      null
    );
  }

  return (
    toDate(order.labelTrackingLastSyncedAt) ||
    toDate(order.inboundTrackingLastRefreshedAt) ||
    toDate(order.lastTrackingRefreshAt) ||
    null
  );
}

function describeTrackingRefreshCooldown(order = {}, mode = 'inbound') {
  if (!TRACKING_REFRESH_MIN_INTERVAL_MS) {
    return null;
  }

  const latestRefresh = getMostRecentTrackingRefreshAt(order, mode);
  if (!latestRefresh) {
    return null;
  }

  const elapsedMs = Date.now() - latestRefresh.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs >= TRACKING_REFRESH_MIN_INTERVAL_MS) {
    return null;
  }

  const remainingMs = TRACKING_REFRESH_MIN_INTERVAL_MS - elapsedMs;
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  const scopeLabel = mode === 'kit' ? 'Kit tracking' : 'Inbound tracking';
  return `${scopeLabel} was refreshed recently. Try again in about ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}.`;
}

function cloneShipEngineLabelMap(labels) {
  const clone = {};
  if (!labels || typeof labels !== "object") {
    return clone;
  }
  Object.entries(labels).forEach(([key, value]) => {
    clone[key] = value && typeof value === "object" ? { ...value } : value;
  });
  return clone;
}

function formatLabelDisplayNameFromKey(key) {
  if (!key) return "Shipping Label";
  const normalizedKey = key.toString().toLowerCase();
  if (normalizedKey === "inbound") return "Inbound Shipping Label";
  if (normalizedKey === "outbound") return "Outbound Shipping Label";
  if (normalizedKey === "primary") return "Primary Shipping Label";
  if (normalizedKey === "email") return "Email Shipping Label";
  return key
    .toString()
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeShipEngineLabelMap(order) {
  const labels = cloneShipEngineLabelMap(order.shipEngineLabels);
  if (!Object.keys(labels).length && order.shipEngineLabelId) {
    labels.primary = {
      id: order.shipEngineLabelId,
      status: order.labelVoidStatus || "active",
      message: order.labelVoidMessage || null,
      trackingNumber: order.trackingNumber || null,
      generatedAt:
        order.labelGeneratedAt || order.kitLabelGeneratedAt || order.createdAt || null,
      displayName: "Primary Shipping Label",
    };
  }
  return labels;
}

function getLabelStatus(entry) {
  if (!entry) return "";
  const status = entry.status || entry.voidStatus || entry.state || "active";
  return status.toString().toLowerCase();
}

function isLabelPendingVoid(entry) {
  const status = getLabelStatus(entry);
  return !["voided", "void_denied"].includes(status);
}

function buildLabelIdList(labelMap) {
  return Object.values(labelMap)
    .map((entry) => (entry && entry.id ? entry.id : null))
    .filter(Boolean);
}

async function requestShipEngineVoid(labelId, shipengineKey) {
  const url = `${SHIPENGINE_API_BASE_URL}/labels/${encodeURIComponent(labelId)}/void`;
  const response = await axios.put(
    url,
    {},
    {
      headers: {
        "API-Key": shipengineKey,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
  return response.data || {};
}

async function sendVoidNotificationEmail(order, results, options = {}) {
  const approvedResults = results.filter((result) => result.approved);
  if (!approvedResults.length) {
    return;
  }

  const recipient = getLabelVoidNotificationEmail();
  const reasonKey = options.reason === "automatic" ? "automatic" : "manual";
  const sendAdmin = options.sendAdmin !== false;
  const sendCustomer =
    options.sendCustomer === true ||
    (options.sendCustomer !== false && reasonKey !== "automatic");

  if (sendAdmin && !recipient) {
    console.warn("Void notification email skipped: no recipient configured.");
  }

  const ageDescription = formatOrderAgeInDays(order);
  const subject = `Shipping label voided for order ${order.id}`;
  const lines = approvedResults.map((result) => {
    const labelName = formatLabelDisplayNameFromKey(result.key);
    return `• ${labelName} (ID: ${result.labelId})`;
  });

  const introText =
    reasonKey === "automatic"
      ? "We've automatically voided the prepaid shipping label for your order because it's been a while since we heard from you."
      : "We've voided the prepaid shipping label for your order as requested.";

  const followUpText =
    "If you'd still like to send your device in, reply to this email and we'll send a fresh label right away.";

  const textBody = [
    introText,
    `Order #: ${order.id}`,
    `Order age: ${ageDescription}.`,
    "",
    "Voided label(s):",
    ...lines,
    "",
    followUpText,
  ].join("\n");

  const htmlBody = buildEmailLayout({
    title: "Shipping label voided",
    accentColor: "#0ea5e9",
    includeTrustpilot: false,
    bodyHtml: `
      <p>${
        reasonKey === "automatic"
          ? "We've automatically voided the prepaid shipping label for your order because it's been a while since we heard from you."
          : "We've voided the prepaid shipping label for your order as requested."
      }</p>
      <p>Order number: <strong>#${order.id}</strong></p>
      <p>Order age: <strong>${ageDescription}</strong>.</p>
      <p style="margin-bottom:12px;">Voided label(s):</p>
      <ul style="padding-left:22px; color:#475569;">
        ${lines.map((line) => `<li>${escapeHtml(line.substring(2))}</li>`).join("\n")}
      </ul>
      <p style="margin-top:20px;">If you'd still like to send your device in, reply to this email and we'll send a fresh label right away.</p>
    `,
  });

  if (sendAdmin && recipient) {
    await transporter.sendMail({
      from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
      to: recipient,
      subject,
      text: textBody,
      html: htmlBody,
    });
  }

  if (sendCustomer && order.shippingInfo && order.shippingInfo.email) {
    const customerSubject = reasonKey === 'automatic'
      ? `Order #${order.id} label voided and cancelled after 28 days`
      : subject;
    const customerText = reasonKey === 'automatic'
      ? [
          `Hi ${order.shippingInfo.fullName || 'there'},`,
          '',
          `Your label for order #${order.id} was voided automatically because we did not receive a response and your device was not sent in within 28 days.`,
          'Order status: cancelled.',
          `Order age: ${ageDescription}.`,
          '',
          'Voided label(s):',
          ...lines,
        ].join('\n')
      : textBody;
    const customerHtml = reasonKey === 'automatic'
      ? buildVoidedLabelCustomerEmail(order, approvedResults, { ageDescription })
      : htmlBody;

    await transporter.sendMail({
      from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
      to: order.shippingInfo.email,
      subject: customerSubject,
      text: customerText,
      html: customerHtml,
    });
  }
}

async function handleLabelVoid(order, selections, options = {}) {
  if (!order || !order.id) {
    throw new Error("Order context is required to void labels.");
  }

  if (!Array.isArray(selections) || selections.length === 0) {
    throw new Error("At least one label must be selected for voiding.");
  }

  const shipengineKey = options.shipengineKey || getShipEngineApiKey();
  if (!shipengineKey) {
    throw new Error(
      "ShipEngine API key not configured. Please set 'shipengine.key' or SHIPENGINE_KEY."
    );
  }

  const nowTimestamp = admin.firestore.Timestamp.now();
  const labels = normalizeShipEngineLabelMap(order);
  const results = [];
  let changed = false;

  for (const selection of selections) {
    const key = selection && selection.key ? selection.key : null;
    if (!key) {
      results.push({
        key: null,
        labelId: null,
        approved: false,
        message: "Invalid label selection.",
      });
      continue;
    }

    const entry = labels[key] && typeof labels[key] === "object" ? { ...labels[key] } : {};
    const labelId = selection.id || entry.id || order.shipEngineLabelId || null;

    if (!labelId) {
      results.push({
        key,
        labelId: null,
        approved: false,
        message: "No label identifier found for selection.",
      });
      continue;
    }

    entry.displayName = entry.displayName || formatLabelDisplayNameFromKey(key);
    entry.id = labelId;

    const status = getLabelStatus(entry);
    if (["voided", "void_denied"].includes(status)) {
      results.push({
        key,
        labelId,
        approved: status === "voided",
        message:
          entry.message ||
          entry.voidMessage ||
          (status === "voided"
            ? "Label has already been voided."
            : "Label void request was previously denied."),
      });
      labels[key] = entry;
      continue;
    }

    try {
      const response = await requestShipEngineVoid(labelId, shipengineKey);
      const approved = Boolean(response.approved);
      const message = response.message || response.response_message || null;

      entry.status = approved ? "voided" : "void_denied";
      entry.voidStatus = entry.status;
      entry.message = message;
      entry.voidMessage = message;
      entry.voidedAt = approved ? nowTimestamp : entry.voidedAt || null;
      entry.lastVoidAttemptAt = nowTimestamp;
      if (options.reason === "automatic") {
        entry.autoVoidAttemptedAt = nowTimestamp;
      } else {
        entry.manualVoidAttemptedAt = nowTimestamp;
      }
      if (!entry.generatedAt) {
        entry.generatedAt =
          entry.createdAt || order.labelGeneratedAt || order.kitLabelGeneratedAt || order.createdAt || nowTimestamp;
      }

      labels[key] = entry;
      changed = true;
      results.push({ key, labelId, approved, message });
      if (approved) {
        console.log(`[Order Action] Voided label ${labelId} for order ${order.id} (${options.reason || 'manual'})`);
      } else {
        console.log(`[Order Action] Void denied for label ${labelId} on order ${order.id} (${options.reason || 'manual'})`);
      }
    } catch (error) {
      const message =
        error.response?.data?.message ||
        error.response?.data?.errors?.[0]?.message ||
        error.message ||
        "Failed to void label.";

      entry.status = "void_error";
      entry.voidStatus = entry.status;
      entry.message = message;
      entry.voidMessage = message;
      entry.lastVoidAttemptAt = nowTimestamp;
      if (options.reason === "automatic") {
        entry.autoVoidAttemptedAt = nowTimestamp;
      } else {
        entry.manualVoidAttemptedAt = nowTimestamp;
      }
      if (!entry.generatedAt) {
        entry.generatedAt =
          entry.createdAt || order.labelGeneratedAt || order.kitLabelGeneratedAt || order.createdAt || nowTimestamp;
      }

      labels[key] = entry;
      changed = true;
      results.push({ key, labelId, approved: false, message, error: true });
    }
  }

  const pendingCount = Object.values(labels).filter((entry) => entry && entry.id && isLabelPendingVoid(entry)).length;
  const labelIds = buildLabelIdList(labels);

  const updates = {
    shipEngineLabels: labels,
    shipEngineLabelsLastUpdatedAt: nowTimestamp,
    hasShipEngineLabel: labelIds.length > 0,
    hasActiveShipEngineLabel: pendingCount > 0,
    shipEngineLabelIds: labelIds,
  };

  if (labels.primary) {
    updates.shipEngineLabelId = labels.primary.id || null;
    updates.labelVoidStatus = labels.primary.status || null;
    updates.labelVoidMessage = labels.primary.message || null;
    if (labels.primary.voidedAt) {
      updates.labelVoidedAt = labels.primary.voidedAt;
    }
  }

  const approvedCount = results.filter((result) => result && result.approved).length;
  if (approvedCount > 0) {
    Object.assign(updates, buildManualVoidShippingCleanupPayload());
    updates.status = "canceled";
  }

  if (changed) {
    await updateOrderBoth(order.id, updates);
  }

  return { results, updates, changed };
}

async function cancelOrderAndNotify(order, options = {}) {
  if (!order || !order.id) {
    throw new Error("Order details are required to cancel an order.");
  }

  const statusValue = (order.status || '').toLowerCase();
  const kitOrder = isKitOrder(order);
  const emailOrder = isEmailLabelOrder(order);
  if (!emailOrder && !(kitOrder && statusValue === 'kit_delivered')) {
    throw new Error('Order cancellation is only available for emailed labels or kit-delivered orders.');
  }

  const reason = options.reason || "cancelled";
  const initiatedBy = options.initiatedBy || null;
  const auto = options.auto === true;
  const notifyCustomer = options.notifyCustomer !== false;
  const shouldVoidLabels = options.voidLabels !== false;

  const labels = normalizeShipEngineLabelMap(order);
  const selections = Object.entries(labels)
    .filter(([, entry]) => entry && entry.id && isLabelPendingVoid(entry))
    .map(([key, entry]) => ({ key, id: entry.id }));

  let voidResults = [];
  if (shouldVoidLabels && selections.length) {
    try {
      const { results } = await handleLabelVoid(order, selections, {
        reason: auto ? "automatic" : "manual",
        shipengineKey: options.shipengineKey,
      });
      voidResults = results;
    } catch (error) {
      console.error(`Failed to void labels while cancelling order ${order.id}:`, error);
    }
  }

  const logEntries = [
    {
      type: "cancellation",
      message: auto
        ? "Order automatically cancelled after extended inactivity."
        : `Order cancelled${initiatedBy ? ` by ${initiatedBy}` : ""}.`,
      metadata: {
        reason,
        auto,
        labelsVoided: voidResults.filter((result) => result.approved).map((result) => result.labelId),
      },
    },
  ];

  const updatePayload = {
    status: "cancelled",
    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    cancelReason: reason,
    cancelRequestedBy: initiatedBy,
    autoCancelled: auto,
  };

  if (shouldVoidLabels && voidResults.length) {
    updatePayload.cancelVoidResults = voidResults;
  }

  const { order: updatedOrder } = await updateOrderBoth(order.id, updatePayload, {
    logEntries,
  });

  console.log(
    `[Order Action] Cancelled order ${updatedOrder?.id || order.id} reason=${reason} auto=${auto} labelsVoided=${voidResults.filter((result) => result.approved).length}`
  );

  if (notifyCustomer && updatedOrder?.shippingInfo?.email) {
    const customerName = updatedOrder.shippingInfo.fullName || "there";
    const introMessage = auto
      ? "has been cancelled because we didn’t receive your device within 25 days."
      : "has been cancelled as requested.";
    const followUp = auto
      ? "If you still plan to send it in, reply to this email and we’ll issue a fresh shipping label right away."
      : "If you change your mind, reply to this email and we can send a fresh shipping label.";

    const htmlBody = `
      <p>Hi ${escapeHtml(customerName)},</p>
      <p>Your order <strong>#${escapeHtml(order.id)}</strong> ${introMessage}</p>
      <p>${followUp}</p>
      <p>If you already shipped your device, please ignore this message—it was triggered while our system updates your tracking information.</p>
      <p>We’re happy to help with any questions.</p>
      <p>— The SecondHandCell Team</p>
    `;

    try {
      await transporter.sendMail({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to: updatedOrder.shippingInfo.email,
        subject: `Order #${updatedOrder.id} has been cancelled`,
        html: htmlBody,
      });

      await recordCustomerEmail(
        updatedOrder.id,
        'Cancellation notice email sent to customer.',
        { reason, autoCancelled: auto },
        {
          additionalUpdates: {
            cancellationNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        }
      );
    } catch (emailError) {
      console.error(`Failed to send cancellation email for order ${order.id}:`, emailError);
    }
  }

  return { order: updatedOrder, voidResults };
}

// --- EMAIL HTML Templates (unchanged from your version) ---
const SHIPPING_LABEL_EMAIL_HTML = buildEmailLayout({
  title: "Your Shipping Label is Ready!",
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>Your shipping label for order <strong>#**ORDER_ID**</strong> is ready to go.</p>
      <p style="margin-bottom:28px;">Use the secure button below to download it instantly and get your device on the way to us.</p>
      <div style="text-align:center; margin-bottom:32px;">
        <a href="**LABEL_DOWNLOAD_LINK**" class="button-link">Download Shipping Label</a>
      </div>
      <div style="background:#f8fafc; border:1px solid #dbeafe; border-radius:14px; padding:20px 24px;">
        <p style="margin:0 0 10px;"><strong style="color:#0f172a;">Tracking Number</strong><br><span style="color:#2563eb; font-weight:600;">**TRACKING_NUMBER**</span></p>
        <p style="margin:0; color:#475569;">Drop your device off with your preferred carrier as soon as you're ready.</p>
      </div>
      <div style="text-align:center; margin-top:18px;">
        <a href="**TRACK_STATUS_LINK**" class="button-link" style="background-color:#2563eb;">Track your status here</a>
      </div>
      <p style="margin-top:28px;">Need a hand? Reply to this email and our team will guide you.</p>
  `,
});
const SHIPPING_KIT_EMAIL_HTML = buildEmailLayout({
  title: "Your Shipping Kit is on its Way!",
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>Your shipping kit for order <strong>#**ORDER_ID**</strong> is en route.</p>
      <p>Track its journey with the number below and get ready to pop your device inside once it arrives.</p>
      <div style="background:#f8fafc; border:1px solid #dbeafe; border-radius:14px; padding:20px 24px; margin:0 0 28px;">
        <p style="margin:0 0 10px;"><strong style="color:#0f172a;">Tracking Number</strong><br><span style="color:#2563eb; font-weight:600;">**TRACKING_NUMBER**</span></p>
        <p style="margin:0; color:#475569;">Keep an eye out for your kit and pack your device securely when it lands.</p>
      </div>
      <p>Have accessories you don't need? Feel free to include them—we'll recycle responsibly.</p>
      <p>Need anything else? Just reply to this email.</p>
  `,
});
const ORDER_RECEIVED_EMAIL_HTML = buildEmailLayout({
  title: "We've received your order!",
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>Thanks for choosing SecondHandCell! We've logged your order for <strong>**DEVICE_NAME**</strong>.</p>
      <p>Your order ID is <strong style="color:#2563eb;">#**ORDER_ID**</strong>. Keep it handy for any questions.</p>
      <h2 style="font-size:20px; color:#0f172a; margin:32px 0 12px;">Before you ship</h2>
      <ul style="padding-left:22px; margin:0 0 20px; color:#475569;">
        <li style="margin-bottom:10px;"><strong>Backup your data</strong> so nothing personal is lost.</li>
        <li style="margin-bottom:10px;"><strong>Factory reset</strong> the device to wipe personal info.</li>
        <li style="margin-bottom:10px;"><strong>Remove accounts</strong> such as Apple ID/iCloud or Google/Samsung accounts.<br><span style="display:block; margin-top:6px; margin-left:10px;">• Turn off Find My iPhone (FMI).<br>• Disable Factory Reset Protection (FRP) on Android.</span></li>
        <li style="margin-bottom:10px;"><strong>Remove SIM cards</strong> and eSIM profiles.</li>
        <li style="margin-bottom:10px;"><strong>Pack accessories separately</strong> unless we specifically request them.</li>
      </ul>
      <div style="background:#fef3c7; border-radius:16px; padding:18px 22px; border:1px solid #fde68a; color:#92400e; margin:30px 0;">
        <strong>Important:</strong> We can't process devices that still have FMI/FRP enabled, an outstanding balance, or a blacklist/lost/stolen status.
      </div>
      **SHIPPING_INSTRUCTION**
  `,
});
const DEVICE_RECEIVED_EMAIL_HTML = buildEmailLayout({
  title: "Your device has arrived!",
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>Your device for order <strong style="color:#2563eb;">#**ORDER_ID**</strong> has landed at our facility.</p>
      <p>Our technicians are giving it a full inspection now. We'll follow up shortly with an update on your payout.</p>
      <p>Have questions while you wait? Just reply to this email—real humans are here to help.</p>
  `,
});
const ORDER_PLACED_ADMIN_EMAIL_HTML = buildEmailLayout({
  title: "New order submitted",
  accentColor: "#f97316",
  bodyHtml: `
      <p>Heads up! A new order just came in.</p>
      <div style="background:#fff7ed; border:1px solid #fed7aa; border-radius:16px; padding:22px 24px; margin-bottom:28px; color:#7c2d12;">
        <p style="margin:0 0 10px;"><strong>Customer:</strong> **CUSTOMER_NAME**</p>
        <p style="margin:0 0 10px;"><strong>Email:</strong> **CUSTOMER_EMAIL**</p>
        <p style="margin:0 0 10px;"><strong>Phone:</strong> **CUSTOMER_PHONE**</p>
        <p style="margin:0 0 10px;"><strong>Item:</strong> **DEVICE_NAME**</p>
        <p style="margin:0 0 10px;"><strong>Storage:</strong> **STORAGE**</p>
        <p style="margin:0 0 10px;"><strong>Carrier:</strong> **CARRIER**</p>
        <p style="margin:0 0 10px;"><strong>Estimated Payout:</strong> $**ESTIMATED_QUOTE**</p>
        <p style="margin:0 0 10px;"><strong>Payment Method:</strong> **PAYMENT_METHOD**</p>
        <p style="margin:0 0 10px;"><strong>Payment Info:</strong> **PAYMENT_INFO**</p>
        <p style="margin:0 0 10px;"><strong>Shipping Address:</strong><br>**SHIPPING_ADDRESS**</p>
        <div style="margin-top:12px; padding:12px 14px; background:#fff; border:1px solid #fed7aa; border-radius:12px;">
          <p style="margin:0 0 6px;"><strong>Conditions:</strong></p>
          <p style="margin:0 0 4px;">Powers On: **POWER_STATUS**</p>
          <p style="margin:0 0 4px;">Fully Functional: **FUNCTIONAL_STATUS**</p>
          <p style="margin:0 0 4px;">No Cracks: **CRACK_STATUS**</p>
          <p style="margin:0;">Cosmetic: **COSMETIC_GRADE**</p>
        </div>
      </div>
      <div style="text-align:center; margin-bottom:20px;">
        <a href="https://secondhandcell.com/admin" class="button-link" style="background-color:#f97316;">Open in Admin</a>
      </div>
      <p style="color:#475569;">This alert is automated—feel free to reply if you notice anything unusual.</p>
  `,
});
const BLACKLISTED_EMAIL_HTML = buildEmailLayout({
  title: "Action required: Carrier blacklist detected",
  accentColor: "#dc2626",
  includeCountdownNotice: true,
  includeTrustpilot: false,
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>During our review of order <strong>#**ORDER_ID**</strong>, the carrier database flagged the device as lost, stolen, or blacklisted.</p>
      <p>We can't release payment while this status is active. Please contact your carrier to remove the flag and reply with confirmation or documentation so we can re-run the check.</p>
      <p>If you believe this alert is an error, include any proof in your reply and we'll take another look.</p>
      <p style="color:#dc2626; font-size:15px;">**LEGAL_TEXT**</p>
  `,
});
const FMI_EMAIL_HTML = buildEmailLayout({
  title: "Turn off Find My to continue",
  accentColor: "#f59e0b",
  includeCountdownNotice: true,
  includeTrustpilot: false,
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>Our inspection for order <strong>#**ORDER_ID**</strong> shows Find My iPhone / Activation Lock is still enabled.</p>
      <p>Please complete the steps below so we can finish processing your payout:</p>
      <ol style="padding-left:22px; color:#475569; margin-bottom:20px;">
        <li>Visit <a href="https://icloud.com/find" target="_blank" style="color:#2563eb;">icloud.com/find</a> and sign in.</li>
        <li>Select the device you're selling.</li>
        <li>Choose “Remove from Account”.</li>
        <li>Confirm the device no longer appears in your list.</li>
      </ol>
      <div style="text-align:center; margin:32px 0 24px;">
        <a href="**CONFIRM_URL**" class="button-link" style="background-color:#f59e0b;">I've turned off Find My</a>
      </div>
      <p style="color:#b45309; font-size:15px;">Once it's disabled, click the button above or reply to this email so we can recheck your device.</p>
  `,
});
const BAL_DUE_EMAIL_HTML = buildEmailLayout({
  title: "Balance due with your carrier",
  accentColor: "#f97316",
  includeCountdownNotice: true,
  includeTrustpilot: false,
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>When we ran your device for order <strong>#**ORDER_ID**</strong>, the carrier reported a status of <strong>**FINANCIAL_STATUS**</strong>.</p>
      <p>Please contact your carrier to clear the balance and then reply to this email so we can rerun the check and keep your payout on track.</p>
      <p style="color:#c2410c;">Need help figuring out the right department to call? Let us know and we'll point you in the right direction.</p>
  `,
});
const DOWNGRADE_EMAIL_HTML = buildEmailLayout({
  title: "Order finalized at adjusted payout",
  accentColor: "#f97316",
  includeTrustpilot: false,
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>We reached out about the issue with your device for order <strong>#**ORDER_ID**</strong> but haven't received an update.</p>
      <p>To keep things moving, we've finalized the device at 75% less than the original offer. If you resolve the issue, reply to this email and we'll happily re-evaluate.</p>
      <p>We're here to help—just let us know how you'd like to proceed.</p>
  `,
});

function getOrderCompletedEmailTemplate({ includeTrustpilot = true } = {}) {
  return buildEmailLayout({
    title: "🥳 Your order is complete!",
    includeTrustpilot,
    bodyHtml: `
        <p>Hi **CUSTOMER_NAME**,</p>
        <p>Great news! Order <strong>#**ORDER_ID**</strong> is complete and your payout is headed your way.</p>
        <div style="background-color:#f8fafc; border:1px solid #e2e8f0; border-radius:16px; padding:20px 24px; margin:28px 0;">
          <p style="margin:0 0 12px;"><strong style="color:#0f172a;">Device</strong><br><span style="color:#475569;">**DEVICE_SUMMARY**</span></p>
          <p style="margin:0 0 12px;"><strong style="color:#0f172a;">Payout</strong><br><span style="color:#059669; font-size:22px; font-weight:700;">$**ORDER_TOTAL**</span></p>
          <p style="margin:0;"><strong style="color:#0f172a;">Payment method</strong><br><span style="color:#475569;">**PAYMENT_METHOD**</span></p>
        </div>
        <p>Thanks for choosing SecondHandCell!</p>
    `,
  });
}

const REVIEW_REQUEST_EMAIL_HTML = buildEmailLayout({
  title: "We'd love your feedback",
  accentColor: "#0ea5e9",
  bodyHtml: `
      <p>Hello **CUSTOMER_NAME**,</p>
      <p>Thanks again for trusting us with your device. Sharing a quick review helps other sellers feel confident working with SecondHandCell.</p>
      <p style="margin-bottom:32px;">It only takes a minute and means the world to our team.</p>
      <div style="text-align:center; margin-bottom:24px;">
        <a href="${TRUSTPILOT_REVIEW_LINK}" class="button-link" style="background-color:#0ea5e9;">Leave a Trustpilot review</a>
      </div>
      <p style="text-align:center; color:#475569;">Thank you for being part of the SecondHandCell community!</p>
  `,
});


const stateAbbreviations = {
  "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
  "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "Florida": "FL", "Georgia": "GA",
  "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA",
  "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
  "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO",
  "Montana": "MT", "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH",
  "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT",
  "Virginia": "VA", "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
  "District of Columbia": "DC"
};

async function generateNextOrderNumber() {
  const counterRef = db.collection("counters").doc("orders");
  const incrementByOne = admin.firestore.FieldValue.increment(1);

  try {
    await counterRef.set({ currentNumber: incrementByOne }, { merge: true });

    const counterDoc = await counterRef.get();
    const nextNumberRaw = Number(counterDoc.data()?.currentNumber);
    const nextNumber = Number.isFinite(nextNumberRaw) ? nextNumberRaw : 1;
    const currentNumber = Math.max(0, nextNumber - 1);
    const paddedNumber = String(currentNumber).padStart(5, "0");

    return `SHC-${paddedNumber}`;
  } catch (e) {
    console.error("Failed to generate order number:", e);
    throw new Error("Failed to generate a unique order number. Please try again.");
  }
}

function formatStatusLabel(value) {
  if (!value) return "";
  return String(value)
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeLogEntries(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  return entries
    .filter(Boolean)
    .map((entry) => {
      const atValue = entry.at;
      let timestamp;

      if (atValue instanceof admin.firestore.Timestamp) {
        timestamp = atValue;
      } else if (atValue instanceof Date) {
        timestamp = admin.firestore.Timestamp.fromDate(atValue);
      } else if (
        atValue &&
        typeof atValue === "object" &&
        typeof atValue.seconds === "number"
      ) {
        timestamp = new admin.firestore.Timestamp(
          atValue.seconds,
          atValue.nanoseconds || 0
        );
      } else {
        timestamp = admin.firestore.Timestamp.now();
      }

      return {
        id: entry.id || randomUUID(),
        type: entry.type || "update",
        message: entry.message || "",
        metadata: entry.metadata ?? null,
        at: timestamp,
      };
    });
}

function expandDottedFieldPaths(data = {}) {
  const expanded = {};

  for (const [key, value] of Object.entries(data)) {
    if (!key.includes('.')) {
      expanded[key] = value;
      continue;
    }

    const segments = key.split('.').filter(Boolean);
    if (!segments.length) {
      continue;
    }

    let cursor = expanded;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (!cursor[segment] || typeof cursor[segment] !== 'object' || Array.isArray(cursor[segment])) {
        cursor[segment] = {};
      }
      cursor = cursor[segment];
    }
    cursor[segments[segments.length - 1]] = value;
  }

  return expanded;
}

async function writeOrderBoth(orderId, data) {
  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  const dataToWrite = { ...data, updatedAt: timestamp };

  if (data.status !== undefined && data.lastStatusUpdateAt === undefined) {
    dataToWrite.lastStatusUpdateAt = timestamp;
  }

  await ordersCollection.doc(orderId).set(dataToWrite);

  if (data.userId) {
    await usersCollection
      .doc(data.userId)
      .collection("orders")
      .doc(orderId)
      .set(dataToWrite);
  }
}

async function updateOrderBoth(orderId, partialData = {}, options = {}) {
  const orderRef = ordersCollection.doc(orderId);
  const existingSnap = await orderRef.get();
  const existing = existingSnap.data() || {};
  const userId = existing.userId;

  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  const dataToMerge = expandDottedFieldPaths({ ...partialData, updatedAt: timestamp });

  const statusProvided = Object.prototype.hasOwnProperty.call(
    partialData,
    "status"
  );

  if (statusProvided && options.skipStatusTimestamp !== true) {
    dataToMerge.lastStatusUpdateAt = timestamp;
  }

  let logEntries = [];

  if (
    statusProvided &&
    existing.status !== partialData.status &&
    options.autoLogStatus !== false
  ) {
    logEntries.push({
      type: "status",
      message: `Status changed to ${formatStatusLabel(partialData.status)}`,
      metadata: { status: partialData.status },
    });
  }

  if (Array.isArray(options.logEntries)) {
    logEntries = logEntries.concat(options.logEntries);
  }

  const normalizedLogs = normalizeLogEntries(logEntries);
  if (normalizedLogs.length) {
    dataToMerge.activityLog = admin.firestore.FieldValue.arrayUnion(
      ...normalizedLogs
    );
  }

  await orderRef.set(dataToMerge, { merge: true });

  if (userId) {
    const userUpdate = expandDottedFieldPaths({ ...dataToMerge });
    if (normalizedLogs.length) {
      userUpdate.activityLog = admin.firestore.FieldValue.arrayUnion(
        ...normalizedLogs
      );
    }

    await usersCollection
      .doc(userId)
      .collection("orders")
      .doc(orderId)
      .set(userUpdate, { merge: true });
  }

  const updatedSnap = await orderRef.get();
  const updated = updatedSnap.data() || {};

  return { order: { id: orderId, ...updated }, userId };
}

async function recordCustomerEmail(orderId, message, metadata = {}, options = {}) {
  if (!orderId || !message) {
    return null;
  }

  const cleanedMetadata = {};
  if (metadata && typeof metadata === "object") {
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined && value !== null && value !== "") {
        cleanedMetadata[key] = value;
      }
    }
  }

  const logEntry = {
    type: options?.logType || "email",
    message,
  };

  if (Object.keys(cleanedMetadata).length > 0) {
    logEntry.metadata = cleanedMetadata;
  }

  const additionalUpdates = {};
  if (options && typeof options.additionalUpdates === "object") {
    for (const [key, value] of Object.entries(options.additionalUpdates)) {
      if (value !== undefined) {
        additionalUpdates[key] = value;
      }
    }
  }

  const payload = {
    lastCustomerEmailSentAt: admin.firestore.FieldValue.serverTimestamp(),
    ...additionalUpdates,
  };

  return updateOrderBoth(orderId, payload, {
    autoLogStatus: false,
    logEntries: [logEntry],
  });
}

function getLastCustomerEmailMillis(order = {}) {
  const candidates = [
    order.lastCustomerEmailSentAt,
    order.lastReminderSentAt,
    order.expiringReminderSentAt,
    order.kitReminderSentAt,
    order.reminderSentAt,
    order.reminderEmailSentAt,
    order.lastReminderAt,
    order.reviewRequestSentAt,
    order.returnLabelEmailSentAt,
    order.cancellationNotifiedAt,
  ];

  let latest = 0;
  for (const value of candidates) {
    const date = toDate(value);
    if (date) {
      const time = date.getTime();
      if (time > latest) {
        latest = time;
      }
    }
  }

  return latest > 0 ? latest : null;
}

function applyTemplate(template, replacements = {}) {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.split(key).join(value);
  }
  return output;
}

function formatDisplayText(value, fallback = "Not specified") {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getOrderPayout(order = {}) {
  const potentialValues = [
    order.finalPayoutAmount,
    order.finalPayout,
    order.finalOfferAmount,
    order.finalOffer,
    order.payoutAmount,
    order.payout,
    order.reOffer?.newPrice,
    order.estimatedQuote
  ];

  for (const value of potentialValues) {
    if (value === undefined || value === null) continue;
    const numericValue = Number(value);
    if (!Number.isNaN(numericValue)) {
      return numericValue;
    }
  }

  return 0;
}

function formatCurrencyValue(value) {
  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) {
    return "0.00";
  }
  return numericValue.toFixed(2);
}

function buildDeviceSummary(order = {}) {
  const parts = [];
  if (order.device) {
    parts.push(String(order.device));
  }
  if (order.storage) {
    parts.push(String(order.storage));
  }
  if (order.carrier) {
    parts.push(formatDisplayText(order.carrier));
  }
  return parts.length ? parts.join(" • ") : "Device details on file";
}

function buildTrustpilotSection() {
  return `
    <div style="text-align:center; padding: 28px 24px 32px; background-color:#f8fafc; border-top: 1px solid #e2e8f0;">
      <p style="font-weight:600; color:#0f172a; font-size:18px; margin:0 0 12px 0;">Loved your experience?</p>
      <a href="${TRUSTPILOT_REVIEW_LINK}" style="display:inline-block; text-decoration:none; border:none; outline:none;">
        <img src="${TRUSTPILOT_STARS_IMAGE_URL}" alt="Rate us on Trustpilot" style="height:58px; width:auto; display:block; margin:0 auto 10px auto; border:0;">
      </a>
      <p style="font-size:15px; color:#475569; margin:12px 0 0;">Your feedback keeps the <strong>SecondHandCell</strong> community thriving.</p>
    </div>
  `;
}

function buildEmailLayout({
  title = "",
  bodyHtml = "",
  accentColor = "#16a34a",
  includeTrustpilot = true,
  footerText = "Need help? Reply to this email or call (347) 688-0662.",
  includeCountdownNotice = false,
} = {}) {
  const headingSection = title
    ? `
        <tr>
          <td style="background:${accentColor}; padding: 30px 24px; text-align:center;">
            <h1 style="margin:0; font-size:28px; line-height:1.3; color:#ffffff; font-weight:700;">${escapeHtml(
              title
            )}</h1>
          </td>
        </tr>
      `
    : "";

  const trustpilotSection = includeTrustpilot ? buildTrustpilotSection() : "";
  const countdownSection = includeCountdownNotice
    ? buildCountdownNoticeHtml()
    : "";

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${escapeHtml(title || "SecondHandCell Update")}</title>
      <style>
        body { background-color:#f1f5f9; margin:0; padding:24px 12px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#0f172a; }
        .email-shell { width:100%; max-width:640px; margin:0 auto; background:#ffffff; border-radius:20px; overflow:hidden; box-shadow:0 25px 45px rgba(15,23,42,0.08); border:1px solid #e2e8f0; }
        .logo-cell { padding:28px 0 16px; text-align:center; background-color:#ffffff; }
        .logo-cell img { height:56px; width:auto; }
        .content-cell { padding:32px 30px; font-size:17px; line-height:1.75; }
        .content-cell p { margin:0 0 20px; }
        .footer-cell { padding:28px 32px; text-align:center; font-size:15px; color:#475569; background-color:#f8fafc; border-top:1px solid #e2e8f0; }
        .footer-cell p { margin:4px 0; }
        a.button-link { display:inline-block; padding:14px 26px; border-radius:9999px; background-color:#16a34a; color:#ffffff !important; font-weight:600; text-decoration:none; font-size:17px; }
      </style>
    </head>
    <body>
      <table role="presentation" cellpadding="0" cellspacing="0" class="email-shell">
        <tr>
          <td class="logo-cell">
            <img src="${EMAIL_LOGO_URL}" alt="SecondHandCell Logo" />
          </td>
        </tr>
        ${headingSection}
        <tr>
          <td class="content-cell">
            ${bodyHtml}
            ${countdownSection}
          </td>
        </tr>
        ${trustpilotSection ? `<tr><td>${trustpilotSection}</td></tr>` : ""}
        <tr>
          <td class="footer-cell">
            <p>${footerText}</p>
            <p>© ${new Date().getFullYear()} SecondHandCell. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

function buildLabelReminderEmail(orderId, order = {}) {
  const customerName = order.shippingInfo?.fullName || "there";
  const trackingNumber = getInboundTrackingNumber(order);
  const deviceName = order.device || "your device";
  const displayOrderId = orderId || order.id || "your order";

  const trackingSection = trackingNumber
    ? `
      <div class="tracking-box">
        <div class="tracking-label">Your Tracking Number</div>
        <div class="tracking-number">${trackingNumber}</div>
      </div>
      <a href="https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${trackingNumber}" class="cta-button">
        📍 Track Your Shipment
      </a>
    `
    : "";

  const subject = "⏰ Friendly Reminder: We're Waiting for Your Device! 📱";
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>⏰ Reminder: We're Waiting for Your Device!</title>
  <style>

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background-color: #f9fafb;
      margin: 0;
      padding: 0;
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
    }

    .email-container {
      max-width: 600px;
      margin: 40px auto;
      background-color: #ffffff;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }

    .header {
      background: linear-gradient(135deg, #f59e0b 0%, #f97316 50%, #ea580c 100%);
      padding: 48px 32px;
      text-align: center;
      position: relative;
      overflow: hidden;
    }

    .header::before {
      content: '';
      position: absolute;
      top: -50%;
      right: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
      animation: pulse 3s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.5; transform: scale(1); }
      50% { opacity: 0.8; transform: scale(1.1); }
    }

    .emoji-icon {
      font-size: 64px;
      margin-bottom: 16px;
      display: block;
      animation: bounce 2s ease-in-out infinite;
    }

    @keyframes bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }

    .header h1 {
      font-size: 32px;
      font-weight: 700;
      color: #ffffff;
      margin: 0;
      text-shadow: 0 2px 4px rgba(0,0,0,0.1);
      position: relative;
      z-index: 1;
    }

    .header p {
      font-size: 16px;
      color: rgba(255,255,255,0.95);
      margin: 12px 0 0;
      position: relative;
      z-index: 1;
    }

    .content {
      padding: 40px 32px;
      color: #374151;
      font-size: 16px;
      line-height: 1.6;
    }

    .greeting {
      font-size: 18px;
      font-weight: 600;
      color: #111827;
      margin-bottom: 24px;
    }

    .message-box {
      background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
      border-left: 4px solid #f59e0b;
      border-radius: 12px;
      padding: 24px;
      margin: 24px 0;
      box-shadow: 0 4px 12px rgba(245, 158, 11, 0.1);
    }

    .message-box p {
      margin: 0 0 12px;
      color: #92400e;
      font-weight: 600;
      font-size: 17px;
    }

    .message-box p:last-child {
      margin-bottom: 0;
    }

    .tracking-box {
      background: #f3f4f6;
      border-radius: 12px;
      padding: 20px;
      margin: 24px 0;
      text-align: center;
    }

    .tracking-label {
      font-size: 13px;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .tracking-number {
      font-size: 24px;
      font-weight: 700;
      color: #1f2937;
      font-family: 'Courier New', monospace;
      letter-spacing: 1px;
    }

    .cta-button {
      display: inline-block;
      background: linear-gradient(135deg, #f59e0b 0%, #f97316 100%);
      color: #ffffff;
      padding: 16px 32px;
      text-decoration: none;
      border-radius: 12px;
      font-weight: 700;
      font-size: 16px;
      margin: 24px auto;
      display: block;
      text-align: center;
      max-width: 280px;
      box-shadow: 0 8px 24px rgba(245, 158, 11, 0.3);
      transition: all 0.3s ease;
    }

    .cta-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 32px rgba(245, 158, 11, 0.4);
    }

    .urgency-text {
      background: #fef2f2;
      border: 2px solid #fecaca;
      border-radius: 12px;
      padding: 20px;
      margin: 24px 0;
      text-align: center;
    }

    .urgency-text p {
      margin: 0;
      color: #991b1b;
      font-weight: 600;
      font-size: 15px;
    }

    .urgency-text .icon {
      font-size: 24px;
      margin-bottom: 8px;
      display: block;
    }

    .footer {
      background: #f9fafb;
      padding: 32px;
      text-align: center;
      border-top: 1px solid #e5e7eb;
    }

    .footer p {
      margin: 8px 0;
      color: #6b7280;
      font-size: 14px;
    }

    .footer a {
      color: #f59e0b;
      text-decoration: none;
      font-weight: 600;
    }

    .footer a:hover {
      text-decoration: underline;
    }

    .divider {
      height: 1px;
      background: linear-gradient(90deg, transparent 0%, #e5e7eb 50%, transparent 100%);
      margin: 32px 0;
    }

    @media only screen and (max-width: 600px) {
      .email-container {
        margin: 20px auto;
        border-radius: 0;
      }

      .header {
        padding: 32px 24px;
      }

      .header h1 {
        font-size: 24px;
      }

      .content {
        padding: 32px 24px;
      }

      .emoji-icon {
        font-size: 48px;
      }

      .tracking-number {
        font-size: 18px;
      }

      .cta-button {
        padding: 14px 24px;
        font-size: 15px;
      }
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="header">
      <span class="emoji-icon">⏰</span>
      <h1>Friendly Reminder!</h1>
      <p>We're excited to complete your device trade-in</p>
    </div>

    <div class="content">
      <p class="greeting">Hi ${customerName},</p>

      <p>We wanted to send you a quick reminder about your device trade-in for order <strong>#${displayOrderId}</strong>!</p>

      <div class="message-box">
        <p>📦 Your shipping label is ready and waiting!</p>
        <p>We're excited to receive your <strong>${deviceName}</strong> and complete your trade-in.</p>
      </div>

      ${trackingSection}

      <div class="steps-list">
        <h3>📝 Quick Checklist Before Shipping:</h3>
        <ol>
          <li><strong>Back up your data</strong> - Save all photos, contacts, and files</li>
          <li><strong>Factory reset your device</strong> - Remove all personal information</li>
          <li><strong>Sign out of all accounts</strong> (iCloud, Google, etc.)</li>
          <li><strong>Remove your SIM card</strong></li>
          <li><strong>Pack securely</strong> and attach your shipping label</li>
        </ol>
      </div>

      <div class="urgency-text">
        <span class="icon">⚡</span>
        <p>The sooner you ship, the sooner you get paid!</p>
        <p>We typically process devices within 24-48 hours of receipt.</p>
      </div>

      <div class="divider"></div>

      <p style="text-align: center; color: #6b7280; font-size: 15px;">
        Have questions? Just reply to this email - we're here to help! 💬
      </p>
    </div>

    <div class="footer">
      <p><strong>SecondHandCell</strong></p>
      <p>Making device trade-ins simple and rewarding</p>
      <p style="margin-top: 16px;">
        <a href="https://secondhandcell.com">Visit our website</a> •
        <a href="mailto:support@secondhandcell.com">Contact Support</a>
      </p>
      <p style="margin-top: 16px; font-size: 12px;">
        This is an automated reminder for your trade-in order #${displayOrderId}
      </p>
    </div>
  </div>
</body>
</html>
  `.trim();

  return { subject, html };
}


// NEW HELPER: Sanitizes data to ensure all values are strings for FCM payload compliance.
function stringifyData(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    out[String(k)] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

const kitStatusOrder = ['needs_printing', 'kit_sent', KIT_TRANSIT_STATUS, 'kit_delivered'];

function normalizeKitStatusValue(status) {
  if (!status) return status;
  const value = String(status).toLowerCase();
  if (value === 'kit_in_transit') {
    return KIT_TRANSIT_STATUS;
  }
  return status;
}

function normalizeTransitStatus(status) {
  const normalized = (status || '')
    .toString()
    .trim()
    .toLowerCase();

  if (normalized === 'phone_on_the_way_to_us') {
    return PHONE_TRANSIT_STATUS;
  }

  return normalized;
}

function hasReachedInboundTransit(status) {
  const normalized = normalizeTransitStatus(status);
  return (
    normalized === PHONE_TRANSIT_STATUS ||
    normalized === 'delivered_to_us' ||
    normalized === 'received' ||
    normalized === 'completed'
  );
}

function mapShipEngineStatus(code) {
  if (!code) return null;
  const normalized = String(code).toUpperCase();
  switch (normalized) {
    case 'DELIVERED':
    case 'DELIVERED_TO_AGENT':
      return 'kit_delivered';
    case 'OUT_FOR_DELIVERY':
    case 'IN_TRANSIT':
    case 'ACCEPTED':
    case 'SHIPMENT_ACCEPTED':
    case 'LABEL_CREATED':
    case 'UNKNOWN':
      return KIT_TRANSIT_STATUS;
    default:
      return null;
  }
}

function shouldPromoteKitStatus(currentStatus, nextStatus) {
  if (!nextStatus) return false;
  const normalizedCurrent = normalizeKitStatusValue(currentStatus);
  const normalizedNext = normalizeKitStatusValue(nextStatus);
  const currentIndex = kitStatusOrder.indexOf(normalizedCurrent);
  const nextIndex = kitStatusOrder.indexOf(normalizedNext);
  if (nextIndex === -1) return false;
  if (currentIndex === -1) return true;
  return nextIndex > currentIndex;
}

function getTimestampMillis(value) {
  const date = toDate(value);
  return date ? date.getTime() : null;
}

function isKitOrder(order = {}) {
  return (order.shippingPreference || "").toLowerCase() === "shipping kit requested";
}

function isEmailLabelOrder(order = {}) {
  return (order.shippingPreference || "").toLowerCase() === "email label requested";
}

function getInboundTrackingNumber(order = {}) {
  if (!order || typeof order !== "object") {
    return null;
  }
  return order.inboundTrackingNumber || order.trackingNumber || null;
}

function shouldTrackInbound(order = {}) {
  if (!order || typeof order !== "object") return false;
  const status = normalizeTransitStatus(order.status);
  if (status === 'emailed' && isBalanceEmailStatus(order)) {
    return false;
  }
  if (!INBOUND_TRACKABLE_STATUSES.has(status)) return false;
  return Boolean(getInboundTrackingNumber(order));
}

function deriveInboundStatusUpdate(order = {}, normalizedStatus, trackingMetadata = {}) {
  if (!normalizedStatus) return null;
  const upper = String(normalizedStatus).toUpperCase();
  const kitOrder = isKitOrder(order);
  const emailLabelOrder = isEmailLabelOrder(order);
  const currentStatus = normalizeTransitStatus(order.status);
  const hasEstimatedDelivery = Boolean(
    trackingMetadata?.labelTrackingEstimatedDelivery ||
      trackingMetadata?.estimatedDelivery ||
      trackingMetadata?.estimated_delivery_date ||
      trackingMetadata?.estimatedDeliveryDate ||
      trackingMetadata?.estimated_delivery
  );
  const baseStatus = normalizeTransitStatus(
    kitOrder
      ? resolveInboundTransitResetStatus(order)
      : emailLabelOrder
        ? 'label_generated'
        : currentStatus
  );

  if (upper === 'DELIVERED' || upper === 'DELIVERED_TO_AGENT') {
    if (currentStatus === 'delivered_to_us') {
      return null;
    }

    if (kitOrder) {
      if (currentStatus === 'received') {
        return null;
      }
      return { nextStatus: 'delivered_to_us', delivered: true, markKitDelivered: true };
    }

    if (emailLabelOrder) {
      return { nextStatus: 'delivered_to_us', delivered: true, autoReceive: true };
    }

    return { nextStatus: 'delivered_to_us', delivered: true };
  }

  const movementStatuses = new Set([
    'OUT_FOR_DELIVERY',
    'IN_TRANSIT',
    'ACCEPTED',
    'SHIPMENT_ACCEPTED',
  ]);

  if (movementStatuses.has(upper) && (kitOrder || emailLabelOrder)) {
    return { nextStatus: PHONE_TRANSIT_STATUS, delivered: false };
  }

  const noMovementStatuses = new Set(['LABEL_CREATED', 'UNKNOWN', 'NOT_YET_IN_SYSTEM']);
  if (noMovementStatuses.has(upper) && baseStatus && baseStatus !== currentStatus && !hasReachedInboundTransit(currentStatus)) {
    return { nextStatus: baseStatus, delivered: false };
  }

  if (baseStatus && baseStatus !== currentStatus && !hasReachedInboundTransit(currentStatus)) {
    return { nextStatus: baseStatus, delivered: false };
  }

  return null;
}

function getReturnCountdownStartMillis(order = {}) {
  if (!order || typeof order !== 'object') {
    return null;
  }

  const manualStart = getTimestampMillis(order.returnCountdownStartedAt);
  if (typeof manualStart === 'number' && !Number.isNaN(manualStart)) {
    return manualStart;
  }

  if (isKitOrder(order)) {
    const deliveredAt = getTimestampMillis(order.kitDeliveredAt);
    if (typeof deliveredAt === 'number' && !Number.isNaN(deliveredAt)) {
      return deliveredAt;
    }
    return null;
  }

  const labelGeneratedAt = getTimestampMillis(order.labelGeneratedAt);
  if (typeof labelGeneratedAt === 'number' && !Number.isNaN(labelGeneratedAt)) {
    return labelGeneratedAt;
  }

  const lastStatusAt = getTimestampMillis(order.lastStatusUpdateAt);
  if (typeof lastStatusAt === 'number' && !Number.isNaN(lastStatusAt)) {
    return lastStatusAt;
  }

  const createdAt = getTimestampMillis(order.createdAt);
  if (typeof createdAt === 'number' && !Number.isNaN(createdAt)) {
    return createdAt;
  }

  return null;
}

// Custom function to send FCM push notification to a specific token or list of tokens
function isInvalidFcmToken(error) {
  const code = error?.code || error?.errorInfo?.code;
  const message = String(error?.message || '').toLowerCase();
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    message.includes('notregistered') ||
    message.includes('requested entity was not found')
  );
}

async function sendPushNotification(tokens, title, body, data = {}, options = {}) {
  if (!firebaseNotificationsEnabled()) {
    console.warn('Skipping Firebase push notification send; FIREBASE_NOTIFICATIONS_ENABLED is false.');
    return null;
  }

  const normalizedTokens = Array.isArray(tokens)
    ? tokens.filter(Boolean)
    : (tokens ? [tokens] : []);

  if (!normalizedTokens.length) {
    return null;
  }

  const response = await admin.messaging().sendEachForMulticast({
    notification: { title, body },
    data: stringifyData(data),
    tokens: normalizedTokens,
  });

  if (response.failureCount > 0) {
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        console.error(`Failed to send FCM to token ${normalizedTokens[idx]}:`, resp.error?.message || resp.error);
        if (options.tokenRefs?.[idx] && isInvalidFcmToken(resp.error)) {
          options.tokenRefs[idx]
            .delete()
            .catch((deleteError) => {
              console.error('Failed to delete invalid FCM token document:', deleteError);
            });
        }
      }
    });
  }

  return response;
}

async function sendLabelReminderEmail(order, { tier = 1 } = {}) {
  if (!order || !order.id) {
    return false;
  }

  const email = order.shippingInfo?.email;
  if (!email) {
    return false;
  }

  const { subject, html } = buildLabelReminderEmail(order.id, order);

  await transporter.sendMail({
    from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
    to: email,
    subject,
    html,
  });

  const additionalUpdates = {
    lastReminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (tier === 1 && !order.labelReminderFirstSentAt) {
    additionalUpdates.labelReminderFirstSentAt =
      admin.firestore.FieldValue.serverTimestamp();
  } else if (tier === 2 && !order.labelReminderSecondSentAt) {
    additionalUpdates.labelReminderSecondSentAt =
      admin.firestore.FieldValue.serverTimestamp();
  }

  await recordCustomerEmail(
    order.id,
    `Automated label reminder (day ${tier === 2 ? "10+" : "5+"}) sent to customer.`,
    {
      status: order.status,
      auto: true,
      reminderTier: tier,
    },
    {
      logType: "reminder",
      additionalUpdates,
    }
  );

  return true;
}

// Re-using and slightly updating the old sendAdminPushNotification to fetch ALL admin tokens.
async function sendAdminPushNotification(title, body, data = {}) {
  if (!firebaseNotificationsEnabled()) {
    console.warn('Skipping Firebase admin push notification; FIREBASE_NOTIFICATIONS_ENABLED is false.');
    return null;
  }

  const adminsSnapshot = await adminsCollection.get();
  const allTokens = [];

  for (const adminDoc of adminsSnapshot.docs) {
    const tokensSnapshot = await adminsCollection
      .doc(adminDoc.id)
      .collection('fcmTokens')
      .get();

    tokensSnapshot.forEach((tokenDoc) => {
      if (tokenDoc.id) {
        allTokens.push(tokenDoc.id);
      }
    });
  }

  if (!allTokens.length) {
    return null;
  }

  return sendPushNotification(allTokens, title, body, data);
}

async function addAdminFirestoreNotification(
  adminUid,
  message,
  relatedDocType = null,
  relatedDocId = null,
  relatedUserId = null
) {
  if (!firebaseNotificationsEnabled()) {
    console.warn('Skipping Firebase Firestore notification; FIREBASE_NOTIFICATIONS_ENABLED is false.');
    return null;
  }

  const payload = {
    message,
    isRead: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    relatedDocType,
    relatedDocId,
    relatedUserId,
  };

  if (adminUid) {
    await adminsCollection.doc(adminUid).collection('notifications').add(payload);
    return 1;
  }

  const adminsSnapshot = await adminsCollection.get();
  const writes = adminsSnapshot.docs.map((adminDoc) =>
    adminsCollection.doc(adminDoc.id).collection('notifications').add(payload)
  );
  await Promise.all(writes);
  return writes.length;
}

async function createShipEngineLabel(fromAddress, toAddress, labelReference, packageData, context = {}) {
  const isSandbox = false;
  const serviceCode = packageData?.service_code || "usps_ground_advantage";
  const weightValue = packageData?.weight?.value ?? packageData?.weight?.ounces;
  const weightUnit = packageData?.weight?.unit || "ounce";
  const payload = {
    shipment: {
      service_code: serviceCode,
      ship_to: toAddress,
      ship_from: fromAddress,
      packages: [
        {
          weight: { value: weightValue, unit: weightUnit },
          dimensions: {
            unit: "inch",
            height: packageData.dimensions.height,
            width: packageData.dimensions.width,
            length: packageData.dimensions.length,
          },
          // USPS requires hazmat metadata for lithium batteries and related materials.
          hazmat: true,
          hazmat_type: "surface",
          label_messages: {
            reference1: labelReference,
          },
        },
      ],
    },
  };
  if (isSandbox) payload.testLabel = true;

  const shipEngineApiKey = getShipEngineApiKey();
  if (!shipEngineApiKey) {
    throw new Error(
      "ShipEngine API key not configured. Please set 'shipengine.key' environment variable."
    );
  }

  try {
    const response = await axios.post("https://api.shipengine.com/v1/labels", payload, {
      headers: {
        "API-Key": shipEngineApiKey,
        "Content-Type": "application/json",
      },
    });
    return response.data;
  } catch (error) {
    const status = error?.response?.status;
    const detail = error?.response?.data || error?.message || error;
    const requestId = error?.response?.data?.request_id || null;
    const failureMetadata = {
      orderId: context?.orderId || null,
      deviceCount: context?.deviceCount ?? null,
      chosenService: context?.chosenService || null,
      weightOz: context?.weightOz ?? null,
      blocks: context?.blocks ?? null,
      request_id: requestId,
    };

    console.error(
      "ShipEngine label generation failed",
      JSON.stringify(failureMetadata),
      typeof detail === "string" ? detail : JSON.stringify(detail)
    );

    const messagePrefix =
      typeof detail === "object" && detail?.errors?.length
        ? detail.errors.map((entry) => entry.message).join("; ")
        : detail;

    const errorMessage = messagePrefix || "ShipEngine label generation failed";
    const wrappedError = new Error(errorMessage);
    if (status) wrappedError.status = status;
    wrappedError.responseData = detail;
    wrappedError.requestId = requestId;
    throw wrappedError;
  }
}

function formatStatusForEmail(status) {
  if (status === "order_pending") return "Order Pending";
  if (status === "shipping_kit_requested" || status === "kit_needs_printing" || status === "needs_printing")
    return "Needs Printing";
  if (status === "kit_sent") return "Kit Sent";
  if (status === "kit_delivered") return "Kit Delivered";
  return status
    .replace(/_/g, " ")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatShippingAddressForLog(shippingInfo = {}) {
  if (!shippingInfo || typeof shippingInfo !== "object") {
    return "N/A";
  }

  const parts = [];
  if (shippingInfo.streetAddress) {
    parts.push(shippingInfo.streetAddress);
  }

  const cityState = [shippingInfo.city, shippingInfo.state]
    .filter((value) => value && String(value).trim().length)
    .join(", ");

  if (cityState) {
    const withZip = shippingInfo.zipCode
      ? `${cityState} ${shippingInfo.zipCode}`
      : cityState;
    parts.push(withZip);
  } else if (shippingInfo.zipCode) {
    parts.push(shippingInfo.zipCode);
  }

  return parts.length ? parts.join(", ") : "N/A";
}

// Renamed from sendTestEmail to avoid conflict
async function sendMultipleTestEmails(email, emailTypes) {
  const mockOrderData = {
    id: "TEST-00001",
    shippingInfo: {
      fullName: "Test User",
      email: email,
      streetAddress: "123 Test St",
      city: "Test City",
      state: "TS",
      zipCode: "12345",
    },
    device: "iPhone 13",
    storage: "256GB",
    carrier: "Unlocked",
    estimatedQuote: 500,
    paymentMethod: "echeck",
    paymentDetails: {
      accountNumber: "0001234567",
      routingNumber: "021000021",
    },
    uspsLabelUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    trackingNumber: "1234567890",
    reOffer: {
      newPrice: 400,
      reasons: ["Cracked Screen", "Deep Scratches"],
      comments: "Device had more cosmetic damage than initially stated.",
      autoAcceptDate: admin.firestore.Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
    returnLabelUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    returnTrackingNumber: "0987654321",
  };
  
  const mockOrderDataWithoutReoffer = {
    id: "TEST-00002",
    shippingInfo: {
      fullName: "Test User 2",
      email: email,
    },
    device: "iPhone 15 Pro",
    storage: "256GB",
    carrier: "unlocked",
    estimatedQuote: 875,
    paymentMethod: "paypal",
    reOffer: null,
    returnLabelUrl: null,
  };

  const mockOrderDataReoffered = {
    id: "TEST-00003",
    shippingInfo: {
      fullName: "Test User 3",
      email: email,
    },
    reOffer: {
      newPrice: 350,
      reasons: ["Cracked Screen"],
      comments: "Minor cracks on the back glass.",
      autoAcceptDate: admin.firestore.Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
    returnLabelUrl: null,
  };

  const mockOrderDataReturned = {
    id: "TEST-00004",
    shippingInfo: {
      fullName: "Test User 4",
      email: email,
    },
    reOffer: {
      newPrice: 350,
      reasons: ["Cracked Screen"],
      comments: "Minor cracks on the back glass.",
      autoAcceptDate: admin.firestore.Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
    returnLabelUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
  };
  
  const mailPromises = emailTypes.map(emailType => {
    let subject;
    let htmlBody;
    let orderToUse;

    switch (emailType) {
      case "shipping-label":
        orderToUse = mockOrderData;
        subject = `[TEST] Your SecondHandCell Shipping Label for Order #${orderToUse.id}`;
        htmlBody = SHIPPING_LABEL_EMAIL_HTML
          .replace(/\*\*CUSTOMER_NAME\*\*/g, orderToUse.shippingInfo.fullName)
          .replace(/\*\*ORDER_ID\*\*/g, orderToUse.id)
          .replace(/\*\*TRACKING_NUMBER\*\*/g, orderToUse.trackingNumber)
          .replace(/\*\*LABEL_DOWNLOAD_LINK\*\*/g, orderToUse.uspsLabelUrl)
          .replace(/\*\*TRACK_STATUS_LINK\*\*/g, `https://secondhandcell.com/track-order.html?orderId=${encodeURIComponent(orderToUse.id)}&fromEmailLink=1`);
        break;
      case "reoffer":
        orderToUse = mockOrderData;
        subject = `[TEST] Re-offer for Order #${orderToUse.id}`;
        let reasonString = orderToUse.reOffer.reasons.join(", ");
        if (orderToUse.reOffer.comments) reasonString += `; ${orderToUse.reOffer.comments}`;
        htmlBody = buildEmailLayout({
          title: "Updated offer available",
          accentColor: "#6366f1",
          bodyHtml: `
              <p>Hi ${escapeHtml(orderToUse.shippingInfo.fullName)},</p>
              <p>Thanks for sending in your device. After inspection of order <strong>#${escapeHtml(orderToUse.id)}</strong>, we have an updated offer for you.</p>
              <div style="background:#eef2ff; border:1px solid #c7d2fe; border-radius:18px; padding:20px 24px; margin:28px 0;">
                <p style="margin:0 0 12px; color:#312e81;"><strong>Original Quote:</strong> $${orderToUse.estimatedQuote.toFixed(2)}</p>
                <p style="margin:0; color:#1e1b4b; font-size:20px; font-weight:700;">New Offer: $${orderToUse.reOffer.newPrice.toFixed(2)}</p>
              </div>
              <p style="margin-bottom:12px;">Reason for the change:</p>
              <p style="background:#fef3c7; border-radius:14px; border:1px solid #fde68a; color:#92400e; padding:14px 18px; margin:0 0 28px;">${escapeHtml(reasonString).replace(/\n/g, "<br>")}</p>
              <p style="margin-bottom:20px;">Review the updated offer and choose how you'd like to proceed:</p>
              <div style="text-align:center; margin-bottom:20px;">
                <a href="https://secondhandcell.com/track-order.html?orderId=${encodeURIComponent(orderToUse.id)}&fromEmailLink=1&fromReofferLink=1&scrollToReoffer=1" class="button-link" style="background-color:#16a34a;">Review offer & choose</a>
              </div>
              <p>Questions or feedback? Reply to this email—we're here to help.</p>
          `,
        });
        break;
      case "final-offer-accepted":
        orderToUse = mockOrderData;
        subject = `[TEST] Offer Accepted for Order #${orderToUse.id}`;
        htmlBody = `
          <p>Hello ${orderToUse.shippingInfo.fullName},</p>
          <p>Great news! Your order <strong>#${orderToUse.id}</strong> has been completed and payment has been processed.</p>
          <p>If you have any questions about your payment, please let us know.</p>
          <p>Thank you for choosing SecondHandCell!</p>
        `;
        break;
      case "return-label":
        orderToUse = mockOrderData;
        subject = `[TEST] Your SecondHandCell Return Label`;
        htmlBody = `
          <p>Hello ${orderToUse.shippingInfo.fullName},</p>
          <p>As requested, here is your return shipping label for your device (Order ID: ${orderToUse.id}):</p>
          <p>Return Tracking Number: <strong>${orderToUse.returnTrackingNumber}</strong></p>
          <a href="${orderToUse.returnLabelUrl}">Download Return Label</a>
          <p>Thank you,</p>
          <p>The SecondHandCell Team</p>
        `;
        break;
      case "blacklisted":
        orderToUse = mockOrderData;
        subject = `[TEST] Important Notice Regarding Your Device - Order #${orderToUse.id}`;
        htmlBody = BLACKLISTED_EMAIL_HTML
          .replace(/\*\*CUSTOMER_NAME\*\*/g, orderToUse.shippingInfo.fullName)
          .replace(/\*\*ORDER_ID\*\*/g, orderToUse.id)
          .replace(/\*\*STATUS_REASON\*\*/g, "stolen or blacklisted")
          .replace(/\*\*LEGAL_TEXT\*\*/g, "This is mock legal text for testing.");
        break;
      case "fmi":
        orderToUse = mockOrderData;
        subject = `[TEST] Action Required for Order #${orderToUse.id}`;
        htmlBody = FMI_EMAIL_HTML
          .replace(/\*\*CUSTOMER_NAME\*\*/g, orderToUse.shippingInfo.fullName)
          .replace(/\*\*ORDER_ID\*\*/g, orderToUse.id)
          .replace(/\*\*CONFIRM_URL\*\*/g, `https://example.com/mock-confirm-fmi`);
        break;
      case "balance-due":
        orderToUse = mockOrderData;
        subject = `[TEST] Action Required for Order #${orderToUse.id}`;
        htmlBody = BAL_DUE_EMAIL_HTML
          .replace(/\*\*CUSTOMER_NAME\*\*/g, orderToUse.shippingInfo.fullName)
          .replace(/\*\*ORDER_ID\*\*/g, orderToUse.id)
          .replace(/\*\*FINANCIAL_STATUS\*\*/g, orderToUse.financialStatus === "BalanceDue" ? "an outstanding balance" : "a past due balance");
        break;
      case "completed":
        orderToUse = mockOrderDataWithoutReoffer;
        subject = `[TEST] Your SecondHandCell Order is Complete!`;
        const mockPayout = getOrderPayout(orderToUse);
        const template = getOrderCompletedEmailTemplate({ includeTrustpilot: !orderToUse.reOffer });
        htmlBody = applyTemplate(template, {
          "**CUSTOMER_NAME**": orderToUse.shippingInfo.fullName,
          "**ORDER_ID**": orderToUse.id,
          "**DEVICE_SUMMARY**": buildDeviceSummary(orderToUse),
          "**ORDER_TOTAL**": formatCurrencyValue(mockPayout),
          "**PAYMENT_METHOD**": formatDisplayText(orderToUse.paymentMethod, "Not specified"),
        });
        break;
      default:
        return Promise.resolve();
    }

    const mailOptions = {
      from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
      to: email,
      subject: subject,
      html: htmlBody,
    };

    return transporter.sendMail(mailOptions);
  });

  await Promise.all(mailPromises);
  return { message: "Test emails sent successfully." };
}

const emailsRouter = createEmailsRouter({
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
});

app.use('/', emailsRouter);

const ordersRouter = createOrdersRouter({
  axios,
  admin,
  ordersCollection,
  adminsCollection,
  writeOrderBoth,
  updateOrderBoth,
  generateNextOrderNumber,
  stateAbbreviations,
  templates: {
    ORDER_RECEIVED_EMAIL_HTML,
    ORDER_PLACED_ADMIN_EMAIL_HTML,
    SHIPPING_KIT_EMAIL_HTML,
    SHIPPING_LABEL_EMAIL_HTML,
  },
  notifications: {
    sendAdminPushNotification,
    addAdminFirestoreNotification,
  },
  pdf: {
    generateCustomLabelPdf,
    generateBagLabelPdf,
    mergePdfBuffers,
  },
  shipEngine: {
    cloneShipEngineLabelMap,
    buildLabelIdList,
    isLabelPendingVoid,
    handleLabelVoid,
    sendVoidNotificationEmail,
  },
  createShipEngineLabel,
  transporter,
  deviceHelpers: {
    buildOrderDeviceKey,
    collectOrderDeviceKeys,
    deriveOrderStatusFromDevices,
  },
});

app.use('/', ordersRouter);

// ------------------------------
// ROUTES
// ------------------------------

app.put("/orders/:id/shipping-info", async (req, res) => {
  try {
    const orderId = req.params.id;
    const incoming = req.body && typeof req.body === "object" ? req.body : {};

    if (!orderId) {
      return res.status(400).json({ error: "Order ID is required." });
    }

    const orderRef = ordersCollection.doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return res.status(404).json({ error: "Order not found." });
    }

    const existingOrder = orderSnap.data() || {};
    const fieldLabels = {
      fullName: "Full name",
      email: "Email",
      phone: "Phone",
      streetAddress: "Street address",
      city: "City",
      state: "State",
      zipCode: "ZIP / Postal code",
    };

    const updatePayload = {};
    const providedFields = Object.keys(fieldLabels).filter((field) =>
      Object.prototype.hasOwnProperty.call(incoming, field)
    );

    if (!providedFields.length) {
      return res.status(400).json({ error: "No shipping fields were provided." });
    }

    for (const field of providedFields) {
      const label = fieldLabels[field];
      let value = incoming[field];
      if (typeof value === "string") {
        value = value.trim();
      }

      if (!value) {
        return res.status(400).json({ error: `${label} is required.` });
      }

      if (field === "state") {
        value = String(value).toUpperCase();
        if (value.length !== 2) {
          return res
            .status(400)
            .json({ error: "State must use the 2-letter abbreviation." });
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
        type: "update",
        message: `Updated shipping address: ${formatShippingAddressForLog(mergedShippingInfo)}`,
      },
    ];

    const { order } = await updateOrderBoth(orderId, updatePayload, {
      autoLogStatus: false,
      logEntries,
    });

    res.json({
      message: "Shipping address updated.",
      shippingInfo: order.shippingInfo || {},
    });
  } catch (error) {
    console.error("Error updating shipping info:", error);
    res.status(500).json({ error: "Failed to update shipping address." });
  }
});


app.put("/orders/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const orderId = req.params.id;
    if (!status) return res.status(400).json({ error: "Status is required" });

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
    let emailMetadata = { status };

    if (notifyCustomer) {
      let customerNotificationPromise = Promise.resolve();
      let customerEmailHtml = "";
      const customerName = order.shippingInfo?.fullName || 'there';

      switch (status) {
        case "received": {
          customerEmailHtml = DEVICE_RECEIVED_EMAIL_HTML
            .replace(/\*\*CUSTOMER_NAME\*\*/g, customerName)
            .replace(/\*\*ORDER_ID\*\*/g, order.id);

          customerNotificationPromise = transporter.sendMail({
            from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
            to: order.shippingInfo.email,
            subject: "Your SecondHandCell Device Has Arrived",
            html: customerEmailHtml,
          });
          emailLogMessage = "Received confirmation email sent to customer.";
          emailMetadata.trackingNumber = order.trackingNumber || order.inboundTrackingNumber || null;
          break;
        }
        case "completed": {
          const payoutAmount = getOrderPayout(order);
          const wasReoffered = !!(order.reOffer && Object.keys(order.reOffer).length);
          const completedTemplate = getOrderCompletedEmailTemplate({ includeTrustpilot: !wasReoffered });
          customerEmailHtml = applyTemplate(completedTemplate, {
            "**CUSTOMER_NAME**": customerName,
            "**ORDER_ID**": order.id,
            "**DEVICE_SUMMARY**": buildDeviceSummary(order),
            "**ORDER_TOTAL**": formatCurrencyValue(payoutAmount),
            "**PAYMENT_METHOD**": formatDisplayText(order.paymentMethod, "Not specified"),
          });

          customerNotificationPromise = transporter.sendMail({
            from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
            to: order.shippingInfo.email,
            subject: "Your SecondHandCell Order is Complete",
            html: customerEmailHtml,
          });
          emailLogMessage = "Order completion email sent to customer.";
          emailMetadata.payoutAmount = formatCurrencyValue(payoutAmount);
          emailMetadata.wasReoffered = wasReoffered;
          break;
        }
        default: {
          break;
        }
      }

      await customerNotificationPromise;

      if (emailLogMessage) {
        await recordCustomerEmail(orderId, emailLogMessage, emailMetadata);
      }
    }

    const responseMessage = notifyCustomer
      ? `Order marked as ${status}`
      : `Order marked as ${status} without emailing the customer.`;

    res.json({ message: responseMessage, notifyCustomer });
  } catch (err) {
    console.error("Error updating status:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

app.post('/orders/:id/send-review-request', async (req, res) => {
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
      "**CUSTOMER_NAME**": customerName,
      "**ORDER_ID**": order.id,
      "**DEVICE_SUMMARY**": buildDeviceSummary(order),
      "**ORDER_TOTAL**": formatCurrencyValue(payoutAmount),
    });

    await transporter.sendMail({
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

app.post('/orders/:id/mark-kit-sent', async (req, res) => {
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

  if (!options.force) {
    const cooldownMessage = describeTrackingRefreshCooldown(order, 'kit');
    if (cooldownMessage) {
      return { skipped: true, reason: cooldownMessage };
    }
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
      axiosClient: axios,
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
  const refreshSource = String(options.source || 'admin_manual').toLowerCase();
  const updateData = {
    ...updatePayload,
    kitTrackingLastRefreshedAt: timestamp,
    lastTrackingRefreshAt: timestamp,
    lastTrackingRefreshSource: refreshSource,
  };

  if (direction === 'inbound') {
    updateData.inboundTrackingLastRefreshedAt = timestamp;
  }

  const { order: updatedOrder } = await updateOrderBoth(orderId, updateData);

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
        await syncInboundTrackingForOrder(updatedOrder, { shipengineKey, source: refreshSource });
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

app.post('/orders/:id/refresh-kit-tracking', async (req, res) => {
  try {
    const payload = await refreshKitTrackingById(req.params.id, {
      source: 'admin_manual',
      force: Boolean(req.body?.force),
    });
    res.json(payload);
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('Error refreshing kit tracking:', error);
    res.status(500).json({ error: 'Failed to refresh kit tracking' });
  }
});

app.post('/orders/:id/sync-outbound-tracking', async (req, res) => {
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

    const response = await axios.get(trackingUrl, {
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

    const { order: updatedOrder } = await updateOrderBoth(orderId, updatePayload);

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

  if (!options.force) {
    const cooldownMessage = describeTrackingRefreshCooldown(order, 'inbound');
    if (cooldownMessage) {
      return {
        order,
        tracking: null,
        skipped: 'recently_refreshed',
        reason: cooldownMessage,
      };
    }
  }

  const shipEngineKey = options.shipengineKey || process.env.SHIPENGINE_KEY || null;
  const shipStationCredentials = options.shipstationCredentials || getShipStationCredentials();
  if (!shipEngineKey && !shipStationCredentials) {
    throw new Error('ShipEngine or ShipStation API credentials not configured.');
  }

  const axiosClient = options.axiosClient || axios;
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
  const refreshSource = String(options.source || 'system_automatic').toLowerCase();

  if (!trackingData || typeof trackingData !== 'object') {
    const { order: updatedOrder } = await updateOrderBoth(order.id, {
      labelTrackingLastSyncedAt: timestamp,
      lastTrackingRefreshAt: timestamp,
      lastTrackingRefreshSource: refreshSource,
    }, {
      autoLogStatus: false,
      logEntries: [
        {
          type: 'tracking',
          message: 'Inbound label tracking sync attempted but ShipEngine returned no data.',
          metadata: { trackingNumber },
        },
      ],
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
    lastTrackingRefreshAt: timestamp,
    lastTrackingRefreshSource: refreshSource,
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
    await transporter.sendMail({
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

async function maybeSendReturnReminder(order) {
  if (!order || !order.id) {
    return order;
  }

  const status = (order.status || '').toLowerCase();
  if (!INBOUND_TRACKABLE_STATUSES.has(status)) {
    return order;
  }

  if (status === 'emailed' && isBalanceEmailStatus(order)) {
    return order;
  }

  if (status === 'delivered_to_us') {
    return order;
  }

  if (order.returnReminderSentAt) {
    return order;
  }

  const countdownStart = getReturnCountdownStartMillis(order);
  if (!countdownStart) {
    return order;
  }

  if (Date.now() - countdownStart < RETURN_REMINDER_DELAY_MS) {
    return order;
  }

  const email = order.shippingInfo?.email;
  if (!email) {
    return order;
  }

  const customerName = order.shippingInfo?.fullName || 'there';
  const descriptor = isKitOrder(order)
    ? `It's been 13 days since your shipping kit for order #${order.id} was delivered.`
    : `It's been 13 days since we emailed your prepaid label for order #${order.id}.`;

  const htmlBody = `
    <p>Hi ${escapeHtml(customerName)},</p>
    <p>${escapeHtml(descriptor)} Your order will expire in 2 days if we don't see the device on the way back to us.</p>
    <p>Please send your device soon so we can keep everything moving and get your payout processed.</p>
    <p>If you need a hand or a fresh label, just reply to this email and we'll help right away.</p>
    <p>— The SecondHandCell Team</p>
  `;

  try {
    await transporter.sendMail({
      from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `Reminder: 2 days left to send your device for order #${order.id}`,
      html: htmlBody,
    });

    const recordResult = await recordCustomerEmail(order.id, '13-day return reminder email sent to customer.', {
      auto: true,
      reminderDays: 13,
    }, {
      additionalUpdates: {
        returnReminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });

    return recordResult?.order || order;
  } catch (error) {
    console.error(`Failed to send 13-day reminder for order ${order.id}:`, error);
    return order;
  }
}

async function maybeAutoCancelAgingOrder(order, options = {}) {
  if (!order || !order.id) {
    return order;
  }

  if (!AUTO_CANCELLATION_ENABLED) {
    return order;
  }

  const status = (order.status || '').toLowerCase();
  const kitOrder = isKitOrder(order);
  const emailOrder = isEmailLabelOrder(order);

  if (!emailOrder && !(kitOrder && status === 'kit_delivered')) {
    return order;
  }

  if (!INBOUND_TRACKABLE_STATUSES.has(status)) {
    return order;
  }

  if (status === 'emailed' && isBalanceEmailStatus(order)) {
    return order;
  }

  if ((order.returnAutoCancelledAt || order.autoCancelled) && status === 'cancelled') {
    return order;
  }

  const countdownStart = getReturnCountdownStartMillis(order);
  if (!countdownStart) {
    return order;
  }

  if (Date.now() - countdownStart < RETURN_AUTO_VOID_DELAY_MS) {
    return order;
  }

  const shipengineKey = options.shipengineKey || process.env.SHIPENGINE_KEY;
  let workingOrder = order;

  try {
    const labels = normalizeShipEngineLabelMap(order);
    const selections = Object.entries(labels)
      .filter(([, entry]) => entry && entry.id && isLabelPendingVoid(entry))
      .map(([key, entry]) => ({ key, id: entry.id }));

    if (shipengineKey && selections.length) {
      await handleLabelVoid(order, selections, {
        reason: 'automatic',
        shipengineKey,
      });

      const refreshed = await ordersCollection.doc(order.id).get();
      if (refreshed.exists) {
        workingOrder = { id: refreshed.id, ...refreshed.data() };
      }
    }
  } catch (error) {
    console.error(`Failed to auto-void labels for order ${order.id}:`, error);
  }

  let cancelledOrder = workingOrder;
  try {
    const { order: updatedOrder } = await cancelOrderAndNotify(workingOrder, {
      auto: true,
      reason: 'return_window_expired',
      notifyCustomer: false,
      voidLabels: false,
    });
    cancelledOrder = updatedOrder || workingOrder;
  } catch (error) {
    console.error(`Failed to auto-cancel order ${order.id}:`, error);
    return order;
  }

  try {
    await updateOrderBoth(cancelledOrder.id, {
      returnAutoVoidedAt: admin.firestore.FieldValue.serverTimestamp(),
      returnAutoCancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {
      autoLogStatus: false,
    });
  } catch (error) {
    console.error(`Failed to tag auto-cancellation timestamps for order ${order.id}:`, error);
  }

  const email = cancelledOrder.shippingInfo?.email;
  if (!email) {
    return cancelledOrder;
  }

  const customerName = cancelledOrder.shippingInfo?.fullName || 'there';
  const continuation = isKitOrder(cancelledOrder)
    ? 'Reply to this email and we will send a fresh prepaid label—just stick it on top of the replacement shipping kit when it arrives.'
    : 'Reply to this email and we will send a fresh prepaid label you can use right away.';

  const htmlBody = `
    <p>Hi ${escapeHtml(customerName)},</p>
    <p>We voided the shipping label for order <strong>#${escapeHtml(cancelledOrder.id)}</strong> because we haven\'t received your device in 25 days. We do this to keep orders moving for everyone.</p>
    <p>${escapeHtml(continuation)}</p>
    <p>If you decided not to send your device, just reply and let us know so we can close things out. If you change your mind later, respond and we\'ll send another prepaid label.</p>
    <p>— The SecondHandCell Team</p>
  `;

  try {
    await transporter.sendMail({
      from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `Order #${cancelledOrder.id} was voided after 25 days`,
      html: htmlBody,
    });

    await recordCustomerEmail(cancelledOrder.id, 'Order auto-voided after 25 days without inbound shipment.', {
      auto: true,
      reason: 'return_window_expired',
    }, {
      additionalUpdates: {
        returnAutoVoidNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });
  } catch (error) {
    console.error(`Failed to send auto-cancellation email for order ${order.id}:`, error);
  }

  return cancelledOrder;
}

async function refreshEmailLabelTrackingById(orderId, options = {}) {
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
  const result = await syncInboundTrackingForOrder(order, {
    source: options.source || 'admin_manual',
  });

  if (result.skipped === 'no_tracking') {
    return { skipped: true, reason: 'No inbound tracking number on file for this order.' };
  }

  if (result.skipped === 'no_data') {
    return { skipped: true, reason: 'Tracking API returned no inbound data for this order.' };
  }

  if (result.skipped === 'recently_refreshed') {
    return { skipped: true, reason: result.reason || 'Inbound tracking was refreshed recently.' };
  }

  return {
    message: 'Label tracking synchronized.',
    order: { id: result.order.id, status: result.order.status },
    tracking: result.tracking ? result.tracking : result.order.labelTrackingStatus,
    statusUpdate: result.statusUpdate || null,
  };
}

app.post('/orders/:id/sync-label-tracking', async (req, res) => {
  try {
    const payload = await refreshEmailLabelTrackingById(req.params.id, {
      source: 'admin_manual',
      force: Boolean(req.body?.force),
    });
    res.json(payload);
  } catch (error) {
    const message = error?.message || 'Failed to sync label tracking';
    const statusCode = error?.statusCode || 500;
    console.error('Error syncing label tracking:', error.response?.data || error);
    res.status(statusCode).json({ error: message });
  }
});

app.post("/orders/:id/re-offer", async (req, res) => {
  try {
    const { newPrice, reasons, comments, deviceKey } = req.body;
    const orderId = req.params.id;

    if (!newPrice || !reasons || !Array.isArray(reasons) || reasons.length === 0) {
      return res.status(400).json({ error: "New price and at least one reason are required" });
    }

    const orderRef = ordersCollection.doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = { id: orderDoc.id, ...orderDoc.data() };
    const resolvedDeviceKey = typeof deviceKey === 'string' && deviceKey.trim()
      ? deviceKey.trim()
      : buildOrderDeviceKey(orderId, 0);

    const nextOffer = {
      newPrice,
      reasons,
      comments,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      autoAcceptDate: admin.firestore.Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };

    // Compute new device statuses after this device is re-offered
    const nextDeviceStatusByKey = {
      ...(order.deviceStatusByKey || {}),
      [resolvedDeviceKey]: "re-offered-pending",
    };

    // Derive order status from all device statuses
    const derivedStatus = deriveOrderStatusFromDevices(order, nextDeviceStatusByKey);
    
    const updatePayload = {
      reOffer: nextOffer,
      [`deviceStatusByKey.${resolvedDeviceKey}`]: "re-offered-pending",
      [`reOfferByDevice.${resolvedDeviceKey}`]: nextOffer,
    };
    
    // Only update order-level status if derived status is available
    // Otherwise, maintain current order status (devices may still be in various states)
    if (derivedStatus) {
      updatePayload.status = derivedStatus;
    } else {
      // If not all devices are in terminal states, check if we should update to re-offered-pending
      // Only do so if this is a single-device order or all devices have been processed
      const deviceKeys = collectOrderDeviceKeys(order);
      if (deviceKeys.length === 1) {
        updatePayload.status = "re-offered-pending";
      }
      // For multi-device orders, keep the current status until all devices are processed
    }

    await updateOrderBoth(orderId, updatePayload);

    let reasonString = reasons.join(", ");
    if (comments) reasonString += `; ${comments}`;

    const safeReason = escapeHtml(reasonString).replace(/\n/g, "<br>");
    const originalQuoteValue = Number(order.estimatedQuote || order.originalQuote || 0).toFixed(2);
    const newOfferValue = Number(newPrice).toFixed(2);
    const customerName = order.shippingInfo.fullName || "there";
    const encodedDeviceKey = encodeURIComponent(resolvedDeviceKey);
    const reviewUrl = `https://secondhandcell.com/track-order.html?orderId=${orderId}&deviceKey=${encodedDeviceKey}&fromEmailLink=1&fromReofferLink=1&scrollToReoffer=1`;

    const customerEmailHtml = buildEmailLayout({
      title: "Updated offer available",
      accentColor: "#6366f1",
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
          <p style="margin-bottom:20px;">Review the updated offer and choose how you'd like to proceed:</p>
          <div style="text-align:center; margin-bottom:20px;">
            <a href="${reviewUrl}" class="button-link" style="background-color:#16a34a;">Review offer & choose</a>
          </div>
          <p>Questions or feedback? Reply to this email—we're here to help.</p>
      `,
    });

    await transporter.sendMail({
      from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
      to: order.shippingInfo.email,
      subject: `Re-offer for Order #${order.id}`,
      html: customerEmailHtml
    });

    await recordCustomerEmail(
      orderId,
      'Re-offer email sent to customer.',
      {
        newPrice: Number(newPrice).toFixed(2),
        originalQuote: Number(order.estimatedQuote || order.originalQuote || 0).toFixed(2),
        deviceKey: resolvedDeviceKey,
      }
    );

    res.json({ message: "Re-offer submitted successfully", newPrice, orderId: order.id, deviceKey: resolvedDeviceKey });
  } catch (err) {
    console.error("Error submitting re-offer:", err);
    res.status(500).json({ error: "Failed to submit re-offer" });
  }
});

app.post("/orders/:id/return-label", async (req, res) => {
  try {
    const doc = await ordersCollection.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Order not found" });
    const order = { id: doc.id, ...doc.data() };

    const buyerShippingInfo = order.shippingInfo;
    const orderIdForLabel = order.id || "N/A";

    const secondHandCellAddress = {
      name: "Second Hand Cell",
      company_name: "Second Hand Cell",
      phone: "3475591707",
      address_line1: "1602 MCDONALD AVE STE REAR ENTRANCE",
      city_locality: "Brooklyn",
      state_province: "NY",
      postal_code: "11230-6336",
      country_code: "US",
    };

    const buyerAddress = {
      name: buyerShippingInfo.fullName,
      phone: "3475591707",
      address_line1: buyerShippingInfo.streetAddress,
      city_locality: buyerShippingInfo.city,
      state_province: buyerShippingInfo.state,
      postal_code: buyerShippingInfo.zipCode,
      country_code: "US",
    };

    const isReturnToCustomer = order.status === "re-offered-declined";
    const shipFromAddress = isReturnToCustomer
      ? secondHandCellAddress
      : buyerAddress;
    const shipToAddress = isReturnToCustomer
      ? buyerAddress
      : secondHandCellAddress;

    const items = Array.isArray(order?.items) ? order.items : [];
    const itemsDeviceCount = items.reduce((sum, item) => sum + (Number(item?.qty) || 0), 0);
    const deviceCount = Math.max(1, itemsDeviceCount || Number(order?.qty) || 1);
    const shippingProfile = resolveUspsServiceAndWeightByDeviceCount(deviceCount);

    // Package data for the return label (phone inside kit)
    const returnPackageData = {
      service_code: shippingProfile.serviceCode,
      dimensions: { unit: "inch", height: 2, width: 4, length: 6 },
      weight: { value: shippingProfile.weightOz, unit: "ounce" },
    };

    console.log('[ShipEngine] label profile selected', {
      orderId: orderIdForLabel,
      deviceCount,
      chosenService: shippingProfile.chosenService,
      weightOz: shippingProfile.weightOz,
      blocks: shippingProfile.blocks,
      labelReference: `${orderIdForLabel}-RETURN`,
    });

    const returnLabelData = await createShipEngineLabel(
      shipFromAddress,
      shipToAddress,
      `${orderIdForLabel}-RETURN`,
      returnPackageData,
      {
        orderId: orderIdForLabel,
        deviceCount,
        chosenService: shippingProfile.chosenService,
        weightOz: shippingProfile.weightOz,
        blocks: shippingProfile.blocks,
      }
    );

    const returnTrackingNumber = returnLabelData.tracking_number;

    await updateOrderBoth(req.params.id, {
      status: "return-label-generated",
      returnLabelUrl: returnLabelData.label_download?.pdf,
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
        <a href="${returnLabelData.label_download?.pdf}">Download Return Label</a>
        <p>Thank you,</p>
        <p>The SecondHandCell Team</p>
      `,
    };

    await transporter.sendMail(customerMailOptions);

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
      message: "Return label generated successfully.",
      returnLabelUrl: returnLabelData.label_download?.pdf,
      returnTrackingNumber: returnTrackingNumber,
      orderId: order.id,
    });
  } catch (err) {
    console.error("Error generating return label:", err.response?.data || err);
    res.status(500).json({ error: "Failed to generate return label" });
  }
});

app.post("/orders/:id/auto-requote", async (req, res) => {
  return res.status(410).json({
    error: 'Manual auto-requote is disabled. Orders are finalized automatically after 7 days when unresolved.',
  });
});

app.post("/orders/:id/cancel", async (req, res) => {
  try {
    const orderId = req.params.id;
    const doc = await ordersCollection.doc(orderId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = { id: doc.id, ...doc.data() };
    const reason = req.body?.reason || "cancelled_by_admin";
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
    console.error("Error cancelling order:", error);
    const message = typeof error?.message === 'string' ? error.message : 'Failed to cancel order';
    const statusCode = message.includes('only available') ? 400 : 500;
    res.status(statusCode).json({ error: message });
  }
});

app.post("/accept-offer-action", async (req, res) => {
  try {
    const { orderId, deviceKey } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: "Order ID is required" });
    }
    const docRef = ordersCollection.doc(orderId);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    const orderData = { id: doc.id, ...doc.data() };
    const resolvedDeviceKey = typeof deviceKey === 'string' && deviceKey.trim()
      ? deviceKey.trim()
      : buildOrderDeviceKey(orderId, 0);
    const currentStatus = normalizeStatusValue(
      orderData.deviceStatusByKey?.[resolvedDeviceKey] || orderData.status
    );

    if (currentStatus !== 're_offered_pending') {
      return res
        .status(409)
        .json({ error: "This offer has already been accepted or declined." });
    }

    const nextDeviceStatusByKey = {
      ...(orderData.deviceStatusByKey || {}),
      [resolvedDeviceKey]: 're-offered-accepted',
    };
    const derivedStatus = deriveOrderStatusFromDevices(orderData, nextDeviceStatusByKey);
    const updatePayload = {
      [`deviceStatusByKey.${resolvedDeviceKey}`]: "re-offered-accepted",
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (derivedStatus) {
      updatePayload.status = derivedStatus;
    }

    await updateOrderBoth(orderId, updatePayload);

    const customerHtmlBody = `
      <p>Thank you for accepting the revised offer for Order <strong>#${orderData.id}</strong>.</p>
      <p>We've received your confirmation, and payment processing will now begin.</p>
    `;

    await transporter.sendMail({
      from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
      to: orderData.shippingInfo.email,
      subject: `Offer Accepted for Order #${orderData.id}`,
      html: customerHtmlBody
    });

    await recordCustomerEmail(
      orderId,
      'Re-offer acceptance confirmation email sent to customer.',
      { status: derivedStatus || req.body?.status || orderData.status, deviceKey: resolvedDeviceKey }
    );

    res.json({ message: "Offer accepted successfully.", orderId: orderData.id, deviceKey: resolvedDeviceKey });
  } catch (err) {
    console.error("Error accepting offer:", err);
    res.status(500).json({ error: "Failed to accept offer" });
  }
});

app.post("/return-phone-action", async (req, res) => {
  try {
    const { orderId, deviceKey } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: "Order ID is required" });
    }
    const docRef = ordersCollection.doc(orderId);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    const orderData = { id: doc.id, ...doc.data() };
    const resolvedDeviceKey = typeof deviceKey === 'string' && deviceKey.trim()
      ? deviceKey.trim()
      : buildOrderDeviceKey(orderId, 0);
    const currentStatus = normalizeStatusValue(
      orderData.deviceStatusByKey?.[resolvedDeviceKey] || orderData.status
    );

    if (currentStatus !== 're_offered_pending') {
      return res
        .status(409)
        .json({ error: "This offer has already been accepted or declined." });
    }

    const nextDeviceStatusByKey = {
      ...(orderData.deviceStatusByKey || {}),
      [resolvedDeviceKey]: 're-offered-declined',
    };
    const derivedStatus = deriveOrderStatusFromDevices(orderData, nextDeviceStatusByKey);
    const updatePayload = {
      [`deviceStatusByKey.${resolvedDeviceKey}`]: "re-offered-declined",
      declinedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (derivedStatus) {
      updatePayload.status = derivedStatus;
    }

    await updateOrderBoth(orderId, updatePayload);

    const customerHtmlBody = `
      <p>We have received your request to decline the revised offer and have your device returned. We are now processing your request and will send a return shipping label to your email shortly.</p>
    `;

    await transporter.sendMail({
      from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
      to: orderData.shippingInfo.email,
      subject: `Return Requested for Order #${orderData.id}`,
      html: customerHtmlBody
    });

    await recordCustomerEmail(
      orderId,
      'Return request confirmation email sent to customer.',
      { status: derivedStatus || req.body?.status || orderData.status, deviceKey: resolvedDeviceKey }
    );

    res.json({ message: "Return requested successfully.", orderId: orderData.id, deviceKey: resolvedDeviceKey });
  } catch (err) {
    console.error("Error requesting return:", err);
    res.status(500).json({ error: "Failed to request return" });
  }
});

app.delete("/orders/:id", async (req, res) => {
  try {
    const orderId = req.params.id;
    const orderRef = ordersCollection.doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ error: "Order not found." });
    }

    const orderData = orderDoc.data();
    const userId = orderData.userId;

    // Delete from the main collection
    await orderRef.delete();

    // If a userId is associated, delete from the user's subcollection as well
    if (userId) {
      const userOrderRef = usersCollection.doc(userId).collection("orders").doc(orderId);
      await userOrderRef.delete();
    }

    console.log(`[Order Action] Deleted order ${orderId} userId=${userId || 'none'}`);

    res.status(200).json({ message: `Order ${orderId} deleted successfully.` });
  } catch (err) {
    console.error("Error deleting order:", err);
    res.status(500).json({ error: "Failed to delete order." });
  }
});


async function runAutomaticLabelVoidSweep() {
  const shipengineKey = getShipEngineApiKey();
  if (!shipengineKey) {
    console.warn(
      "Skipping automatic label void sweep because ShipEngine API key is not configured."
    );
    return;
  }

  const primarySnapshot = await ordersCollection
    .where('status', '==', 'label_generated')
    .limit(AUTO_VOID_QUERY_LIMIT)
    .get();

  const docsToProcess = primarySnapshot.docs ? [...primarySnapshot.docs] : [];

  if (!docsToProcess.length) {
    return;
  }

  const processedIds = new Set();
  const autoVoidedSummary = [];

  for (const doc of docsToProcess) {
    if (processedIds.has(doc.id)) continue;
    processedIds.add(doc.id);
    const order = { id: doc.id, ...doc.data() };
    const orderStatus = normalizeStatusValue(order.status);
    if (orderStatus !== 'label_generated') {
      continue;
    }
    if (order.returnAutoVoidedAt || order.autoLabelVoidProcessedAt) {
      continue;
    }
    const labels = normalizeShipEngineLabelMap(order);
    const selections = [];

    for (const [key, entry] of Object.entries(labels)) {
      if (!entry || !entry.id) continue;
      if (!isLabelPendingVoid(entry)) continue;

      const generatedDate =
        toDate(entry.generatedAt || entry.createdAt) ||
        toDate(order.labelGeneratedAt || order.kitLabelGeneratedAt || order.createdAt);
      if (!generatedDate) continue;

      const ageMs = Date.now() - generatedDate.getTime();
      if (ageMs < AUTO_VOID_DELAY_MS) continue;

      const lastAttempt =
        toDate(entry.autoVoidAttemptedAt || entry.lastVoidAttemptAt) || null;
      if (lastAttempt) {
        const sinceLastAttempt = Date.now() - lastAttempt.getTime();
        if (sinceLastAttempt < AUTO_VOID_RETRY_DELAY_MS) {
          continue;
        }
      }

      selections.push({ key, id: entry.id });
    }

    if (!selections.length) {
      continue;
    }

    try {
      const { results } = await handleLabelVoid(order, selections, {
        reason: "automatic",
        shipengineKey,
      });
      const approvedResults = Array.isArray(results)
        ? results.filter((entry) => entry && entry.approved)
        : [];

      if (approvedResults.length) {
        await updateOrderBoth(order.id, {
          status: 'cancelled',
          autoCancelled: true,
          cancelReason: 'label_voided_no_response_28_days',
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          returnAutoVoidedAt: admin.firestore.FieldValue.serverTimestamp(),
          autoLabelVoidProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {
          logEntries: [
            {
              type: 'cancellation',
              message: 'Order cancelled automatically after label remained unused for 28 days.',
              metadata: {
                labelsVoided: approvedResults.map((entry) => entry.labelId),
              },
            },
          ],
        });

        autoVoidedSummary.push({
          orderId: order.id,
          labelIds: approvedResults.map((entry) => entry.labelId).filter(Boolean),
        });
      }

      // Silently void label - no customer email sent
      // Status automatically set to "canceled" by handleLabelVoid
    } catch (error) {
      console.error(
        `Automatic label void failed for order ${order.id}:`,
        error
      );
    }
  }

  if (autoVoidedSummary.length) {
    try {
      const recipient = getLabelVoidNotificationEmail();
      if (!recipient) {
        console.warn('Automatic void summary email skipped: no recipient configured.');
        return;
      }

      const textLines = autoVoidedSummary.map((entry) => {
        const labelText = entry.labelIds.length ? entry.labelIds.join(', ') : 'N/A';
        return `• Order #${entry.orderId} | Voided labels: ${labelText}`;
      });

      const textBody = [
        'Automatic 28-day label void sweep completed.',
        '',
        `Orders voided: ${autoVoidedSummary.length}`,
        ...textLines,
      ].join('\n');

      const htmlBody = buildEmailLayout({
        title: 'Automatic label void summary',
        accentColor: '#0ea5e9',
        includeTrustpilot: false,
        bodyHtml: `
          <p>Automatic 28-day label void sweep completed.</p>
          <p><strong>Orders voided:</strong> ${autoVoidedSummary.length}</p>
          <ul style="padding-left:22px; color:#475569;">
            ${autoVoidedSummary
              .map((entry) => {
                const labelText = entry.labelIds.length ? entry.labelIds.join(', ') : 'N/A';
                return `<li><strong>Order #${escapeHtml(entry.orderId)}</strong> — Voided labels: ${escapeHtml(labelText)}</li>`;
              })
              .join('')}
          </ul>
        `,
      });

      await transporter.sendMail({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to: recipient,
        subject: `Auto-void summary: ${autoVoidedSummary.length} order${autoVoidedSummary.length === 1 ? '' : 's'} updated`,
        text: textBody,
        html: htmlBody,
      });
    } catch (summaryError) {
      console.error('Failed to send automatic void summary email:', summaryError);
    }
  }
}

async function collectTestOrderCandidates(maxCandidates = ADMIN_BULK_VOID_QUERY_LIMIT) {
  const candidates = [];
  let lastDoc = null;
  const pageSize = 200;

  while (candidates.length < maxCandidates) {
    let query = ordersCollection
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(pageSize);

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      break;
    }

    for (const doc of snapshot.docs) {
      lastDoc = doc;
      const order = { id: doc.id, ...doc.data() };
      if (isTestOrderMatch(order)) {
        candidates.push(order);
        if (candidates.length >= maxCandidates) {
          break;
        }
      }
    }

    if (snapshot.size < pageSize) {
      break;
    }
  }

  return candidates;
}

async function runAdminBulkVoidJob({
  mode = 'aged',
  minDays = ADMIN_BULK_VOID_MIN_DAYS_DEFAULT,
  maxOrders = ADMIN_BULK_VOID_MAX_PER_RUN,
} = {}) {
  const shipengineKey = getShipEngineApiKey();
  if (!shipengineKey) {
    throw new Error("ShipEngine API key not configured. Please set 'shipengine.key' or SHIPENGINE_KEY.");
  }

  const cancelledEntries = [];
  const skippedEntries = [];
  const failedEntries = [];
  const normalizedMaxOrders = Math.max(1, Number(maxOrders || ADMIN_BULK_VOID_MAX_PER_RUN));

  let candidates = [];

  if (mode === 'test') {
    candidates = await collectTestOrderCandidates(ADMIN_BULK_VOID_QUERY_LIMIT);
  } else {
    const agedSnapshot = await ordersCollection
      .where('status', '==', 'label_generated')
      .limit(ADMIN_BULK_VOID_QUERY_LIMIT)
      .get();
    candidates = agedSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  const totalCandidates = candidates.length;
  candidates = candidates.slice(0, normalizedMaxOrders);
  const hasMore = totalCandidates > candidates.length;

  for (const order of candidates) {
    try {
      const ageDays = getOrderAgeInDays(order);

      if (mode !== 'test') {
        if (ageDays === null || ageDays < Number(minDays || ADMIN_BULK_VOID_MIN_DAYS_DEFAULT)) {
          skippedEntries.push({ orderId: order.id, reason: 'below_age_threshold' });
          continue;
        }
      }

      if (isAlreadyProcessedForBulkVoid(order)) {
        skippedEntries.push({ orderId: order.id, reason: 'already_cancelled' });
        continue;
      }

      const selections = getPendingVoidSelections(order);
      let approvedResults = [];

      if (selections.length) {
        const { results } = await handleLabelVoid(order, selections, {
          reason: 'automatic',
          shipengineKey,
        });

        approvedResults = Array.isArray(results)
          ? results.filter((entry) => entry && entry.approved)
          : [];
      }

      const hasVoidedLabels = approvedResults.length > 0 || hasAnyVoidedLabel(order);
      if (!hasVoidedLabels) {
        skippedEntries.push({ orderId: order.id, reason: selections.length ? 'no_labels_approved_for_void' : 'no_labels_to_void_or_cancel' });
        continue;
      }

      const voidedLabelIds = approvedResults.length
        ? approvedResults.map((entry) => entry.labelId).filter(Boolean)
        : getVoidedLabelIds(order);

      const timestampField = admin.firestore.FieldValue.serverTimestamp();
      const updatePayload = {
        status: 'canceled',
        autoCancelled: true,
        cancelReason: mode === 'test' ? 'admin_bulk_void_test_order' : 'admin_bulk_void_27_days',
        cancelledAt: timestampField,
        adminBulkVoidProcessedAt: timestampField,
        autoLabelVoidProcessedAt: timestampField,
      };

      if (mode === 'test') {
        updatePayload.testOrderAutoVoidProcessedAt = timestampField;
      }

      await updateOrderBoth(order.id, updatePayload, {
        logEntries: [
          {
            type: 'cancellation',
            message:
              mode === 'test'
                ? 'Order cancelled by admin bulk test-order void action.'
                : `Order cancelled by admin bulk aged-label void action (${Number(minDays)}+ days).`,
            metadata: {
              labelsVoided: voidedLabelIds,
              ageDays,
              mode,
            },
          },
        ],
      });

      cancelledEntries.push({
        orderId: order.id,
        ageDays,
        labelIds: voidedLabelIds,
      });
    } catch (error) {
      failedEntries.push({ orderId: order.id, reason: error?.message || 'unknown_error' });
    }
  }

  const title = mode === 'test'
    ? 'Admin test-order bulk void completed'
    : `Admin ${Number(minDays)}+ day bulk void completed`;
  const subject = mode === 'test'
    ? `Admin test-order void summary: ${cancelledEntries.length} cancelled`
    : `Admin bulk void summary (${Number(minDays)}+ days): ${cancelledEntries.length} cancelled`;

  try {
    await sendBulkVoidSummaryEmail({
      title,
      subject,
      reason: mode === 'test' ? 'test_order_cleanup' : `${Number(minDays)}_day_threshold`,
      cancelledEntries,
      skippedEntries,
      failedEntries,
    });
  } catch (error) {
    console.error('[Bulk Void] Unexpected summary email error:', error?.message || error);
  }

  return {
    mode,
    minDays: Number(minDays || ADMIN_BULK_VOID_MIN_DAYS_DEFAULT),
    maxOrders: normalizedMaxOrders,
    totalCandidates,
    hasMore,
    scanned: candidates.length,
    cancelled: cancelledEntries.length,
    skipped: skippedEntries.length,
    failed: failedEntries.length,
    cancelledEntries,
    skippedEntries: skippedEntries.slice(0, 25),
    failedEntries: failedEntries.slice(0, 25),
  };
}

app.post('/orders/admin/bulk-void-aged', async (req, res) => {
  try {
    const parsedMinDays = Number(req.body?.minDays);
    const minDays = Number.isFinite(parsedMinDays) && parsedMinDays >= 0
      ? parsedMinDays
      : ADMIN_BULK_VOID_MIN_DAYS_DEFAULT;
    const parsedLimit = Number(req.body?.limit);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? parsedLimit
      : ADMIN_BULK_VOID_MAX_PER_RUN;

    const payload = await runAdminBulkVoidJob({ mode: 'aged', minDays, maxOrders: limit });
    res.json(payload);
  } catch (error) {
    console.error('Admin bulk aged void failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to run admin bulk aged void.' });
  }
});

app.post('/orders/admin/bulk-void-test-orders', async (req, res) => {
  try {
    const parsedLimit = Number(req.body?.limit);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? parsedLimit
      : ADMIN_BULK_VOID_MAX_PER_RUN;

    const payload = await runAdminBulkVoidJob({ mode: 'test', maxOrders: limit });
    res.json(payload);
  } catch (error) {
    console.error('Admin bulk test-order void failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to run admin bulk test-order void.' });
  }
});

async function runAutomaticReducedPayoutSweep() {
  const nowMs = Date.now();
  const eligibleSnapshot = await ordersCollection
    .where('status', '==', 'emailed')
    .limit(AUTO_REDUCED_PAYOUT_QUERY_LIMIT)
    .get();

  for (const doc of eligibleSnapshot.docs) {
    const order = { id: doc.id, ...doc.data() };
    if (!order.qcAwaitingResponse) continue;
    if (order.autoRequote?.automatic === true || order.autoRequote?.manual === true) continue;

    const status = String(order.status || '').toLowerCase();
    if (MANUAL_AUTO_REQUOTE_INELIGIBLE_STATUSES.has(status)) continue;

    const lastEmailMs = getLastCustomerEmailMillis(order);
    if (!Number.isFinite(lastEmailMs)) continue;
    if (nowMs - lastEmailMs < AUTO_REDUCED_PAYOUT_DELAY_MS) continue;

    const baseAmount = Number(order.reOffer?.newPrice ?? getOrderPayout(order));
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) continue;

    const reducedAmount = Number((baseAmount * 0.25).toFixed(2));
    if (!Number.isFinite(reducedAmount) || reducedAmount <= 0) continue;

    const customerName = order.shippingInfo?.fullName || 'there';
    const customerEmail = order.shippingInfo?.email;
    const baseDisplay = baseAmount.toFixed(2);
    const reducedDisplay = reducedAmount.toFixed(2);
    const timestampField = admin.firestore.FieldValue.serverTimestamp();

    try {
      await updateOrderBoth(order.id, {
        status: 'completed',
        finalPayoutAmount: reducedAmount,
        finalOfferAmount: reducedAmount,
        finalPayout: reducedAmount,
        requoteAcceptedAt: timestampField,
        qcAwaitingResponse: false,
        autoRequote: {
          reducedFrom: Number(baseDisplay),
          reducedTo: reducedAmount,
          manual: false,
          automatic: true,
          initiatedBy: 'system_auto_requote_7_day_unresolved',
          completedAt: timestampField,
          lastCustomerEmailAt: admin.firestore.Timestamp.fromMillis(lastEmailMs),
        },
      }, {
        logEntries: [
          {
            type: 'auto_requote',
            message: `Order auto-finalized at $${reducedDisplay} after unresolved customer communication for 7 days.`,
            metadata: {
              previousStatus: order.status || null,
              reducedFrom: Number(baseDisplay),
              reducedTo: reducedAmount,
              reductionPercent: 75,
              automatic: true,
            },
          },
        ],
      });

      if (customerEmail) {
        const emailHtml = buildEmailLayout({
          title: 'Order finalized at adjusted payout',
          accentColor: '#dc2626',
          includeTrustpilot: false,
          bodyHtml: `
            <p>Hi ${escapeHtml(customerName)},</p>
            <p>Since we did not receive a response within 7 days, we finalized order <strong>#${escapeHtml(order.id)}</strong> at a payout that is 75% less than the previous quote of $${baseDisplay}, per our terms.</p>
            <p>Your payout amount is <strong>$${reducedDisplay}</strong>. If you have any questions, reply to this email and we can review with you.</p>
          `,
        });

        await transporter.sendMail({
          from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
          to: customerEmail,
          subject: `Order #${order.id} finalized at adjusted payout`,
          html: emailHtml,
        });

        await recordCustomerEmail(
          order.id,
          'Automatic 7-day unresolved issue payout finalization email sent to customer.',
          {
            status: 'completed',
            reducedFrom: baseDisplay,
            reducedTo: reducedDisplay,
            automatic: true,
          },
          { logType: 'auto_requote_email' }
        );
      }
    } catch (error) {
      console.error(`Failed automatic reduced payout finalization for order ${order.id}:`, error);
    }
  }
}



async function runAutomaticInboundTrackingRefresh() {
  if (automaticInboundTrackingRefreshInProgress) {
    console.log('Automatic inbound tracking refresh is already running; skipping overlap run.');
    return;
  }

  automaticInboundTrackingRefreshInProgress = true;

  try {
  const snapshot = await ordersCollection
    .where('status', 'in', ['label_generated', PHONE_TRANSIT_STATUS, 'phone_on_the_way_to_us'])
    .limit(AUTO_TRACKING_REFRESH_QUERY_LIMIT)
    .get();

  for (const doc of snapshot.docs) {
    const order = { id: doc.id, ...doc.data() };

    if (!shouldTrackInbound(order)) {
      continue;
    }

    try {
      await syncInboundTrackingForOrder(order, { source: 'system_automatic' });
    } catch (error) {
      console.error(`Automatic inbound tracking refresh failed for order ${order.id}:`, error.response?.data || error);
    }
  }
  } finally {
    automaticInboundTrackingRefreshInProgress = false;
  }
}

exports.generateSimulatedOrders = functions.pubsub
  .schedule('every 15 minutes')
  .timeZone('Etc/UTC')
  .onRun(async () => {
    try {
      const result = await seedFakeOrdersForDay(new Date());
      if (result.created) {
        console.log(`Simulated ${result.created} fake orders for ${result.dayKey}`);
      }
    } catch (error) {
      console.error('Failed to inject simulated orders:', error);
    }
    return null;
  });

exports.autoVoidExpiredLabels = functions.pubsub
  .schedule("every 60 minutes")
  .onRun(async () => {
    try {
      await runAutomaticLabelVoidSweep();
    } catch (error) {
      console.error("Automatic label void sweep failed:", error);
    }
    return null;
  });



exports.autoRefreshInboundTracking = functions.pubsub
  .schedule('every 60 minutes')
  .onRun(async () => {
    try {
      await runAutomaticInboundTrackingRefresh();
    } catch (error) {
      console.error('Automatic inbound tracking refresh sweep failed:', error);
    }
    return null;
  });

exports.autoFinalizeUnresolvedPayouts = functions.pubsub
  .schedule('every 60 minutes')
  .onRun(async () => {
    try {
      await runAutomaticReducedPayoutSweep();
    } catch (error) {
      console.error('Automatic unresolved payout finalization sweep failed:', error);
    }
    return null;
  });

exports.autoAcceptOffers = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async (context) => {
    const now = admin.firestore.Timestamp.now();
    const pendingOrders = await ordersCollection
      .where("status", "==", "re-offered-pending")
      .get();

    const updates = pendingOrders.docs.map(async (doc) => {
      const orderData = { id: doc.id, ...doc.data() };
      const byDeviceOffers = orderData.reOfferByDevice || {};
      const nextDeviceStatusByKey = { ...(orderData.deviceStatusByKey || {}) };
      const expiredDeviceKeys = [];

      for (const [deviceKey, offer] of Object.entries(byDeviceOffers)) {
        const deadline = offer?.autoAcceptDate;
        const isPending = normalizeStatusValue(nextDeviceStatusByKey[deviceKey] || orderData.status) === 're_offered_pending';
        const deadlineMillis = deadline && typeof deadline.toMillis === 'function' ? deadline.toMillis() : null;

        if (isPending && Number.isFinite(deadlineMillis) && deadlineMillis <= now.toMillis()) {
          expiredDeviceKeys.push(deviceKey);
        }
      }

      if (!expiredDeviceKeys.length) {
        const fallbackDeadline = orderData.reOffer?.autoAcceptDate;
        const fallbackMillis = fallbackDeadline && typeof fallbackDeadline.toMillis === 'function'
          ? fallbackDeadline.toMillis()
          : null;
        const fallbackKey = buildOrderDeviceKey(orderData.id, 0);
        const fallbackPending = normalizeStatusValue(nextDeviceStatusByKey[fallbackKey] || orderData.status) === 're_offered_pending';

        if (fallbackPending && Number.isFinite(fallbackMillis) && fallbackMillis <= now.toMillis()) {
          expiredDeviceKeys.push(fallbackKey);
        }
      }

      if (!expiredDeviceKeys.length) {
        return;
      }

      for (const key of expiredDeviceKeys) {
        nextDeviceStatusByKey[key] = 're-offered-auto-accepted';
      }

      const derivedStatus = deriveOrderStatusFromDevices(orderData, nextDeviceStatusByKey);
      const updatePayload = {
        acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
        deviceStatusByKey: nextDeviceStatusByKey,
      };
      if (derivedStatus) {
        updatePayload.status = derivedStatus;
      }

      const acceptedPrices = expiredDeviceKeys
        .map((key) => byDeviceOffers?.[key]?.newPrice)
        .filter((value) => Number.isFinite(Number(value)))
        .map((value) => Number(value).toFixed(2));
      const fallbackPrice = Number(orderData?.reOffer?.newPrice);
      const priceText = acceptedPrices.length
        ? acceptedPrices.map((price) => `$${price}`).join(', ')
        : (Number.isFinite(fallbackPrice) ? `$${fallbackPrice.toFixed(2)}` : 'the revised amount');

      const customerHtmlBody = `
        <p>Hello ${orderData.shippingInfo.fullName},</p>
        <p>As we have not heard back from you regarding your revised offer, it has been automatically accepted as per our terms and conditions.</p>
        <p>Payment processing for ${expiredDeviceKeys.length > 1 ? 'the revised amounts' : 'the revised amount'} of <strong>${priceText}</strong> will now begin.</p>
        <p>Thank you,</p>
        <p>The SecondHandCell Team</p>
      `;

      await transporter.sendMail({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to: orderData.shippingInfo.email,
        subject: `Revised Offer Auto-Accepted for Order #${orderData.id}`,
        html: customerHtmlBody,
      });

      await updateOrderBoth(doc.id, updatePayload);

      await recordCustomerEmail(
        doc.id,
        'Re-offer auto-accept email sent to customer.',
        {
          status: derivedStatus || orderData.status,
          auto: true,
          deviceCount: expiredDeviceKeys.length,
          deviceKeys: expiredDeviceKeys.join(', '),
          prices: priceText,
        }
      );
    });

    await Promise.all(updates);
    console.log(`Auto-accepted device offers on ${updates.length} pending orders.`);
    return null;
  });

async function runAutoCancellationSweep() {
  if (!AUTO_CANCELLATION_ENABLED) {
    console.log('Auto cancellation sweep skipped: feature disabled.');
    return;
  }

  const thresholdTimestamp = admin.firestore.Timestamp.fromMillis(
    Date.now() - AUTO_CANCEL_DELAY_MS
  );

  const snapshot = await ordersCollection
    .where("status", "in", AUTO_CANCEL_MONITORED_STATUSES)
    .where("lastStatusUpdateAt", "<=", thresholdTimestamp)
    .get();

  for (const doc of snapshot.docs) {
    const order = { id: doc.id, ...doc.data() };
    try {
      await cancelOrderAndNotify(order, {
        auto: true,
        reason: "no_activity_15_days",
      });
    } catch (error) {
      console.error(
        `Failed to auto-cancel dormant order ${order.id}:`,
        error
      );
    }
  }
}

exports.autoCancelDormantOrders = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async () => {
    try {
      await runAutoCancellationSweep();
    } catch (error) {
      console.error("Automatic cancellation sweep failed:", error);
    }
    return null;
  });

// This function creates a user document in the 'users' collection, but NOT in the 'admins' collection.
exports.createUserRecord = functions.auth.user().onCreate(async (user) => {
  try {
    // Do not create a user record if the user is anonymous (no email)
    if (!user.email) {
      console.log(`Anonymous user created: ${user.uid}. Skipping Firestore record creation.`);
      return null;
    }

    console.log(`New user created: ${user.uid}`);
    const userData = {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName || null,
      phoneNumber: user.phoneNumber || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      // NOTE: No 'isAdmin' field is set here. User accounts are only written to the usersCollection.
    };

    await usersCollection.doc(user.uid).set(userData);
    console.log(`User data for ${user.uid} saved to Firestore (users collection).`);
  } catch (error) {
    console.error("Error saving user data to Firestore:", error);
  }
});

async function runAutomaticLabelReminderSweep() {
  const snapshot = await ordersCollection
    .where("status", "in", Array.from(LABEL_REMINDER_STATUSES))
    .get();

  const now = Date.now();
  let sentCount = 0;

  for (const doc of snapshot.docs) {
    const order = { id: doc.id, ...doc.data() };
    const labelStart =
      getTimestampMillis(order.labelGeneratedAt) ||
      getTimestampMillis(order.lastStatusUpdateAt) ||
      getTimestampMillis(order.createdAt);

    if (!labelStart) {
      continue;
    }

    const ageMs = now - labelStart;
    const lastEmailAt = getLastCustomerEmailMillis(order);
    if (lastEmailAt && now - lastEmailAt < LABEL_REMINDER_MIN_GAP_MS) {
      continue;
    }

    let targetTier = null;
    if (ageMs >= LABEL_REMINDER_SECOND_DELAY_MS && !order.labelReminderSecondSentAt) {
      targetTier = order.labelReminderFirstSentAt ? 2 : 1;
    } else if (ageMs >= LABEL_REMINDER_FIRST_DELAY_MS && !order.labelReminderFirstSentAt) {
      targetTier = 1;
    }

    if (!targetTier) {
      continue;
    }

    try {
      const sent = await sendLabelReminderEmail(order, { tier: targetTier });
      if (sent) {
        sentCount += 1;
      }
    } catch (error) {
      console.error(`Failed to send label reminder for order ${order.id}:`, error);
    }
  }

  console.log(`Automatic label reminder sweep sent ${sentCount} reminders.`);
}

exports.autoSendLabelReminderEmails = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async () => {
    try {
      await runAutomaticLabelReminderSweep();
    } catch (error) {
      console.error("Automatic label reminder sweep failed:", error);
    }
    return null;
  });

// Send Reminder Email for label_generated orders
exports.sendReminderEmail = functions.https.onCall(async (data, context) => {
  let authContext = null;
  try {
    authContext = getCallableAuth(context);

    // 1. Verify user is authenticated
    if (!authContext) {
      throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    }

    // 2. Verify user is an admin by checking admins collection
    if (!isAuthDisabled()) {
      const adminDoc = await adminsCollection.doc(authContext.uid).get();
      if (!adminDoc.exists) {
        console.warn(`Unauthorized reminder email attempt by user: ${authContext.uid}`);
        throw new functions.https.HttpsError('permission-denied', 'Only admins can send reminder emails');
      }
    }

    const { orderId } = data;
    
    // 3. Validate orderId is provided
    if (!orderId) {
      throw new functions.https.HttpsError('invalid-argument', 'Order ID is required');
    }

    // 4. Validate orderId format (prevent injection attacks)
    if (typeof orderId !== 'string' || orderId.trim().length === 0) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid order ID format');
    }

    const sanitizedOrderId = orderId.trim();

    // 5. Get order and verify it exists
    const orderDoc = await ordersCollection.doc(sanitizedOrderId).get();
    
    if (!orderDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Order not found');
    }

    const order = orderDoc.data();
    
    // 6. Verify order status is label_generated/emailed
    if (!['label_generated', 'emailed'].includes(order.status)) {
      throw new functions.https.HttpsError('failed-precondition', 'Can only send reminders for orders with generated labels');
    }

    const { subject, html } = buildLabelReminderEmail(
      sanitizedOrderId,
      { ...order, id: sanitizedOrderId }
    );

    // 7. Send the email
    await transporter.sendMail({
      from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
      to: order.shippingInfo?.email,
      subject,
      html,
    });


    await recordCustomerEmail(
      sanitizedOrderId,
      'Reminder email sent to customer.',
      { status: order.status },
      {
        logType: 'reminder',
        additionalUpdates: {
          lastReminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      }
    );

    // 8. Log admin action for audit trail
    const auditLog = {
      action: 'send_reminder_email',
      adminUid: authContext.uid,
      adminEmail: authContext.token?.email || 'unknown',
      orderId: sanitizedOrderId,
      orderStatus: order.status,
      recipientEmail: order.shippingInfo?.email,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      success: true
    };
    
    await db.collection('adminAuditLogs').add(auditLog);
    
    console.log(`[AUDIT] Admin ${authContext.uid} sent reminder email for order ${sanitizedOrderId} to ${order.shippingInfo?.email}`);
    
    return { 
      success: true, 
      message: 'Reminder email sent successfully' 
    };
  } catch (error) {
    console.error('Error sending reminder email:', error);
    
    // Log failed attempts for security monitoring
    if (authContext) {
      try {
        await db.collection('adminAuditLogs').add({
          action: 'send_reminder_email',
          adminUid: authContext.uid,
          adminEmail: authContext.token?.email || 'unknown',
          orderId: data?.orderId || 'unknown',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          success: false,
          errorType: error.code || 'unknown',
          errorMessage: error.message || 'Unknown error'
        });
      } catch (logError) {
        console.error('Failed to log audit entry:', logError);
      }
    }
    
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    
    throw new functions.https.HttpsError('internal', 'Failed to send reminder email');
  }
});

exports.sendExpiringReminderEmail = functions.https.onCall(async (data, context) => {
  let authContext = null;
  try {
    authContext = getCallableAuth(context);
    if (!authContext) {
      throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    }

    if (!isAuthDisabled()) {
      const adminDoc = await adminsCollection.doc(authContext.uid).get();
      if (!adminDoc.exists) {
        throw new functions.https.HttpsError('permission-denied', 'Only admins can send reminder emails');
      }
    }

    const { orderId } = data || {};
    if (!orderId || typeof orderId !== 'string' || !orderId.trim()) {
      throw new functions.https.HttpsError('invalid-argument', 'Order ID is required');
    }

    const sanitizedOrderId = orderId.trim();
    const orderSnap = await ordersCollection.doc(sanitizedOrderId).get();
    if (!orderSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Order not found');
    }

    const order = orderSnap.data();
    if (!EXPIRING_REMINDER_ALLOWED_STATUSES.has(order.status)) {
      throw new functions.https.HttpsError('failed-precondition', 'Order status is not eligible for an expiration reminder');
    }

    const customerEmail = order.shippingInfo?.email;
    if (!customerEmail) {
      throw new functions.https.HttpsError('failed-precondition', 'Order is missing a customer email address');
    }

    let createdAtDate = null;
    const createdAt = order.createdAt;
    if (createdAt) {
      if (typeof createdAt.toDate === 'function') {
        createdAtDate = createdAt.toDate();
      } else if (typeof createdAt.seconds === 'number') {
        createdAtDate = new Date(createdAt.seconds * 1000);
      } else if (typeof createdAt._seconds === 'number') {
        createdAtDate = new Date(createdAt._seconds * 1000);
      } else {
        const fallbackDate = new Date(createdAt);
        createdAtDate = Number.isNaN(fallbackDate.getTime()) ? null : fallbackDate;
      }
    }

    let expiryDateText = null;
    let daysRemainingText = null;
    if (createdAtDate instanceof Date && !Number.isNaN(createdAtDate.getTime())) {
      const expiryDate = new Date(createdAtDate.getTime() + AUTO_CANCEL_DELAY_MS);
      expiryDateText = expiryDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const millisLeft = expiryDate.getTime() - Date.now();
      const daysLeft = Math.ceil(millisLeft / (24 * 60 * 60 * 1000));
      if (Number.isFinite(daysLeft)) {
        if (daysLeft <= 0) {
          daysRemainingText = 'less than a day';
        } else if (daysLeft === 1) {
          daysRemainingText = '1 day';
        } else {
          daysRemainingText = `${daysLeft} days`;
        }
      }
    }

    const payoutAmount = getOrderPayout(order);
    const payoutDisplay = formatCurrencyValue(payoutAmount);
    const deviceSummary = buildDeviceSummary(order) || [order.device, order.storage, order.carrier]
      .filter(Boolean)
      .join(' • ') || 'your device';

    const checklistItems = [
      'Back up your data to keep your memories safe.',
      'Sign out of iCloud, Google, and any other accounts.',
      'Factory reset the device to remove personal information.',
      'Remove SIM or memory cards and accessories.',
      'Pack the device securely and place the packing slip inside.',
    ];

    const emailHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Don't Miss Out On Your Trade-In</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; margin: 0; padding: 0; }
    .wrapper { max-width: 620px; margin: 0 auto; padding: 32px 16px; }
    .card { background: #ffffff; border-radius: 18px; box-shadow: 0 22px 60px rgba(15, 23, 42, 0.12); overflow: hidden; }
    .card-header { background: linear-gradient(135deg, #2563eb, #38bdf8); color: #fff; padding: 36px 32px; text-align: center; }
    .card-header h1 { margin: 0; font-size: 28px; }
    .card-body { padding: 32px; color: #1f2937; }
    .pill { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px; background: rgba(37, 99, 235, 0.12); color: #1d4ed8; font-weight: 600; }
    .details-box { margin: 24px 0; padding: 20px; border-radius: 14px; background: rgba(15, 118, 110, 0.08); border: 1px solid rgba(13, 148, 136, 0.22); }
    .details-box strong { display: block; margin-bottom: 6px; color: #0f172a; }
    .checklist { margin: 0; padding-left: 18px; }
    .checklist li { margin-bottom: 10px; }
    .cta { margin-top: 28px; text-align: center; }
    .cta a { display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff; border-radius: 999px; text-decoration: none; font-weight: 600; }
    .footer { padding: 24px; text-align: center; color: #64748b; font-size: 13px; background: #f1f5f9; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="card-header">
        <div style="font-size:48px; margin-bottom:12px;">⏳</div>
        <h1>Your quote is almost up</h1>
        <p>Let's finish your trade-in so you don't lose your offer.</p>
      </div>
      <div class="card-body">
        <p>Hello ${order.shippingInfo?.fullName || 'there'},</p>
        <p>We noticed you started a trade-in for <strong>${deviceSummary}</strong> but it isn't complete yet. We’re holding your quote of <strong>${payoutDisplay}</strong>${expiryDateText ? ` until <strong>${expiryDateText}</strong>` : ''}.${daysRemainingText ? ` That’s about ${daysRemainingText} left.` : ''}</p>

        <div class="details-box">
          <strong>Order #${sanitizedOrderId}</strong>
          <div>Quoted amount: <strong>${payoutDisplay}</strong></div>
          <div>Shipping preference: ${order.shippingPreference || 'Shipping Kit Requested'}</div>
          ${expiryDateText ? `<div>Offer expires: ${expiryDateText}</div>` : ''}
        </div>

        <p class="pill">🚀 Shipping soon keeps your payout locked in</p>

        <p>Here’s a quick checklist to help you get ready:</p>
        <ol class="checklist">
          ${checklistItems.map((item) => `<li>${item}</li>`).join('')}
        </ol>

        <div class="cta">
          <a href="mailto:support@secondhandcell.com?subject=Question about order ${sanitizedOrderId}">Need help? We’re here.</a>
        </div>

        <p style="margin-top:28px;">Once your device arrives, we typically inspect and pay out within 48 hours.</p>
        <p style="margin-top:12px;">Thanks for choosing SecondHandCell!</p>
      </div>
      <div class="footer">
        SecondHandCell • Making device trade-ins simple and rewarding<br>
        Order #${sanitizedOrderId}
      </div>
    </div>
  </div>
</body>
</html>`;

    await transporter.sendMail({
      from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
      to: customerEmail,
      subject: '⏳ Your SecondHandCell Quote Is Almost Expired',
      html: emailHtml,
    });

    await recordCustomerEmail(
      sanitizedOrderId,
      'Expiration reminder email sent to customer.',
      {
        status: order.status,
        expiresOn: expiryDateText || null,
        daysRemaining: daysRemainingText || null,
      },
      {
        logType: 'expiring_reminder',
        additionalUpdates: {
          expiringReminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      }
    );

    await db.collection('adminAuditLogs').add({
      action: 'send_expiring_reminder_email',
      adminUid: authContext.uid,
      adminEmail: authContext.token?.email || 'unknown',
      orderId: sanitizedOrderId,
      orderStatus: order.status,
      recipientEmail: customerEmail,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      success: true,
    });

    return { success: true, message: 'Expiration reminder email sent successfully' };
  } catch (error) {
    console.error('Error sending expiring reminder email:', error);

    if (authContext) {
      try {
        await db.collection('adminAuditLogs').add({
          action: 'send_expiring_reminder_email',
          adminUid: authContext.uid,
          adminEmail: authContext.token?.email || 'unknown',
          orderId: data?.orderId || 'unknown',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          success: false,
          errorType: error.code || 'unknown',
          errorMessage: error.message || 'Unknown error',
        });
      } catch (logError) {
        console.error('Failed to log expiring reminder audit entry:', logError);
      }
    }

    if (error instanceof functions.https.HttpsError) {
      throw error;
    }

    throw new functions.https.HttpsError('internal', 'Failed to send expiration reminder email');
  }
});

exports.sendKitReminderEmail = functions.https.onCall(async (data, context) => {
  let authContext = null;
  try {
    authContext = getCallableAuth(context);
    if (!authContext) {
      throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    }

    if (!isAuthDisabled()) {
      const adminDoc = await adminsCollection.doc(authContext.uid).get();
      if (!adminDoc.exists) {
        throw new functions.https.HttpsError('permission-denied', 'Only admins can send reminder emails');
      }
    }

    const { orderId } = data || {};
    if (!orderId || typeof orderId !== 'string' || !orderId.trim()) {
      throw new functions.https.HttpsError('invalid-argument', 'Order ID is required');
    }

    const sanitizedOrderId = orderId.trim();
    const orderSnap = await ordersCollection.doc(sanitizedOrderId).get();
    if (!orderSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Order not found');
    }

    const order = orderSnap.data();
    if (!KIT_REMINDER_ALLOWED_STATUSES.has(order.status)) {
      throw new functions.https.HttpsError('failed-precondition', 'Order status is not eligible for a kit reminder');
    }

    const shippingPreference = (order.shippingPreference || '').toString().toLowerCase();
    if (shippingPreference !== 'shipping kit requested') {
      throw new functions.https.HttpsError('failed-precondition', 'Kit reminders are only available for Shipping Kit Requested orders');
    }

    const customerEmail = order.shippingInfo?.email;
    if (!customerEmail) {
      throw new functions.https.HttpsError('failed-precondition', 'Order is missing a customer email address');
    }

    const outboundTracking = order.outboundTrackingNumber;
    const inboundTracking = order.inboundTrackingNumber || order.trackingNumber;
    const deviceSummary = buildDeviceSummary(order) || [order.device, order.storage].filter(Boolean).join(' • ') || 'your device';
    const payoutAmount = getOrderPayout(order);

    const emailHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your SecondHandCell Kit Is Ready</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; margin: 0; padding: 0; }
    .wrapper { max-width: 620px; margin: 0 auto; padding: 32px 16px; }
    .card { background: #ffffff; border-radius: 18px; box-shadow: 0 20px 55px rgba(15, 23, 42, 0.12); overflow: hidden; }
    .header { background: linear-gradient(135deg, #10b981, #14b8a6); color: #fff; padding: 34px 30px; text-align: center; }
    .header h1 { margin: 0; font-size: 26px; }
    .body { padding: 30px; color: #1f2937; }
    .highlight { margin: 18px 0; padding: 18px; border-radius: 14px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.25); }
    .tracking { margin-top: 18px; padding: 18px; background: rgba(4, 120, 87, 0.08); border-radius: 12px; border: 1px solid rgba(4, 120, 87, 0.25); font-family: 'Fira Code', 'Consolas', monospace; }
    .tracking a { color: #047857; text-decoration: none; }
    .steps { margin: 0; padding-left: 20px; }
    .steps li { margin-bottom: 10px; }
    .footer { padding: 22px; text-align: center; font-size: 13px; color: #64748b; background: #f1f5f9; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="header">
        <div style="font-size:46px; margin-bottom:10px;">📦</div>
        <h1>Your kit is on the way!</h1>
        <p>Let’s get your ${deviceSummary} shipped so we can finish your payout.</p>
      </div>
      <div class="body">
        <p>Hi ${order.shippingInfo?.fullName || 'there'},</p>
        <p>Your SecondHandCell shipping kit is ready and waiting for your device. Once it arrives, complete these quick steps so your payout isn’t delayed.</p>

        <div class="highlight">
          <strong>Order #${sanitizedOrderId}</strong><br />
          ${payoutAmount ? `Quoted amount: <strong>${formatCurrencyValue(payoutAmount)}</strong><br />` : ''}
          Shipping preference: <strong>${order.shippingPreference || 'Shipping Kit Requested'}</strong>
        </div>

        ${outboundTracking ? `<div class="tracking">Outbound kit tracking: <a href="https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${outboundTracking}" target="_blank" rel="noopener">${outboundTracking}</a></div>` : ''}
        ${inboundTracking ? `<div class="tracking" style="margin-top:12px;">Return label tracking: <a href="https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${inboundTracking}" target="_blank" rel="noopener">${inboundTracking}</a></div>` : ''}

        <p style="margin-top:24px;">Before you drop the kit in the mail, make sure to:</p>
        <ol class="steps">
          <li>Remove SIM and memory cards.</li>
          <li>Factory reset the device and log out of all accounts.</li>
          <li>Place the device in the protective packaging we sent.</li>
          <li>Attach the return label and drop it with USPS.</li>
        </ol>

        <p style="margin-top:20px;">Once we receive the device, we’ll inspect it and send payment within 48 hours. Have any questions? Just reply to this email—our team is ready to help.</p>
      </div>
      <div class="footer">
        SecondHandCell • Support: <a href="mailto:support@secondhandcell.com">support@secondhandcell.com</a><br />
        Order #${sanitizedOrderId}
      </div>
    </div>
  </div>
</body>
</html>`;

    await transporter.sendMail({
      from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
      to: customerEmail,
      subject: '📦 Friendly reminder: Ship your SecondHandCell kit',
      html: emailHtml,
    });

    await recordCustomerEmail(
      sanitizedOrderId,
      'Kit reminder email sent to customer.',
      {
        status: order.status,
        outboundTracking: outboundTracking || null,
        inboundTracking: inboundTracking || null,
      },
      {
        logType: 'kit_reminder',
        additionalUpdates: {
          kitReminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      }
    );

    await db.collection('adminAuditLogs').add({
      action: 'send_kit_reminder_email',
      adminUid: authContext.uid,
      adminEmail: authContext.token?.email || 'unknown',
      orderId: sanitizedOrderId,
      orderStatus: order.status,
      recipientEmail: customerEmail,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      success: true,
    });

    return { success: true, message: 'Kit reminder email sent successfully' };
  } catch (error) {
    console.error('Error sending kit reminder email:', error);

    if (authContext) {
      try {
        await db.collection('adminAuditLogs').add({
          action: 'send_kit_reminder_email',
          adminUid: authContext.uid,
          adminEmail: authContext.token?.email || 'unknown',
          orderId: data?.orderId || 'unknown',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          success: false,
          errorType: error.code || 'unknown',
          errorMessage: error.message || 'Unknown error',
        });
      } catch (logError) {
        console.error('Failed to log kit reminder audit entry:', logError);
      }
    }

    if (error instanceof functions.https.HttpsError) {
      throw error;
    }

    throw new functions.https.HttpsError('internal', 'Failed to send kit reminder email');
  }
});

exports.onChatTransferUpdate = functions.firestore
  .document("chats/{chatId}")
  .onUpdate(async (change, context) => {
    // Removed all chat transfer notification logic
    return null;
  });

// FCM Push Notifications for New Chat Messages
exports.onNewChatOpened = functions.firestore
  .document("chats/{chatId}/messages/{messageId}")
  .onCreate(async (snap, context) => {
    const newMessage = snap.data();
    const chatId = context.params.chatId;

    // Only process user messages
    if (newMessage.senderType !== "user") {
      return null;
    }

    const chatDocRef = db.collection("chats").doc(chatId);
    const chatDoc = await chatDocRef.get();
    const chatData = chatDoc.data();
    
    const userIdentifier = chatData.ownerUid || chatData.guestId || "Unknown User";
    const relatedUserId = chatData.ownerUid;
    const assignedAdminUid = chatData.assignedAdminUid;
    
    // Truncate message to 100 characters for notification
    const messageText = newMessage.text || "";
    const truncatedMessage = messageText.length > 100 
      ? messageText.substring(0, 100) + "..." 
      : messageText;

    // Update chat metadata
    await chatDocRef.set({
      lastMessageSender: newMessage.sender,
      lastMessageSeenByAdmin: false,
    }, { merge: true });

    // Notification data payload with all required fields for client
    const notificationData = {
      chatId: chatId,
      message: truncatedMessage,
      userIdentifier: userIdentifier,
      userId: relatedUserId || "guest",
      relatedDocType: "chat",
      relatedDocId: chatId,
      relatedUserId: relatedUserId || "guest",
      timestamp: Date.now().toString(),
    };

    // Determine routing: assigned admin vs all admins
    if (assignedAdminUid) {
      // Chat is assigned - send to specific admin only
      const adminTokenSnapshot = await db.collection(`admins/${assignedAdminUid}/fcmTokens`).get();
      const adminTokenEntries = adminTokenSnapshot.docs.map((doc) => {
        const d = doc.data() || {};
        const token = d.token || doc.id;
        return { token, ref: doc.ref };
      }).filter((entry) => entry.token && typeof entry.token === 'string');
      const adminTokens = adminTokenEntries.map((entry) => entry.token);
      
      if (adminTokens.length > 0) {
        await sendPushNotification(
          adminTokens,
          "💬 New Chat Message",
          `Message from ${userIdentifier}: "${truncatedMessage}"`,
          notificationData,
          { tokenRefs: adminTokenEntries.map((entry) => entry.ref) }
        ).catch((e) => console.error("FCM Send Error (Assigned Chat):", e));
      }
      
      // Add Firestore Notification for the assigned admin
      await addAdminFirestoreNotification(
        assignedAdminUid,
        `New message from ${userIdentifier}: "${truncatedMessage}"`,
        "chat",
        chatId,
        relatedUserId
      ).catch((e) => console.error("Firestore Notification Error:", e));
      
      console.log(`New message in assigned chat ${chatId}. Notification sent to admin ${assignedAdminUid}.`);
    } else {
      // Chat is unassigned - send to ALL admins
      const fcmPromise = sendAdminPushNotification(
        "💬 New Chat Message",
        `Message from ${userIdentifier}: "${truncatedMessage}"`,
        notificationData
      ).catch((e) => console.error("FCM Send Error (Unassigned Chat):", e));

      // Add Firestore Notifications for each admin
      const firestoreNotificationPromises = [];
      const adminsSnapshot = await adminsCollection.get();
      adminsSnapshot.docs.forEach((adminDoc) => {
        firestoreNotificationPromises.push(
          addAdminFirestoreNotification(
            adminDoc.id,
            `New message from ${userIdentifier}: "${truncatedMessage}"`,
            "chat",
            chatId,
            relatedUserId
          ).catch((e) => console.error("Firestore Notification Error:", e))
        );
      });

      await Promise.all([fcmPromise, ...firestoreNotificationPromises]);
      
      console.log(`New message in unassigned chat ${chatId}. Notifications sent to all admins.`);
    }

    return null;
  });

// NEW FUNCTION: Triggers on new chat document creation to send email notification.
exports.onNewChatCreated = functions.firestore
  .document("chats/{chatId}")
  .onCreate(async (snap, context) => {
    const chatId = context.params.chatId;
    const chatData = snap.data();
    
    const userIdentifier = chatData.ownerUid || chatData.guestId || "Unknown User";
    
    // Create email notification for admin
    const adminEmailHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #6366F1 0%, #22D3EE 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .content { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; background: #6366F1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 16px; }
            .info { background: white; padding: 16px; border-radius: 6px; margin: 16px 0; border-left: 4px solid #6366F1; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>💬 New Chat Started</h2>
            </div>
            <div class="content">
              <p>A new customer chat has been initiated on SecondHandCell.</p>
              <div class="info">
                <strong>Chat ID:</strong> ${chatId}<br>
                <strong>User:</strong> ${userIdentifier}<br>
                <strong>Time:</strong> ${new Date().toLocaleString()}
              </div>
              <p>Please respond to this chat as soon as possible to provide excellent customer service.</p>
              <a href="https://secondhandcell.com/admin/chat" class="button">View Chat in Admin Panel</a>
            </div>
          </div>
        </body>
      </html>
    `;
    
    try {
      await transporter.sendMail({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to: 'sales@secondhandcell.com',
        subject: `New Chat Started - ${userIdentifier}`,
        html: adminEmailHtml,
        bcc: ["saulsetton16@gmail.com"]
      });
      
      console.log(`Email notification sent for new chat ${chatId} from ${userIdentifier}`);
    } catch (error) {
      console.error("Error sending email notification for new chat:", error);
    }
    
    return null;
  });

exports.onSupportTicketCreated = functions.firestore
  .document("support_tickets/{ticketId}")
  .onCreate(async (snap, context) => {
    const ticketId = context.params.ticketId;
    const data = snap.data() || {};
    const timestamp = data.createdAt?.toDate?.() || new Date();
    const generatedNumber = `T-${Date.now().toString(36).toUpperCase()}`;
    const ticketNumber = data.ticketNumber || generatedNumber;

    if (!data.ticketNumber) {
      await supportTicketsCollection.doc(ticketId).set({
        ticketNumber,
      }, { merge: true });
    }

    const adminEmailHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a; background: #f8fafc; }
            .container { max-width: 640px; margin: 0 auto; padding: 20px; }
            .card { background: #ffffff; border-radius: 14px; box-shadow: 0 25px 60px -40px rgba(15,23,42,0.25); padding: 20px; border: 1px solid #e2e8f0; }
            .pill { display: inline-block; padding: 6px 12px; border-radius: 9999px; font-weight: 700; font-size: 13px; color: #0f172a; background: #e0f2fe; border: 1px solid #bae6fd; }
            .section { margin-top: 16px; }
            .section h3 { margin: 0 0 8px; font-size: 15px; color: #0f172a; }
            .section p { margin: 0 0 6px; color: #334155; }
            .meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
            .meta { background: #f8fafc; border-radius: 10px; padding: 10px 12px; border: 1px solid #e2e8f0; }
            .meta strong { display: block; font-size: 13px; color: #1e293b; }
            .meta span { color: #334155; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <div>
                  <p style="margin:0; font-weight:700; color:#0f172a;">New support ticket</p>
                  <p style="margin:2px 0 0; color:#475569;">Submitted ${timestamp.toLocaleString()}</p>
                </div>
                <span class="pill">${ticketNumber}</span>
              </div>

              <div class="section meta-grid">
                <div class="meta">
                  <strong>Customer</strong>
                  <span>${data.customerName || "N/A"}</span>
                </div>
                <div class="meta">
                  <strong>Email</strong>
                  <span>${data.email || "N/A"}</span>
                </div>
                <div class="meta">
                  <strong>Phone</strong>
                  <span>${data.phone || "Not provided"}</span>
                </div>
                <div class="meta">
                  <strong>Prefers phone</strong>
                  <span>${data.prefersPhone ? "Yes" : "No"}</span>
                </div>
                <div class="meta">
                  <strong>Order</strong>
                  <span>${data.orderLabel || data.orderId || "Not linked"}</span>
                </div>
                <div class="meta">
                  <strong>User ID</strong>
                  <span>${data.userId || "Guest"}</span>
                </div>
              </div>

              <div class="section">
                <h3>Subject</h3>
                <p>${data.subject || "No subject provided"}</p>
              </div>
              <div class="section">
                <h3>Message</h3>
                <p>${(data.message || "No message provided").replace(/\n/g, '<br>')}</p>
              </div>
              <div class="section meta">
                <strong>Consent</strong>
                <span>${data.dataConsent ? "Customer acknowledged message & data rates." : "No consent captured"}</span>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;

    try {
      await transporter.sendMail({
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to: 'sales@secondhandcell.com',
        subject: `New Support Ticket ${ticketNumber}`,
        html: adminEmailHtml,
      });
    } catch (error) {
      console.error('Error sending support ticket email:', error);
    }

    return null;
  });

app.delete("/orders/:id", async (req, res) => {
  try {
    const orderId = req.params.id;
    const orderRef = ordersCollection.doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ error: "Order not found." });
    }

    const orderData = orderDoc.data();
    const userId = orderData.userId;

    // Delete from the main collection
    await orderRef.delete();

    // If a userId is associated, delete from the user's subcollection as well
    if (userId) {
      const userOrderRef = usersCollection.doc(userId).collection("orders").doc(orderId);
      await userOrderRef.delete();
    }

    res.status(200).json({ message: `Order ${orderId} deleted successfully.` });
  } catch (err) {
    console.error("Error deleting order:", err);
    res.status(500).json({ error: "Failed to delete order." });
  }
});

function getWholesaleNotificationInbox() {
  if (process.env.WHOLESALE_NOTIFICATIONS_TO) {
    return process.env.WHOLESALE_NOTIFICATIONS_TO;
  }
  if (process.env.INFO_EMAIL) {
    return process.env.INFO_EMAIL;
  }
  try {
    if (
      functions.config().notifications &&
      functions.config().notifications.wholesale_to
    ) {
      return functions.config().notifications.wholesale_to;
    }
  } catch (error) {
    console.warn(
      "Unable to read notifications.wholesale_to config:",
      error.message
    );
  }
  return "info@secondhandcell.com";
}

function getWholesaleFromAddress() {
  if (process.env.EMAIL_USER) {
    return process.env.EMAIL_USER;
  }
  try {
    if (functions.config().email && functions.config().email.user) {
      return functions.config().email.user;
    }
  } catch (error) {
    console.warn("Unable to read email.user config:", error.message);
  }
  return "info@secondhandcell.com";
}

function formatUsd(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "$0.00";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

function escapeHtml(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildWholesaleItemsTable(items, { priceOverrides } = {}) {
  const list = Array.isArray(items) ? items : [];
  const overrides = priceOverrides && typeof priceOverrides === "object" ? priceOverrides : {};

  if (!list.length) {
    return "<p style=\"margin:16px 0;\">No line items were provided.</p>";
  }

  let units = 0;
  let total = 0;

  const rows = list
    .map((item) => {
      const quantity = Number(item.quantity) || 0;
      const overrideKey = item.lineId || item.lineID || item.line_id;
      const overridePrice =
        overrideKey !== undefined && overrideKey !== null
          ? overrides[overrideKey]
          : undefined;
      const price = Number(
        overridePrice ??
          item.acceptedPrice ??
          item.counterPrice ??
          item.offerPrice ??
          0
      );
      const lineTotal = quantity * price;
      units += quantity;
      total += lineTotal;

      const deviceParts = [item.brand, item.model, item.storage, item.grade]
        .filter(Boolean)
        .map((part) => String(part));
      const label =
        item.device ||
        item.title ||
        deviceParts.join(" • ") ||
        "Wholesale device";

      const safeLabel = escapeHtml(label);

      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${safeLabel}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${quantity}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;">${formatUsd(price)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;">${formatUsd(lineTotal)}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div style="margin:20px 0;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <table style="width:100%;border-collapse:collapse;">
        <thead style="background:#f8fafc;">
          <tr>
            <th style="text-align:left;padding:10px 12px;font-size:13px;color:#475569;text-transform:uppercase;letter-spacing:0.06em;">Item</th>
            <th style="text-align:center;padding:10px 12px;font-size:13px;color:#475569;text-transform:uppercase;letter-spacing:0.06em;">Qty</th>
            <th style="text-align:right;padding:10px 12px;font-size:13px;color:#475569;text-transform:uppercase;letter-spacing:0.06em;">Unit Price</th>
            <th style="text-align:right;padding:10px 12px;font-size:13px;color:#475569;text-transform:uppercase;letter-spacing:0.06em;">Line Total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td style="padding:12px;font-weight:600;color:#0f172a;">Totals</td>
            <td style="padding:12px;text-align:center;font-weight:600;color:#0f172a;">${units}</td>
            <td></td>
            <td style="padding:12px;text-align:right;font-weight:600;color:#0f172a;">${formatUsd(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

function buildWholesaleEmailTemplate({
  title,
  intro,
  items,
  priceOverrides,
  note,
  cta,
  footer,
}) {
  const itemsTable = buildWholesaleItemsTable(items, { priceOverrides });
  const safeNote = escapeHtml(note).replace(/\n/g, "<br />");
  const noteBlock = note
    ? `
        <div style="margin:16px 0;padding:16px;border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;">
          <p style="margin:0;font-size:14px;color:#0f172a;font-weight:600;">Notes</p>
          <p style="margin:8px 0 0;font-size:14px;color:#334155;">${safeNote}</p>
        </div>
      `
    : "";
  const ctaButton = cta && cta.url && cta.label
    ? `
        <div style="margin:24px 0;">
          <a href="${cta.url}" style="display:inline-block;padding:14px 28px;border-radius:999px;background:#10b981;color:#ffffff;font-weight:600;text-decoration:none;">${cta.label}</a>
        </div>
      `
    : "";
  const footerBlock = footer
    ? `<p style=\"margin-top:24px;font-size:12px;color:#94a3b8;\">${escapeHtml(footer)}</p>`
    : "";

  const bodyHtml = `
      <div style="font-size:16px; line-height:1.7; color:#334155;">${intro}</div>
      ${noteBlock}
      ${itemsTable}
      ${ctaButton}
      ${footerBlock}
  `;

  return buildEmailLayout({
    title,
    accentColor: "#0ea5e9",
    bodyHtml,
  });
}

async function sendWholesaleEmail({ to, subject, html, text }) {
  if (!to) {
    console.warn("Wholesale notification skipped due to missing recipient.", {
      subject,
    });
    return;
  }

  const mailOptions = {
    from: getWholesaleFromAddress(),
    to,
    subject,
    html,
  };

  if (text) {
    mailOptions.text = text;
  }

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error("Failed to send wholesale notification email:", error);
  }
}

exports.notifyWholesaleOfferCreated = functions.firestore
  .document("wholesale/{userId}/offers/{offerDocId}")
  .onCreate(async (snap, context) => {
    const offer = snap.data() || {};
    const offerId = offer.id || context.params.offerDocId;
    const buyer = offer.buyer || {};
    const buyerName = buyer.name || buyer.company || buyer.email || "Wholesale buyer";
    const buyerEmail = buyer.email || "Unknown";
    const internalRecipient = getWholesaleNotificationInbox();
    const safeOfferId = escapeHtml(offerId);
    const safeBuyerName = escapeHtml(buyerName);
    const safeBuyerEmail = escapeHtml(buyerEmail);

    const intro = `
      <p style="margin:0 0 12px;">A new wholesale offer has been submitted.</p>
      <p style="margin:0;">Buyer: <strong>${safeBuyerName}</strong> (${safeBuyerEmail})</p>
      <p style="margin:12px 0 0;">Offer ID: <strong>${safeOfferId}</strong></p>
    `;

    const html = buildWholesaleEmailTemplate({
      title: "New wholesale offer received",
      intro,
      items: offer.items,
      priceOverrides: null,
      note: offer.note,
      cta: {
        label: "Review in admin",
        url: "https://secondhandcell.com/buy/admin.html#offers",
      },
      footer: "This notification was generated automatically when the buyer submitted their cart.",
    });

    const text = `New wholesale offer ${offerId} from ${buyerName} (${buyerEmail}).`;

    await sendWholesaleEmail({
      to: internalRecipient,
      subject: `New wholesale offer ${offerId} submitted`,
      html,
      text,
    });

    return null;
  });

exports.notifyWholesaleOfferUpdated = functions.firestore
  .document("wholesale/{userId}/offers/{offerDocId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const offerId = after.id || before.id || context.params.offerDocId;
    const buyer = after.buyer || before.buyer || {};
    const buyerName = buyer.name || buyer.company || buyer.email || "Wholesale buyer";
    const buyerEmail = buyer.email || null;
    const statusBefore = before.status || "pending";
    const statusAfter = after.status || "pending";
    const notifications = [];
    const displayBuyerEmail = buyerEmail || "Not provided";
    const safeOfferId = escapeHtml(offerId);
    const safeBuyerName = escapeHtml(buyerName);

    const counterBefore = (before.counter && before.counter.items) || {};
    const counterAfter = (after.counter && after.counter.items) || {};
    const noteBefore = (before.counter && before.counter.note) || "";
    const noteAfter = (after.counter && after.counter.note) || "";
    const counterChanged =
      statusAfter === "counter" &&
      (statusBefore !== "counter" ||
        JSON.stringify(counterBefore) !== JSON.stringify(counterAfter) ||
        noteBefore !== noteAfter);

    if (counterChanged && buyerEmail) {
      const intro = `
        <p style="margin:0 0 12px;">We reviewed your wholesale request and provided updated pricing.</p>
        <p style="margin:0;">Offer ID: <strong>${safeOfferId}</strong></p>
      `;
      const html = buildWholesaleEmailTemplate({
        title: "We've provided a counter offer",
        intro,
        items: after.items,
        priceOverrides: counterAfter,
        note: noteAfter,
        cta: {
          label: "Review counter in My Account",
          url: "https://secondhandcell.com/buy/my-account.html#pending",
        },
        footer: "Sign in to your wholesale portal to accept or decline this counter.",
      });
      const text = `A counter offer is ready for ${offerId}. Review it in your wholesale portal.`;
      notifications.push(
        sendWholesaleEmail({
          to: buyerEmail,
          subject: `Counter offer ready for ${offerId}`,
          html,
          text,
        })
      );
    }

    if (statusBefore !== statusAfter && statusAfter === "accepted" && buyerEmail) {
      const intro = `
        <p style="margin:0 0 12px;">Great news! Your wholesale offer is ready to check out.</p>
        <p style="margin:0;">Offer ID: <strong>${safeOfferId}</strong></p>
      `;
      const html = buildWholesaleEmailTemplate({
        title: "Your offer has been approved",
        intro,
        items: after.items,
        priceOverrides: counterAfter,
        note: "Checkout is ready whenever you are.",
        cta: {
          label: "Proceed to checkout",
          url: `https://secondhandcell.com/buy/checkout.html?offer=${encodeURIComponent(offerId)}`,
        },
        footer: "Payment is due within 24 hours to keep inventory reserved.",
      });
      const text = `Offer ${offerId} has been accepted. Complete checkout at https://secondhandcell.com/buy/checkout.html?offer=${offerId}`;
      notifications.push(
        sendWholesaleEmail({
          to: buyerEmail,
          subject: `Offer ${offerId} approved – complete checkout` ,
          html,
          text,
        })
      );
    }

    if (statusBefore !== statusAfter && statusAfter === "declined" && buyerEmail) {
      const intro = `
        <p style="margin:0 0 12px;">We wanted to let you know that this wholesale offer has been declined.</p>
        <p style="margin:0;">Offer ID: <strong>${safeOfferId}</strong></p>
      `;
      const html = buildWholesaleEmailTemplate({
        title: "Update on your wholesale offer",
        intro,
        items: after.items,
        priceOverrides: null,
        note: noteAfter,
        cta: {
          label: "View details in My Account",
          url: "https://secondhandcell.com/buy/my-account.html#history",
        },
        footer: "Reach out to your account manager if you'd like to revisit this submission.",
      });
      const text = `Offer ${offerId} was declined. Sign in to review details.`;
      notifications.push(
        sendWholesaleEmail({
          to: buyerEmail,
          subject: `Offer ${offerId} was declined`,
          html,
          text,
        })
      );
    }

    if (statusBefore !== statusAfter && statusAfter === "processing") {
      const orderId = after.payment && after.payment.orderId;
      const totalAmount = after.payment && after.payment.totalAmount;
      const intro = `
        <p style="margin:0 0 12px;">${safeBuyerName} started checkout for their wholesale offer.</p>
        <p style="margin:0;">Offer ID: <strong>${safeOfferId}</strong></p>
        <p style="margin:12px 0 0;">Expected charge: <strong>${formatUsd(totalAmount)}</strong></p>
        ${
          orderId
            ? `<p style="margin:12px 0 0;">Wholesale order ID: <strong>${escapeHtml(orderId)}</strong></p>`
            : ""
        }
      `;
      const html = buildWholesaleEmailTemplate({
        title: "Wholesale checkout started",
        intro,
        items: after.items,
        priceOverrides: counterAfter,
        note: noteAfter,
        cta: {
          label: "Open admin dashboard",
          url: "https://secondhandcell.com/buy/admin.html#offers",
        },
        footer: `Buyer: ${buyerName} (${displayBuyerEmail || "No email on file"})`,
      });
      const text = `Buyer ${buyerName} started checkout for ${offerId}.`;
      notifications.push(
        sendWholesaleEmail({
          to: getWholesaleNotificationInbox(),
          subject: `Checkout started for wholesale offer ${offerId}`,
          html,
          text,
        })
      );
    }

    if (statusBefore !== statusAfter && statusAfter === "completed") {
      const orderId = after.payment && after.payment.orderId;
      const totalAmount = after.payment && after.payment.totalAmount;
      const paymentIntentId =
        after.payment && (after.payment.paymentIntentId || after.payment.intentId);
      const intro = `
        <p style="margin:0 0 12px;">Payment for this wholesale offer has been confirmed.</p>
        <p style="margin:0;">Offer ID: <strong>${safeOfferId}</strong></p>
        ${
          orderId
            ? `<p style="margin:12px 0 0;">Wholesale order ID: <strong>${escapeHtml(orderId)}</strong></p>`
            : ""
        }
        ${
          totalAmount
            ? `<p style="margin:12px 0 0;">Total collected: <strong>${formatUsd(totalAmount)}</strong></p>`
            : ""
        }
        ${
          paymentIntentId
            ? `<p style="margin:12px 0 0;">Stripe PI: <strong>${escapeHtml(paymentIntentId)}</strong></p>`
            : ""
        }
      `;
      const html = buildWholesaleEmailTemplate({
        title: "Wholesale payment received",
        intro,
        items: after.items,
        priceOverrides: counterAfter,
        note: noteAfter,
        cta: {
          label: "View order in admin",
          url: "https://secondhandcell.com/buy/admin.html#offers",
        },
        footer: `Buyer: ${buyerName} (${displayBuyerEmail || "No email on file"})`,
      });
      const text = `Wholesale offer ${offerId} is paid. Total: ${formatUsd(totalAmount)}.`;
      notifications.push(
        sendWholesaleEmail({
          to: getWholesaleNotificationInbox(),
          subject: `Wholesale offer ${offerId} payment received`,
          html,
          text,
        })
      );
    }

    if (!notifications.length) {
      return null;
    }

    await Promise.all(notifications);
    return null;
  });

exports.api = functions.https.onRequest(app);
exports.expressApp = app;
exports.updateOrderBoth = updateOrderBoth;
exports.buildOrderDeviceKey = buildOrderDeviceKey;
exports.collectOrderDeviceKeys = collectOrderDeviceKeys;
exports.deriveOrderStatusFromDevices = deriveOrderStatusFromDevices;

exports.refreshTracking = functions.runWith({ timeoutSeconds: 540, memory: '1GB' }).https.onRequest(
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    const { orderId, type, force } = req.body || {};
    if (!orderId || !type) {
      return res.status(400).json({ error: 'orderId and type are required.' });
    }

    const normalizedType = String(type).toLowerCase();
    const handler = normalizedType === 'kit'
      ? refreshKitTrackingById
      : normalizedType === 'email'
        ? refreshEmailLabelTrackingById
        : null;

    if (!handler) {
      return res.status(400).json({ error: 'Invalid tracking type requested.' });
    }

    try {
      const payload = await handler(orderId, {
        source: 'admin_manual',
        force: Boolean(force),
      });
      res.json({ type: normalizedType, ...payload });
    } catch (error) {
      const statusCode = error?.statusCode || 500;
      const message = error?.message || 'Failed to refresh tracking';
      console.error('refreshTracking function error:', { orderId, type: normalizedType, error });
      res.status(statusCode).json({ error: message });
    }
  }
);
