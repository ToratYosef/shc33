#!/usr/bin/env node
"use strict";

/**
 * SecondHandCell repricer
 * - Downloads SellCell feed XML
 * - Indexes competitor top prices by model|storage|carrier|sellcellConditionBucket
 * - Reprices rows from amz.csv
 * - Writes updated device-prices template XML (feed.xml)
 * - Imports to Firestore (devices/{brand}/models/{slug})
 *
 * FIXES:
 * - Template condition tags are NOT assumed to be flawless/good/fair/broken anymore.
 * - We dynamically detect template condition tags (e.g. noPower, crackedScreen, etc)
 * - We map template condition tags -> SellCell condition buckets via heuristics.
 */

const fs = require("fs");
const path = require("path");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const { execSync } = require("child_process");

// ---------------- CONFIG ----------------
const SELLCELL_URL = "http://secondhandcell.com/sellcell/feed.xml";

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
const PRICE_INCREASE = Number.parseFloat(getArg("bump", "1.00")) || 1.00;

// optional outputs
const WRITE_OUTPUT_CSV = !!getArg("write-csv", false);
const OUTPUT_CSV_PATH = path.join(cwd, "repricer-output.csv");

// gca auto-run
const RUN_GCA = !getArg("no-gca", false);

// optional: use explicit project id (otherwise uses service account / default creds)
const FIREBASE_PROJECT_ID = getArg("project-id", null);

// optional: debug one model path like "samsung/galaxy-s21"
const DEBUG_ONE = getArg("debug-one", null);

// ---------------- HELPERS (ported + fixed) ----------------

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

