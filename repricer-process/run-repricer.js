#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const { execSync } = require("child_process");

// ---------------- CONFIG ----------------
const SELLCELL_URL = "http://feed.sellcell.com/secondhandcell/feed.xml";
const SELLCELL_USERNAME = "secondhandcell";
const SELLCELL_PASSWORD = "4t#cfo6$eK2N";
const DOWNLOADED_FEED_PATH = path.join(__dirname, "sellcell-feed-debug.xml");

// CLI args
const args = process.argv.slice(2);
const getArg = (name, def = null) => {
  const idx = args.findIndex(a => a === `--${name}`);
  if (idx === -1) return def;
  const v = args[idx + 1];
  if (!v || v.startsWith("--")) return true; // flag
  return v;
};

const cwd = path.resolve(getArg("dir", "/shc33/feed")); // default to /shc33/feed
const CSV_PATH = path.join(cwd, "amz.csv");
const TEMPLATE_XML_PATH = path.join(cwd, "feed.xml");

// repricer tuning
const CLI_BUMP_VALUE = Number.parseFloat(getArg("bump", ""));
const HAS_CLI_BUMP_OVERRIDE = Number.isFinite(CLI_BUMP_VALUE);

const DEFAULT_REPRICER_RULES = {
  targetProfitPct: 0.15,
  tiers: [
    { minProfitPct: 0.75, bumpAmount: 5 },
    { minProfitPct: 0.45, bumpAmount: 3 },
    { minProfitPct: 0.15, bumpAmount: 1 },
  ],
};

// optional outputs
const WRITE_OUTPUT_CSV = !!getArg("write-csv", false);
const OUTPUT_CSV_PATH = path.join(cwd, "repricer-output.csv");

// gca auto-run
const RUN_GCA = !getArg("no-gca", false);

// optional: use explicit project id (otherwise uses service account / default creds)
const FIREBASE_PROJECT_ID = getArg("project-id", null);

function normalizeRepricerRules(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const targetCandidate = Number(source.targetProfitPct);
  const targetProfitPct =
    Number.isFinite(targetCandidate) && targetCandidate > 0 && targetCandidate < 1
      ? targetCandidate
      : DEFAULT_REPRICER_RULES.targetProfitPct;

  const sourceTiers = Array.isArray(source.tiers) ? source.tiers : [];
  const tiers = sourceTiers
    .map((tier) => {
      if (!tier || typeof tier !== "object") return null;
      const minProfitPct = Number(tier.minProfitPct);
      const bumpAmount = Number(tier.bumpAmount);
      if (!Number.isFinite(minProfitPct) || !Number.isFinite(bumpAmount)) return null;
      if (minProfitPct <= 0 || minProfitPct >= 1 || bumpAmount < 0) return null;
      return {
        minProfitPct: Math.round(minProfitPct * 10000) / 10000,
        bumpAmount: Math.round(bumpAmount * 100) / 100,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.minProfitPct - a.minProfitPct);

  if (!tiers.length) {
    return {
      targetProfitPct: DEFAULT_REPRICER_RULES.targetProfitPct,
      tiers: DEFAULT_REPRICER_RULES.tiers.map((tier) => ({ ...tier })),
    };
  }

  return {
    targetProfitPct,
    tiers,
  };
}

function getBumpForProfitPct(profitPct, rules) {
  const value = Number(profitPct);
  if (!Number.isFinite(value)) return 0;
  for (const tier of rules.tiers) {
    if (value >= tier.minProfitPct) return tier.bumpAmount;
  }
  return 0;
}

function roundRepricerPrice(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return amount;
  const dollars = Math.floor(amount);
  const cents = Math.round((amount - dollars) * 100);
  if (cents < 50) return dollars;
  if (cents === 50) return dollars + 0.5;
  return dollars + 1;
}

function getFirestoreDb() {
  const admin = require("firebase-admin");
  if (admin.apps.length === 0) {
    const opts = {};
    if (FIREBASE_PROJECT_ID) opts.projectId = FIREBASE_PROJECT_ID;
    admin.initializeApp(opts);
  }
  return admin.firestore();
}

async function loadRepricerRules() {
  const useDefaultViaFlag = getArg("default-rules", false);
  if (HAS_CLI_BUMP_OVERRIDE) {
    return {
      targetProfitPct: DEFAULT_REPRICER_RULES.targetProfitPct,
      tiers: [
        {
          minProfitPct: DEFAULT_REPRICER_RULES.targetProfitPct,
          bumpAmount: Math.round(CLI_BUMP_VALUE * 100) / 100,
        },
      ],
    };
  }
  if (useDefaultViaFlag) {
    return normalizeRepricerRules(null);
  }

  try {
    const db = getFirestoreDb();
    const snap = await db.collection("config").doc("repricerRules").get();
    return normalizeRepricerRules(snap.exists ? snap.data() : null);
  } catch (error) {
    console.warn(`[repricer] failed to load Firestore rules, using defaults: ${error?.message || error}`);
    return normalizeRepricerRules(null);
  }
}

// ---------------- HELPERS ----------------

// ===================== NAME NORMALIZATION + ALIASES =====================
const MODEL_ALIASES = {
  "IPHONE 16 SE": "IPHONE SE 3RD GEN (2022)",
  "IPHONE 16E": "IPHONE SE 3RD GEN (2022)",
  "IPHONE SE 3": "IPHONE SE 3RD GEN (2022)",
  "IPHONE SE 2022": "IPHONE SE 3RD GEN (2022)",
  "IPHONE SE 3RD GEN": "IPHONE SE 3RD GEN (2022)",

  "GALAXY S21+": "GALAXY S21 PLUS",
  "GALAXY S22+": "GALAXY S22 PLUS",
  "GALAXY S23+": "GALAXY S23 PLUS",
  "GALAXY S24+": "GALAXY S24 PLUS",
  "GALAXY S25+": "GALAXY S25 PLUS",

  "GALAXY S23FE": "GALAXY S23 FE",
  "GALAXY S24FE": "GALAXY S24 FE",
  "GALAXY S25FE": "GALAXY S25 FE",

  "SAMSUNG GALAXY S23FE": "GALAXY S23 FE",
  "SAMSUNG GALAXY S24FE": "GALAXY S24 FE",
  "SAMSUNG GALAXY S25FE": "GALAXY S25 FE",

  "GALAXY Z FLIP 4": "GALAXY Z FLIP4",
  "GALAXY Z FLIP 5": "GALAXY Z FLIP5",
  "GALAXY Z FLIP 6": "GALAXY Z FLIP6",

  "GALAXY Z FOLD 4": "GALAXY Z FOLD4",
  "GALAXY Z FOLD 5": "GALAXY Z FOLD5",
  "GALAXY Z FOLD 6": "GALAXY Z FOLD6",
};

function normalizeModelNameForFeed(rawName) {
  if (!rawName) return "";
  let upper = rawName
    .toString()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

  // Some feeds prefix Samsung models as "Samsung Galaxy ..." while CSV/template uses "Galaxy ..."
  if (upper.startsWith("SAMSUNG ")) upper = upper.slice("SAMSUNG ".length).trim();

  // Normalize common 5G suffix variants so model keys line up with CSV/template naming.
  upper = upper.replace(/\s+5G$/, "");

  if (MODEL_ALIASES[upper]) return MODEL_ALIASES[upper];
  return upper;
}

function normalizeModelNameFromCsv(rawName, storage) {
  if (!rawName) return "";
  let upper = rawName
    .toString()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

  const storageNorm = (storage || "").toString().toUpperCase().trim();
  if (storageNorm && upper.endsWith(" " + storageNorm)) {
    upper = upper.slice(0, upper.length - storageNorm.length).trim();
  }

  if (MODEL_ALIASES[upper]) return MODEL_ALIASES[upper];
  return upper;
}

// ===================== CONDITION NORMALIZATION =====================
// Template uses: flawless, good, fair, broken
// CSV may use: damaged, faulty, poor, etc
function normalizeTemplateCondition(condRaw) {
  const c = String(condRaw || "").trim().toLowerCase();
  if (!c) return "";

  if (c === "damaged" || c === "faulty" || c === "broken") return "broken";
  if (c === "poor") return "fair";
  if (c === "like_new" || c === "like new" || c === "likenew") return "flawless";

  // already matches: flawless/good/fair
  return c;
}

// ===================== CARRIER NORMALIZATION =====================
function normalizeCarrierLock(lockStatusRaw) {
  if (!lockStatusRaw) return null;
  const s = String(lockStatusRaw).trim().toLowerCase();
  if (s === "att" || s === "at&t") return "att";
  if (s === "verizon") return "verizon";
  if (s === "unlocked") return "unlocked";
  if (s === "tmobile" || s === "t-mobile" || s === "t mobile") return "tmobile";
  if (s === "locked") return "verizon";
  return null;
}

function normalizeCarrierFromNetwork(networkRaw) {
  if (!networkRaw) return null;
  const s = String(networkRaw).trim().toLowerCase();
  if (s.includes("at&t") || s === "att") return "att";
  if (s === "verizon") return "verizon";
  if (s === "unlocked" || s === "sim-free" || s === "sim free") return "unlocked";
  if (s.includes("t-mobile") || s === "tmobile" || s === "t mobile") return "tmobile";
  return null;
}

function parseMoney(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

// ===================== CSV PARSER =====================
function parseCsv(text) {
  if (!text) return [];
  const rows = [];
  let cur = "";
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      row.push(cur);
      cur = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (cur.length || row.length) {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      }
      if (ch === "\r" && next === "\n") i++;
    } else {
      cur += ch;
    }
  }

  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function csvToRecords(text) {
  const rows = parseCsv((text || "").trim());
  if (!rows.length) return [];
  const header = rows[0].map(h => String(h || "").trim());
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0 || (r.length === 1 && !String(r[0] || "").trim())) continue;
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = r[j] != null ? r[j] : "";
    records.push(obj);
  }
  return records;
}