// ===================== CARRIER NORMALIZATION =====================
function normalizeCarrierLock(lockStatusRaw) {
  if (!lockStatusRaw) return null;
  const s = String(lockStatusRaw).trim().toLowerCase();
  if (s === "att" || s === "at&t") return "att";
  if (s === "verizon") return "verizon";
  if (s === "unlocked") return "unlocked";
  if (s === "tmobile" || s === "t-mobile" || s === "t mobile") return "tmobile";
  if (s === "locked") return "verizon"; // legacy
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

// ===================== TEMPLATE CONDITION DISCOVERY =====================
// We’ll discover what condition tags exist in your template XML under:
// model -> prices -> priceValue -> carrierTag -> (conditionTag children)
function discoverTemplateConditionsByCarrier(templateXmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(templateXmlText, "application/xml");
  const parseErr = doc.getElementsByTagName("parsererror")[0];
  if (parseErr) throw new Error("Template XML parse error: " + parseErr.textContent.trim());

  const carriers = ["att", "verizon", "tmobile", "unlocked"];
  const found = { att: new Set(), verizon: new Set(), tmobile: new Set(), unlocked: new Set() };

  const models = Array.from(doc.getElementsByTagName("model"));
  for (const model of models) {
    const pricesBlocks = Array.from(model.getElementsByTagName("prices"));
    for (const pricesBlock of pricesBlocks) {
      const priceValueEl = pricesBlock.getElementsByTagName("priceValue")[0];
      if (!priceValueEl) continue;

      for (const carrierTag of carriers) {
        const carrierEl = priceValueEl.getElementsByTagName(carrierTag)[0];
        if (!carrierEl) continue;

        // child elements only
        const children = Array.from(carrierEl.childNodes).filter(n => n.nodeType === 1);
        for (const c of children) {
          const tag = String(c.tagName || "").trim();
          if (tag) found[carrierTag].add(tag);
        }
      }
    }
  }

  // Convert sets to arrays
  const out = {};
  for (const c of carriers) out[c] = Array.from(found[c]).sort();
  return out;
}

// ===================== SELL-CELL CONDITION BUCKET MAPPING =====================
// SellCell sections (what we can index):
// flawless -> prices_likenew
// good     -> prices_good
// fair     -> prices_poor
// damaged  -> prices_faulty
//
// Your template/CSV condition keys might be: noPower, broken, crackedScreen, likeNew, etc.
// We map arbitrary conditionTag -> one of: flawless, good, fair, damaged (SellCell bucket)
function mapInternalConditionToSellCellBucket(conditionTagRaw) {
  const s = String(conditionTagRaw || "").trim().toLowerCase();
  if (!s) return "damaged";

  // very good / like new
  if (
    s.includes("flaw") ||
    s.includes("like") ||
    s.includes("mint") ||
    s.includes("excellent") ||
    s.includes("a1") ||
    s.includes("pristine")
  ) return "flawless";

  // good / normal wear
  if (
    s === "good" ||
    s.includes("good") ||
    s.includes("b") ||
    s.includes("normal") ||
    s.includes("wear")
  ) return "good";

  // fair / poor cosmetics
  if (
    s === "fair" ||
    s.includes("fair") ||
    s.includes("poor") ||
    s.includes("c") ||
    s.includes("heavy")
  ) return "fair";

  // broken/faulty/no power/etc
  return "damaged";
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
    damaged: "prices_faulty",
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

// Detect missing storage variants vs the feed and create placeholder rows
function detectAndAddMissingVariants(csvRecords, feedIndex) {
  const modelStoragesInCsv = {};
  csvRecords.forEach(r => {
    const modelName = normalizeModelNameFromCsv(r.name, r.storage);
    const storage = String(r.storage || "").trim().toUpperCase();
    if (!modelStoragesInCsv[modelName]) modelStoragesInCsv[modelName] = new Set();
    modelStoragesInCsv[modelName].add(storage);
  });

  const feedModelStorages = {};
  Object.keys(feedIndex).forEach(key => {
    const entry = feedIndex[key];
    const modelName = entry._modelName;
    const storage = entry._storage;
    if (!feedModelStorages[modelName]) feedModelStorages[modelName] = new Set();
    feedModelStorages[modelName].add(storage);
  });

  const newVariants = [];
  const carriers = ["att", "verizon", "tmobile", "unlocked"];

  // NOTE: for new variants, we don’t know your internal condition tags.
  // We’ll leave condition empty so you can fill later OR it just won’t price.
  Object.keys(modelStoragesInCsv).forEach(modelName => {
    const csvStorages = modelStoragesInCsv[modelName];
    const feedStorages = feedModelStorages[modelName];
    if (!feedStorages) return;

    feedStorages.forEach(feedStorage => {
      if (csvStorages.has(feedStorage)) return;

      carriers.forEach(carrier => {
        const sampleRow = csvRecords.find(r => normalizeModelNameFromCsv(r.name, r.storage) === modelName);
        if (!sampleRow) return;
        newVariants.push({
          name: sampleRow.name,
          storage: feedStorage,
          lock_status: carrier,
          condition: sampleRow.condition || "", // inherit some condition key from your CSV to be safe
          price: "",
          amz: "",
          _isNewVariant: true,
        });
      });
    });
  });

  return newVariants;
}

// ===================== REPRICER LOGIC =====================
function computeConditionFeeFromSellcellBucket(sellcellBucket) {
  // keep your old fee logic but driven by bucket
  if (sellcellBucket === "flawless" || sellcellBucket === "good") return 10;
  if (sellcellBucket === "fair") return 30;
  return 50; // damaged
}

function repriceRowFromFeed(row, feedIndex, priceIncrease) {
  const result = { ...row };

  const name = row.name;
  const storage = String(row.storage || "").trim().toUpperCase();
  const carrierLock = normalizeCarrierLock(row.lock_status);

  const internalCondition = String(row.condition || "").trim(); // could be noPower, broken, etc
  const sellcellBucket = mapInternalConditionToSellCellBucket(internalCondition);

  const key = normalizeModelNameFromCsv(name, storage) + "|" + storage;
  const feedEntry = feedIndex[key];

  let feedPrice = null;

  if (feedEntry) {
    let bucket = null;
    if (carrierLock && feedEntry[carrierLock] && feedEntry[carrierLock][sellcellBucket] != null) {
      bucket = feedEntry[carrierLock];
    } else if (feedEntry.any && feedEntry.any[sellcellBucket] != null) {
      bucket = feedEntry.any;
    }
    if (bucket && bucket[sellcellBucket] != null) feedPrice = bucket[sellcellBucket];
  }

  result.original_feed_price = feedPrice != null ? feedPrice : null;
  result._sellcell_bucket = sellcellBucket;

  const amazonPrice = parseMoney(row.amz);
  if (!amazonPrice || !feedPrice) {
    result.amazon_price = amazonPrice || null;
    result.new_price = null;
    result._status = !amazonPrice
      ? "No valid Amazon price"
      : `No competitor feed price found (${sellcellBucket})`;
    result._statusClass = "status-warn";
    return result;
  }

  const after_amazon = amazonPrice * 0.92 - 10;
  const sellcell_fee = Math.min(after_amazon * 0.08, 30);
  const after_sellcell = after_amazon - sellcell_fee;
  const shipping_fee = 15;

  const condition_fee = computeConditionFeeFromSellcellBucket(sellcellBucket);

  const total_walkaway = after_sellcell - shipping_fee - condition_fee;

  const original_price = feedPrice;
  const profit = total_walkaway - original_price;
  const profit_pct = original_price ? profit / original_price : null;

  let new_price;
  if (profit_pct != null && profit_pct >= 0.15) new_price = original_price + priceIncrease;
  else new_price = total_walkaway / 1.15;

  new_price = Math.round(new_price * 100) / 100;

  result.amazon_price = amazonPrice;
  result.after_amazon = after_amazon;
  result.sellcell_fee = sellcell_fee;
  result.shipping_fee = shipping_fee;
  result.condition_fee = condition_fee;
  result.total_walkaway = total_walkaway;
  result.profit = profit;
  result.profit_pct = profit_pct;
  result.new_price = new_price;
  result.new_profit = total_walkaway - new_price;
  result.new_profit_pct = new_price ? (result.new_profit / new_price) : null;

  result._status = (profit_pct != null && profit_pct >= 0.15)
    ? `Already ≥ 15% profit – bumped $${priceIncrease.toFixed(2)}`
    : "Repriced to hit 15% profit";
  result._statusClass = "status-ok";

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

    if (
      /^<[^!?][^>]*[^/]>$/.test(line) &&
      !/<\/.+>$/.test(line)
    ) pad++;
  }
  return result.join("\n");
}

// ===================== BUILD UPDATED XML FROM TEMPLATE (DYNAMIC CONDITIONS) =====================
function buildUpdatedXmlFromTemplateWithDiff(templateXmlText, rows) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(templateXmlText, "application/xml");
  const parseErr = doc.getElementsByTagName("parsererror")[0];
  if (parseErr) throw new Error("Template XML parse error: " + parseErr.textContent.trim());

  const carriers = ["att", "verizon", "tmobile", "unlocked"];

  // priceMap key: nameNorm|storage|carrier|conditionTag (conditionTag is EXACT template tag)
  const priceMap = new Map();

  rows.forEach(r => {
    const nameNorm = normalizeModelNameFromCsv(r.name, r.storage);
    const storage = String(r.storage || "").trim().toUpperCase();
    const lockCarrier = normalizeCarrierLock(r.lock_status);
    if (!lockCarrier) return;

    const condTag = String(r.condition || "").trim(); // keep EXACT condition key from CSV
    if (!condTag) return;

    const newPrice = r.new_price;
    if (newPrice == null || !Number.isFinite(newPrice)) return;

    const key = nameNorm + "|" + storage + "|" + lockCarrier + "|" + condTag;
    priceMap.set(key, newPrice);
  });

  let changedNodes = 0;
  const changedModels = new Set();

  const models = doc.getElementsByTagName("model");
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const nameEl = model.getElementsByTagName("name")[0];
    if (!nameEl) continue;
    const nameNorm = normalizeModelNameForFeed(nameEl.textContent);

    const pricesBlocks = model.getElementsByTagName("prices");
    for (let j = 0; j < pricesBlocks.length; j++) {
      const pricesBlock = pricesBlocks[j];
      const storageEl = pricesBlock.getElementsByTagName("storageSize")[0];
      if (!storageEl) continue;
      const storageVal = String(storageEl.textContent || "").trim().toUpperCase();

      const priceValueEl = pricesBlock.getElementsByTagName("priceValue")[0];
      if (!priceValueEl) continue;

      for (const carrierTag of carriers) {
        const carrierEl = priceValueEl.getElementsByTagName(carrierTag)[0];
        if (!carrierEl) continue;

        // iterate ALL condition children dynamically
        const condChildren = Array.from(carrierEl.childNodes).filter(n => n.nodeType === 1);
        for (const condEl of condChildren) {
          const condTag = String(condEl.tagName || "").trim();
          if (!condTag) continue;

          const key = nameNorm + "|" + storageVal + "|" + carrierTag + "|" + condTag;
          if (!priceMap.has(key)) continue;

          const nextVal = String(priceMap.get(key));
          const prevVal = String(condEl.textContent || "").trim();

          if (prevVal !== nextVal) {
            condEl.textContent = nextVal;
            changedNodes++;
            changedModels.add(nameNorm);
          }
        }
      }
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
  };
}