// ===================== TEMPLATE MODEL -> SELLCELL NAME (KEY FIX) =====================
// We map template models to SellCell model names using deeplink device= param.
// Example deeplink contains: device=samsung-galaxy-s21
// => brand=samsung, modelPart=galaxy-s21 => "GALAXY S21"
function getTextFromNode(parent, tag) {
  const el = parent.getElementsByTagName(tag)[0];
  return el ? String(el.textContent || "").trim() : "";
}

function parseDeviceParamFromDeeplink(deeplink) {
  try {
    const u = new URL(deeplink);
    return u.searchParams.get("device") || "";
  } catch {
    return "";
  }
}

function templateModelToSellcellName(modelNode) {
  const brandRaw = (getTextFromNode(modelNode, "brand") || getTextFromNode(modelNode, "parentDevice") || "").trim().toLowerCase();
  const nameRaw = (getTextFromNode(modelNode, "name") || "").trim();
  const deeplink = getTextFromNode(modelNode, "deeplink");

  // 1) best: deeplink device param
  const deviceParam = parseDeviceParamFromDeeplink(deeplink);
  if (deviceParam) {
    // strip leading brand-
    let s = deviceParam.toLowerCase();
    if (brandRaw && s.startsWith(brandRaw + "-")) s = s.slice(brandRaw.length + 1);

    // turn into words
    let upper = s.replace(/-/g, " ").toUpperCase().replace(/\s+/g, " ").trim();

    // brand-specific prefixing
    if (brandRaw === "samsung" && !upper.startsWith("GALAXY ")) upper = "GALAXY " + upper;
    if ((brandRaw === "iphone" || brandRaw === "apple") && !upper.startsWith("IPHONE ")) upper = "IPHONE " + upper;
    if (brandRaw === "google" && !upper.startsWith("PIXEL ")) upper = "PIXEL " + upper;

    return normalizeModelNameForFeed(upper);
  }

  // 2) fallback: name + brand prefix
  let upper = nameRaw.toUpperCase().replace(/\s+/g, " ").trim();
  if (brandRaw === "samsung" && !upper.includes("GALAXY")) upper = "GALAXY " + upper;
  if ((brandRaw === "iphone" || brandRaw === "apple") && !upper.includes("IPHONE")) upper = "IPHONE " + upper;
  if (brandRaw === "google" && !upper.includes("PIXEL")) upper = "PIXEL " + upper;

  return normalizeModelNameForFeed(upper);
}

function getCanonicalBrandFromModel(modelNode) {
  const raw = (getTextFromNode(modelNode, "brand") || getTextFromNode(modelNode, "parentDevice") || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "apple") return "iphone";
  return normalizeSlugSegment(raw);
}

function getCanonicalDeviceSlug(modelNode) {
  const brand = getCanonicalBrandFromModel(modelNode);
  if (!brand) return "";

  const deeplink = getTextFromNode(modelNode, "deeplink");
  const deeplinkDevice = parseDeviceParamFromDeeplink(deeplink);
  if (deeplinkDevice) {
    const normalized = normalizeSlugSegment(deeplinkDevice);
    if (!normalized) return "";
    return normalized.startsWith(`${brand}-`) ? normalized : `${brand}-${normalized}`;
  }

  const slugRaw = getTextFromNode(modelNode, "slug") || getTextFromNode(modelNode, "modelID");
  if (slugRaw) {
    const normalized = normalizeSlugSegment(slugRaw);
    if (normalized) return normalized.startsWith(`${brand}-`) ? normalized : `${brand}-${normalized}`;
  }

  const nameRaw = getTextFromNode(modelNode, "name");
  const normalizedName = normalizeSlugSegment(nameRaw);
  if (!normalizedName) return "";
  return normalizedName.startsWith(`${brand}-`) ? normalizedName : `${brand}-${normalizedName}`;
}

function buildCanonicalDeeplink(modelNode) {
  const deviceSlug = getCanonicalDeviceSlug(modelNode);
  if (!deviceSlug) return "";

  return `https://secondhandcell.com/sell/?device=${deviceSlug}&storage={storage}&carrier={carrier}&quality={quality}`;
}

function normalizeModelDeeplink(modelNode) {
  const deeplinkEl = modelNode.getElementsByTagName("deeplink")[0];
  if (!deeplinkEl) return false;

  const normalizedDeeplink = buildCanonicalDeeplink(modelNode);
  if (!normalizedDeeplink) return false;

  const currentDeeplink = String(deeplinkEl.textContent || "").trim();
  if (currentDeeplink === normalizedDeeplink) return false;

  deeplinkEl.textContent = normalizedDeeplink;
  return true;
}

// ===================== FEED INDEX FROM SELLCELL XML =====================
function buildFeedIndexFromXml(xmlText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, "application/xml");
  const parseErr = xmlDoc.getElementsByTagName("parsererror")[0];
  if (parseErr) throw new Error("SellCell XML parse error: " + parseErr.textContent.trim());

  const CONDITION_XML_MAP = {
    flawless: "prices_likenew",
    good: "prices_good",
    fair: "prices_poor",
    broken: "prices_faulty", // NOTE: use 'broken' to match template conditions
  };

  const devices = xmlDoc.getElementsByTagName("device");
  const index = {};
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    const nameEl = d.getElementsByTagName("device_name")[0];
    const capEl = d.getElementsByTagName("capacity")[0];
    const netEl = d.getElementsByTagName("network")[0];

    const deviceName = normalizeModelNameForFeed(nameEl ? nameEl.textContent : "");
    const capacity = String(capEl ? capEl.textContent : "").trim().toUpperCase();
    const networkRaw = netEl ? netEl.textContent : "";
    const carrierBucket = normalizeCarrierFromNetwork(networkRaw);

    if (!deviceName || !capacity) continue;

    const keyBase = deviceName + "|" + capacity;
    if (!index[keyBase]) {
      index[keyBase] = {
        att: {},
        verizon: {},
        tmobile: {},
        unlocked: {},
        any: {},
        _modelName: deviceName,
        _storage: capacity,
      };
    }

    for (const condKey of Object.keys(CONDITION_XML_MAP)) {
      const sectionTag = CONDITION_XML_MAP[condKey];
      const section = d.getElementsByTagName(sectionTag)[0];
      if (!section) continue;

      const prices = Array.from(section.getElementsByTagName("price"));
      if (!prices.length) continue;

      const competitorPrices = prices
        .map(p => {
          const mEl = p.getElementsByTagName("merchant_name")[0];
          const priceEl = p.getElementsByTagName("merchant_price")[0];
          const merchant = String(mEl ? mEl.textContent : "").trim().toLowerCase();
          if (merchant === "secondhandcell") return null;
          const v = parseMoney(priceEl ? priceEl.textContent : "");
          return Number.isFinite(v) ? v : null;
        })
        .filter(v => v != null);

      if (!competitorPrices.length) continue;
      const top = Math.max(...competitorPrices);

      if (carrierBucket && index[keyBase][carrierBucket]) {
        const bucket = index[keyBase][carrierBucket];
        if (!bucket[condKey] || top > bucket[condKey]) bucket[condKey] = top;
      }
      const anyBucket = index[keyBase].any;
      if (!anyBucket[condKey] || top > anyBucket[condKey]) anyBucket[condKey] = top;
    }
  }

  return index;
}