// ===================== OPTIONAL: BUILD OUTPUT CSV =====================
function buildOutputCsv(rows) {
  const header = [
    "name","storage","lock_status","condition","price","amz",
    "sellcell_bucket","original_feed_price","amazon_price","after_amazon","sellcell_fee",
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
      r._sellcell_bucket || "",
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
          const conditionKey = String(conditionNode.tagName || "");
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
  const admin = require("firebase-admin");

  if (admin.apps.length === 0) {
    const opts = {};
    if (FIREBASE_PROJECT_ID) opts.projectId = FIREBASE_PROJECT_ID;
    admin.initializeApp(opts);
  }

  const db = admin.firestore();

  const { models, warnings } = parseDevicePricesXmlForImport(updatedXmlText);

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

  return {
    modelsCount: models.length,
    warnings,
    success,
    fail,
    changedDocs,
    changedPriceLeaves,
  };
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
  console.log(`[repricer] dir=${cwd}`);
  console.log(`[repricer] bump=$${PRICE_INCREASE.toFixed(2)}  write-csv=${WRITE_OUTPUT_CSV ? "yes" : "no"}  firestore=YES  gca=${RUN_GCA ? "yes" : "no"}`);

  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`Missing ${CSV_PATH}. Put your CSV there as amz.csv`);
  }
  if (!fs.existsSync(TEMPLATE_XML_PATH)) {
    throw new Error(`Missing ${TEMPLATE_XML_PATH}. Put your template device-prices XML there as feed.xml`);
  }

  const templateXmlBefore = fs.readFileSync(TEMPLATE_XML_PATH, "utf8");

  // show template condition tags (this is the smoking gun)
  const conds = discoverTemplateConditionsByCarrier(templateXmlBefore);
  console.log("[repricer] template condition tags by carrier:");
  console.log("  att     =", conds.att.join(", ") || "(none)");
  console.log("  verizon =", conds.verizon.join(", ") || "(none)");
  console.log("  tmobile =", conds.tmobile.join(", ") || "(none)");
  console.log("  unlocked=", conds.unlocked.join(", ") || "(none)");

  // 1) download SellCell feed
  console.log(`[repricer] downloading SellCell feed: ${SELLCELL_URL}`);
  const res = await fetch(SELLCELL_URL, { method: "GET" });
  if (!res.ok) throw new Error(`Failed to download SellCell feed: ${res.status} ${res.statusText}`);
  const sellcellXmlText = await res.text();
  console.log(`[repricer] SellCell feed downloaded (${sellcellXmlText.length.toLocaleString()} chars)`);

  // 2) parse + build feed index
  console.log(`[repricer] building feed index...`);
  const feedIndex = buildFeedIndexFromXml(sellcellXmlText);
  console.log(`[repricer] feed index keys=${Object.keys(feedIndex).length.toLocaleString()}`);

  // 3) load CSV
  const csvText = fs.readFileSync(CSV_PATH, "utf8");
  const rawRecords = csvToRecords(csvText);
  if (!rawRecords.length) throw new Error("CSV has no data rows.");

  const requiredCols = ["name", "storage", "lock_status", "condition", "price", "amz"];
  for (const col of requiredCols) {
    if (!(col in rawRecords[0])) throw new Error(`CSV missing required column: ${col}`);
  }

  // 4) detect missing variants + run repricer
  const newVariants = detectAndAddMissingVariants(rawRecords, feedIndex);
  const allRecords = [...rawRecords, ...newVariants];

  console.log(`[repricer] csvRows=${rawRecords.length}  newVariants=${newVariants.length}  total=${allRecords.length}`);

  const resultRows = allRecords.map((r) => repriceRowFromFeed(r, feedIndex, PRICE_INCREASE));

  // debug a specific model if requested (brand/slug)
  if (DEBUG_ONE) {
    console.log(`[debug-one] requested: ${DEBUG_ONE}`);
    // we can’t map slug->name here without parsing template; the import stage below will show it.
    console.log(`[debug-one] Tip: after run, use the Firestore probe command I gave you to inspect that doc.`);
  }

  // 5) build updated XML from template + count changes (DYNAMIC condition tags)
  const { updatedXml, changedNodes, changedModelsCount } =
    buildUpdatedXmlFromTemplateWithDiff(templateXmlBefore, resultRows);

  // 6) overwrite feed.xml
  fs.writeFileSync(TEMPLATE_XML_PATH, updatedXml, "utf8");
  console.log(`[repricer] updated template written -> ${TEMPLATE_XML_PATH}`);
  console.log(`[repricer] xml price nodes changed=${changedNodes.toLocaleString()}  models touched=${changedModelsCount.toLocaleString()}`);

  // 7) optional output csv
  if (WRITE_OUTPUT_CSV) {
    const outCsv = buildOutputCsv(resultRows);
    fs.writeFileSync(OUTPUT_CSV_PATH, outCsv, "utf8");
    console.log(`[repricer] output csv written -> ${OUTPUT_CSV_PATH}`);
  }

  // 8) ALWAYS import to Firestore
  console.log(`[import] importing updated XML into Firestore (always on)...`);
  const r = await importToFirestoreAlways(updatedXml);
  console.log(`[import] models=${r.modelsCount}  success=${r.success}  fail=${r.fail}  warnings=${r.warnings.length}`);
  console.log(`[import] changedDocs=${r.changedDocs}  changedPriceLeaves=${r.changedPriceLeaves.toLocaleString()}`);

  if (r.warnings.length) {
    console.log("[import] warnings:");
    r.warnings.slice(0, 30).forEach(w => console.log(" - " + w));
    if (r.warnings.length > 30) console.log(` - ... +${r.warnings.length - 30} more`);
  }

  // 9) run gca to push to github
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