// ===================== REPRICER LOGIC =====================
function repriceRowFromFeed(row, feedIndex, rules) {
  const result = { ...row };

  const name = row.name;
  const storage = String(row.storage || "").trim().toUpperCase();
  const condition = normalizeTemplateCondition(row.condition); // IMPORTANT
  const carrierLock = normalizeCarrierLock(row.lock_status);

  const key = normalizeModelNameFromCsv(name, storage) + "|" + storage;
  const feedEntry = feedIndex[key];

  let feedPrice = null;

  if (feedEntry) {
    let bucket = null;
    if (carrierLock && feedEntry[carrierLock] && feedEntry[carrierLock][condition] != null) {
      bucket = feedEntry[carrierLock];
    } else if (feedEntry.any && feedEntry.any[condition] != null) {
      bucket = feedEntry.any;
    }
    if (bucket && bucket[condition] != null) feedPrice = bucket[condition];
  }

  result.original_feed_price = feedPrice != null ? feedPrice : null;

  const amazonPrice = parseMoney(row.amz);
  if (!amazonPrice || !feedPrice) {
    result.amazon_price = amazonPrice || null;
    result.new_price = null;
    result._status = !amazonPrice ? "No valid Amazon price" : `No competitor feed price found (${condition})`;
    result._statusClass = "status-warn";
    return result;
  }

  const after_amazon = amazonPrice * 0.92 - 10;
  const sellcell_fee = Math.min(after_amazon * 0.08, 30);
  const after_sellcell = after_amazon - sellcell_fee;
  const shipping_fee = 15;

  let condition_fee = 0;
  if (condition === "flawless" || condition === "good") condition_fee = 10;
  else if (condition === "fair") condition_fee = 30;
  else if (condition === "broken") condition_fee = 50;

  const total_walkaway = after_sellcell - shipping_fee - condition_fee;

  const original_price = feedPrice;
  const profit = total_walkaway - original_price;
  const profit_pct = original_price ? profit / original_price : null;

  const bumpAmount = getBumpForProfitPct(profit_pct, rules);
  let new_price;
  if (profit_pct != null && profit_pct >= rules.targetProfitPct) {
    new_price = original_price + bumpAmount;
  } else {
    new_price = total_walkaway / (1 + rules.targetProfitPct);
  }

  new_price = roundRepricerPrice(new_price);

  result.amazon_price = amazonPrice;
  result.after_amazon = after_amazon;
  result.sellcell_fee = sellcell_fee;
  result.shipping_fee = shipping_fee;
  result.condition_fee = condition_fee;
  result.total_walkaway = total_walkaway;
  result.profit = profit;
  result.profit_pct = profit_pct;
  result.applied_bump = bumpAmount;
  result.new_price = new_price;
  result.new_profit = total_walkaway - new_price;
  result.new_profit_pct = new_price ? (result.new_profit / new_price) : null;

  result._status = (profit_pct != null && profit_pct >= rules.targetProfitPct)
    ? `Already ≥ ${(rules.targetProfitPct * 100).toFixed(0)}% profit – bumped $${bumpAmount.toFixed(2)}`
    : `Repriced to hit ${(rules.targetProfitPct * 100).toFixed(0)}% profit`;
  result._statusClass = "status-ok";

  // IMPORTANT: keep normalized condition for template match
  result.condition = condition;

  return result;
}

// ===================== XML PRETTY PRINT =====================
function prettyPrintXml(xml) {
  const PADDING = "  ";
  const reg = /(>)(<)(\/*)/g;
  xml = xml.replace(reg, "$1\n$2$3");
  const lines = xml.split("\n");
  let pad = 0;
  const result = [];

  for (let rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    if (/^<\/.+>/.test(line)) pad = Math.max(pad - 1, 0);

    result.push(PADDING.repeat(pad) + line);

    if (/^<[^!?][^>]*[^/]>$/.test(line) && !/<\/.+>$/.test(line)) pad++;
  }
  return result.join("\n");
}

// ===================== BUILD UPDATED XML FROM TEMPLATE + CHANGE COUNT =====================
function buildUpdatedXmlFromTemplateWithDiff(templateXmlText, rows) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(templateXmlText, "application/xml");
  const parseErr = doc.getElementsByTagName("parsererror")[0];
  if (parseErr) throw new Error("Template XML parse error: " + parseErr.textContent.trim());

  // priceMap key: sellcellName|storage|carrier|conditionTag
  const priceMap = new Map();

  for (const r of rows) {
    const sellcellName = normalizeModelNameFromCsv(r.name, r.storage); // CSV -> SellCell name
    const storage = String(r.storage || "").trim().toUpperCase();
    const lockCarrier = normalizeCarrierLock(r.lock_status);
    if (!lockCarrier) continue;

    const condTag = normalizeTemplateCondition(r.condition);
    if (!condTag) continue;

    const newPrice = r.new_price;
    if (newPrice == null || !Number.isFinite(newPrice)) continue;

    const key = sellcellName + "|" + storage + "|" + lockCarrier + "|" + condTag;
    priceMap.set(key, newPrice);
  }

  let changedNodes = 0;
  const changedModels = new Set();
  let matchedKeys = 0;
  let normalizedDeeplinks = 0;

  const models = doc.getElementsByTagName("model");
  for (let i = 0; i < models.length; i++) {
    const model = models[i];

    if (normalizeModelDeeplink(model)) normalizedDeeplinks++;

    // KEY FIX: use deeplink device param to derive SellCell name
    const modelSellcellName = templateModelToSellcellName(model);

    const pricesBlocks = model.getElementsByTagName("prices");
    for (let j = 0; j < pricesBlocks.length; j++) {
      const pricesBlock = pricesBlocks[j];
      const storageEl = pricesBlock.getElementsByTagName("storageSize")[0];
      if (!storageEl) continue;
      const storageVal = String(storageEl.textContent || "").trim().toUpperCase();

      const priceValueEl = pricesBlock.getElementsByTagName("priceValue")[0];
      if (!priceValueEl) continue;

      ["att", "verizon", "tmobile", "unlocked"].forEach(carrierTag => {
        const carrierEl = priceValueEl.getElementsByTagName(carrierTag)[0];
        if (!carrierEl) return;

        ["flawless", "good", "fair", "broken"].forEach(condTag => {
          const condEl = carrierEl.getElementsByTagName(condTag)[0];
          if (!condEl) return;

          const key = modelSellcellName + "|" + storageVal + "|" + carrierTag + "|" + condTag;
          if (!priceMap.has(key)) return;

          matchedKeys++;

          const nextVal = String(priceMap.get(key));
          const prevVal = String(condEl.textContent || "").trim();

          if (prevVal !== nextVal) {
            condEl.textContent = nextVal;
            changedNodes++;
            changedModels.add(modelSellcellName);
          }
        });
      });
    }
  }

  const serializer = new XMLSerializer();
  let xmlOut = serializer.serializeToString(doc);
  if (!/^<\?xml/i.test(xmlOut.trim())) {
    xmlOut = '<?xml version="1.0" encoding="UTF-8"?>\n' + xmlOut;
  }

  return {
    updatedXml: prettyPrintXml(xmlOut),
    changedNodes,
    changedModelsCount: changedModels.size,
    matchedKeys,
    priceMapSize: priceMap.size,
    normalizedDeeplinks,
  };
}

// ===================== OPTIONAL: BUILD OUTPUT CSV =====================
function buildOutputCsv(rows) {
  const header = [
    "name","storage","lock_status","condition","price","amz",
    "original_feed_price","amazon_price","after_amazon","sellcell_fee",
    "shipping_fee","condition_fee","total_walkaway","profit","profit_pct",
    "new_price","new_profit","new_profit_pct","status",
  ];

  const escapeCsv = (value) => {
    if (value == null) return "";
    const s = String(value);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };

  const lines = [header.join(",")];
  for (const r of rows) {
    const row = [
      r.name,
      r.storage,
      r.lock_status,
      r.condition,
      r.price,
      r.amz,
      r.original_feed_price != null ? Number(r.original_feed_price).toFixed(2) : "",
      r.amazon_price != null ? Number(r.amazon_price).toFixed(2) : "",
      r.after_amazon != null ? Number(r.after_amazon).toFixed(2) : "",
      r.sellcell_fee != null ? Number(r.sellcell_fee).toFixed(2) : "",
      r.shipping_fee != null ? Number(r.shipping_fee).toFixed(2) : "",
      r.condition_fee != null ? Number(r.condition_fee).toFixed(2) : "",
      r.total_walkaway != null ? Number(r.total_walkaway).toFixed(2) : "",
      r.profit != null ? Number(r.profit).toFixed(2) : "",
      r.profit_pct != null ? (Number(r.profit_pct) * 100).toFixed(2) + "%" : "",
      r.new_price != null ? Number(r.new_price).toFixed(2) : "",
      r.new_profit != null ? Number(r.new_profit).toFixed(2) : "",
      r.new_profit_pct != null ? (Number(r.new_profit_pct) * 100).toFixed(2) + "%" : "",
      r._status || "",
    ];
    lines.push(row.map(escapeCsv).join(","));
  }
  return lines.join("\n");
}

// ===================== FIRESTORE IMPORT (ALWAYS ON) =====================
function normalizeSlugSegment(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseDevicePricesXmlForImport(content) {
  const parser = new DOMParser();
  const xmlDocument = parser.parseFromString(content, "application/xml");
  const parserError = xmlDocument.getElementsByTagName("parsererror")[0];
  if (parserError) throw new Error("Invalid XML format.");

  const models = [];
  const warnings = [];

  const modelNodes = Array.from(xmlDocument.getElementsByTagName("model"));
  modelNodes.forEach((modelNode, index) => {
    const getText = (tag) => {
      const el = modelNode.getElementsByTagName(tag)[0];
      return el ? String(el.textContent || "").trim() : "";
    };

    const brandRaw = getText("brand") || getText("parentDevice");
    const slugRaw = getText("slug") || getText("modelID");

    const brand = brandRaw ? brandRaw.trim().toLowerCase() : "";
    const slug = normalizeSlugSegment(slugRaw);

    if (!brand || !slug) {
      warnings.push(`Skipped model at position ${index + 1} due to missing brand or slug.`);
      return;
    }

    const prices = {};
    let hasPricing = false;

    const pricesNodes = Array.from(modelNode.getElementsByTagName("prices"));
    pricesNodes.forEach((pricesNode) => {
      const storageSizeEl = pricesNode.getElementsByTagName("storageSize")[0];
      const storageSize = storageSizeEl ? String(storageSizeEl.textContent || "").trim() : "";
      if (!storageSize) return;

      const priceValueNode = pricesNode.getElementsByTagName("priceValue")[0];
      if (!priceValueNode) return;

      const connectivityMap = {};
      const connectivityChildren = Array.from(priceValueNode.childNodes).filter(n => n.nodeType === 1);

      connectivityChildren.forEach((connectivityNode) => {
        const connectivityKey = String(connectivityNode.tagName || "").toLowerCase();
        const conditionEntries = {};
        const conditionChildren = Array.from(connectivityNode.childNodes).filter(n => n.nodeType === 1);

        conditionChildren.forEach((conditionNode) => {
          const conditionKey = String(conditionNode.tagName || "").toLowerCase();
          const numericValue = parseFloat(conditionNode.textContent);
          if (!Number.isNaN(numericValue)) conditionEntries[conditionKey] = numericValue;
        });

        if (Object.keys(conditionEntries).length > 0) {
          connectivityMap[connectivityKey] = { ...(connectivityMap[connectivityKey] || {}), ...conditionEntries };
        }
      });

      if (Object.keys(connectivityMap).length > 0) {
        prices[storageSize] = connectivityMap;
        hasPricing = true;
      }
    });

    if (!hasPricing) {
      warnings.push(`No pricing data found for ${brand}/${slug}.`);
      return;
    }

    models.push({
      brand,
      slug,
      name: getText("name"),
      imageUrl: getText("imageUrl"),
      deeplink: getText("deeplink"),
      prices,
    });
  });

  return { models, warnings };
}

async function importToFirestoreAlways(updatedXmlText) {
  const db = getFirestoreDb();
  const admin = require("firebase-admin");
  const { models, warnings } = parseDevicePricesXmlForImport(updatedXmlText);
  const historyDayId = new Date().toISOString().slice(0, 10);

  let success = 0;
  let fail = 0;
  let changedDocs = 0;
  let changedPriceLeaves = 0;

  for (const model of models) {
    const collectionPath = `devices/${model.brand}/models`;
    const docRef = db.doc(`${collectionPath}/${model.slug}`);

    try {
      const snap = await docRef.get();
      const before = snap.exists ? (snap.data() || {}) : {};

      const beforePrices = before.prices || {};
      const afterPrices = model.prices || {};

      const leafDiffCount = countPriceLeafDiffs(beforePrices, afterPrices);
      if (leafDiffCount > 0 || !snap.exists) {
        changedDocs++;
        changedPriceLeaves += leafDiffCount;
      }

      if (snap.exists && leafDiffCount > 0 && Object.keys(beforePrices || {}).length > 0) {
        await docRef.collection("priceHistory").doc(historyDayId).set(
          {
            date: historyDayId,
            prices: beforePrices,
            source: "repricer-process",
            context: {
              changedLeafCount: leafDiffCount,
            },
            capturedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      const payload = { brand: model.brand, slug: model.slug, prices: model.prices };
      if (model.name) payload.name = model.name;
      if (model.imageUrl) payload.imageUrl = model.imageUrl;
      if (model.deeplink) payload.deeplink = model.deeplink;

      await docRef.set(payload, { merge: true });
      success++;
    } catch (e) {
      fail++;
      console.error(`[import] Failed ${model.brand}/${model.slug}:`, e?.message || e);
    }
  }

  return { modelsCount: models.length, warnings, success, fail, changedDocs, changedPriceLeaves };
}

function countPriceLeafDiffs(beforePrices, afterPrices) {
  let diffs = 0;

  const storages = new Set([...Object.keys(beforePrices || {}), ...Object.keys(afterPrices || {})]);
  for (const storage of storages) {
    const bS = beforePrices?.[storage] || {};
    const aS = afterPrices?.[storage] || {};
    const carriers = new Set([...Object.keys(bS), ...Object.keys(aS)]);
    for (const carrier of carriers) {
      const bC = bS?.[carrier] || {};
      const aC = aS?.[carrier] || {};
      const conds = new Set([...Object.keys(bC), ...Object.keys(aC)]);
      for (const cond of conds) {
        const bV = bC?.[cond];
        const aV = aC?.[cond];
        const bNum = typeof bV === "number" ? bV : (bV != null ? Number(bV) : null);
        const aNum = typeof aV === "number" ? aV : (aV != null ? Number(aV) : null);

        const bOk = Number.isFinite(bNum);
        const aOk = Number.isFinite(aNum);

        if (!bOk && !aOk) continue;
        if (!bOk && aOk) { diffs++; continue; }
        if (bOk && !aOk) { diffs++; continue; }
        if (Number(bNum).toFixed(2) !== Number(aNum).toFixed(2)) diffs++;
      }
    }
  }
  return diffs;
}

// ---------------- MAIN ----------------
async function main() {
  const repricerRules = await loadRepricerRules();

  console.log(`[repricer] dir=${cwd}`);
  console.log(
    `[repricer] tiers=${repricerRules.tiers
      .map((tier) => `${(tier.minProfitPct * 100).toFixed(0)}%=>+$${tier.bumpAmount.toFixed(2)}`)
      .join(", ")}  target=${(repricerRules.targetProfitPct * 100).toFixed(0)}%  write-csv=${WRITE_OUTPUT_CSV ? "yes" : "no"}  firestore=YES  gca=${RUN_GCA ? "yes" : "no"}`
  );

  if (!fs.existsSync(CSV_PATH)) throw new Error(`Missing ${CSV_PATH}. Put your CSV there as amz.csv`);
  if (!fs.existsSync(TEMPLATE_XML_PATH)) throw new Error(`Missing ${TEMPLATE_XML_PATH}. Put your template device-prices XML there as feed.xml`);

  const templateXmlBefore = fs.readFileSync(TEMPLATE_XML_PATH, "utf8");

  console.log(`[repricer] downloading SellCell feed: ${SELLCELL_URL}`);
  const authHeader = `Basic ${Buffer.from(`${SELLCELL_USERNAME}:${SELLCELL_PASSWORD}`).toString("base64")}`;
  const res = await fetch(SELLCELL_URL, {
    method: "GET",
    headers: {
      Authorization: authHeader,
    },
  });
  if (!res.ok) throw new Error(`Failed to download SellCell feed: ${res.status} ${res.statusText}`);
  const sellcellXmlText = await res.text();
  fs.writeFileSync(DOWNLOADED_FEED_PATH, sellcellXmlText, "utf8");
  console.log(`[repricer] SellCell feed downloaded (${sellcellXmlText.length.toLocaleString()} chars)`);
  console.log(`[repricer] SellCell feed saved for Samsung debugging -> ${DOWNLOADED_FEED_PATH}`);

  console.log(`[repricer] building feed index...`);
  const feedIndex = buildFeedIndexFromXml(sellcellXmlText);
  console.log(`[repricer] feed index keys=${Object.keys(feedIndex).length.toLocaleString()}`);

  const csvText = fs.readFileSync(CSV_PATH, "utf8");
  const rawRecords = csvToRecords(csvText);
  if (!rawRecords.length) throw new Error("CSV has no data rows.");

  const requiredCols = ["name", "storage", "lock_status", "condition", "price", "amz"];
  for (const col of requiredCols) if (!(col in rawRecords[0])) throw new Error(`CSV missing required column: ${col}`);

  console.log(`[repricer] csvRows=${rawRecords.length}  newVariants=0  total=${rawRecords.length}`);

  const resultRows = rawRecords.map((r) => repriceRowFromFeed(r, feedIndex, repricerRules));

  const { updatedXml, changedNodes, changedModelsCount, matchedKeys, priceMapSize, normalizedDeeplinks } =
    buildUpdatedXmlFromTemplateWithDiff(templateXmlBefore, resultRows);

  fs.writeFileSync(TEMPLATE_XML_PATH, updatedXml, "utf8");
  console.log(`[repricer] updated template written -> ${TEMPLATE_XML_PATH}`);
  console.log(`[repricer] priceMap=${priceMapSize.toLocaleString()}  matchedKeys=${matchedKeys.toLocaleString()}`);
  console.log(`[repricer] xml price nodes changed=${changedNodes.toLocaleString()}  models touched=${changedModelsCount.toLocaleString()}`);
  console.log(`[repricer] deeplinks normalized=${normalizedDeeplinks.toLocaleString()}`);

  if (WRITE_OUTPUT_CSV) {
    const outCsv = buildOutputCsv(resultRows);
    fs.writeFileSync(OUTPUT_CSV_PATH, outCsv, "utf8");
    console.log(`[repricer] output csv written -> ${OUTPUT_CSV_PATH}`);
  }

  console.log(`[import] importing updated XML into Firestore (always on)...`);
  const r = await importToFirestoreAlways(updatedXml);
  console.log(`[import] models=${r.modelsCount}  success=${r.success}  fail=${r.fail}  warnings=${r.warnings.length}`);
  console.log(`[import] changedDocs=${r.changedDocs}  changedPriceLeaves=${r.changedPriceLeaves.toLocaleString()}`);

  if (r.warnings.length) {
    console.log("[import] warnings:");
    r.warnings.slice(0, 30).forEach(w => console.log(" - " + w));
    if (r.warnings.length > 30) console.log(` - ... +${r.warnings.length - 30} more`);
  }

  if (RUN_GCA) {
    try {
      console.log(`[gca] committing + pushing...`);
      execSync(`cd /shc33 && gca`, { stdio: "inherit", shell: "/bin/bash" });
    } catch (e) {
      console.error(`[gca] failed (repricer still completed).`, e?.message || e);
      process.exitCode = 2;
    }
  }

  console.log(`[done] ✅`);
}

main().catch((e) => {
  console.error("[fatal]", e?.message || e);
  process.exit(1);
});
