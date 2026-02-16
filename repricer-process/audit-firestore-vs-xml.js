#!/usr/bin/env node
/**
 * audit-firestore-vs-xml.js
 * Compare /shc33/feed/feed.xml vs Firestore devices/{brand}/models/{slug}.prices
 *
 * Usage:
 *   node /shc33/repricer-process/audit-firestore-vs-xml.js
 *
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS set (you already did)
 *   - firebase-admin installed
 *   - feed.xml present at /shc33/feed/feed.xml (or pass --xml /path)
 */

const fs = require("fs");
const path = require("path");
const { DOMParser } = require("@xmldom/xmldom");

const args = process.argv.slice(2);
const getArg = (name, def = null) => {
  const idx = args.findIndex(a => a === `--${name}`);
  if (idx === -1) return def;
  const v = args[idx + 1];
  if (!v || v.startsWith("--")) return true;
  return v;
};

const XML_PATH = path.resolve(getArg("xml", "/shc33/feed/feed.xml"));
const EPS = Number.parseFloat(getArg("eps", "0.005")) || 0.005;
const MAX_DIFFS = Number.parseInt(getArg("max-diffs", "50"), 10) || 50;
const ONLY_BRAND = getArg("brand", null); // optional filter

function approxEqualMoney(a, b, eps = EPS) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= eps;
}

function normalizeSlugSegment(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Parse XML into the same shape your import uses: [{brand, slug, prices}]
function parseDevicePricesXml(content) {
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

    if (ONLY_BRAND && brand !== String(ONLY_BRAND).toLowerCase()) return;

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
          if (!connectivityMap[connectivityKey]) connectivityMap[connectivityKey] = {};
          connectivityMap[connectivityKey] = { ...connectivityMap[connectivityKey], ...conditionEntries };
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

    models.push({ brand, slug, prices });
  });

  return { models, warnings };
}

// Flatten prices into leaf keys for easy comparison
// key format: `${storage}|${connectivity}|${condition}`
function flattenPrices(pricesObj) {
  const out = new Map();
  if (!pricesObj || typeof pricesObj !== "object") return out;

  for (const storage of Object.keys(pricesObj)) {
    const connMap = pricesObj[storage];
    if (!connMap || typeof connMap !== "object") continue;

    for (const conn of Object.keys(connMap)) {
      const condMap = connMap[conn];
      if (!condMap || typeof condMap !== "object") continue;

      for (const cond of Object.keys(condMap)) {
        const v = Number(condMap[cond]);
        if (!Number.isFinite(v)) continue;
        out.set(`${storage}|${conn}|${cond}`, v);
      }
    }
  }
  return out;
}

async function main() {
  console.log(`[audit] xml=${XML_PATH}`);
  console.log(`[audit] eps=${EPS}  max-diffs=${MAX_DIFFS}${ONLY_BRAND ? `  brand=${ONLY_BRAND}` : ""}`);

  if (!fs.existsSync(XML_PATH)) {
    throw new Error(`Missing XML file: ${XML_PATH}`);
  }

  const xmlText = fs.readFileSync(XML_PATH, "utf8");
  const { models, warnings } = parseDevicePricesXml(xmlText);

  if (warnings.length) {
    console.log(`[audit] warnings=${warnings.length}`);
    warnings.slice(0, 10).forEach(w => console.log(" - " + w));
    if (warnings.length > 10) console.log(` - ... +${warnings.length - 10} more`);
  }

  console.log(`[audit] models_in_xml=${models.length}`);

  const admin = require("firebase-admin");
  if (admin.apps.length === 0) {
    admin.initializeApp(); // uses GOOGLE_APPLICATION_CREDENTIALS
  }
  const db = admin.firestore();

  let docsMatch = 0;
  let docsDiffer = 0;
  let docsMissing = 0;

  let leafEqual = 0;
  let leafDiff = 0;
  let leafMissingInFs = 0;
  let leafMissingInXml = 0;

  const diffs = [];

  for (const m of models) {
    const docPath = `devices/${m.brand}/models/${m.slug}`;
    const snap = await db.doc(docPath).get();

    if (!snap.exists) {
      docsMissing++;
      if (diffs.length < MAX_DIFFS) diffs.push({ type: "missing_doc", docPath });
      continue;
    }

    const fsPrices = snap.get("prices");
    const xmlLeaves = flattenPrices(m.prices);
    const fsLeaves = flattenPrices(fsPrices);

    let docHasDiff = false;

    // compare xml -> fs
    for (const [k, xmlV] of xmlLeaves.entries()) {
      const fsV = fsLeaves.has(k) ? fsLeaves.get(k) : null;

      if (fsV == null) {
        leafMissingInFs++;
        docHasDiff = true;
        if (diffs.length < MAX_DIFFS) diffs.push({ type: "missing_in_firestore", docPath, key: k, xml: xmlV });
        continue;
      }

      if (approxEqualMoney(xmlV, fsV)) {
        leafEqual++;
      } else {
        leafDiff++;
        docHasDiff = true;
        if (diffs.length < MAX_DIFFS) diffs.push({ type: "value_diff", docPath, key: k, xml: xmlV, firestore: fsV });
      }
    }

    // compare fs -> xml (extra leaves in fs)
    for (const [k, fsV] of fsLeaves.entries()) {
      if (!xmlLeaves.has(k)) {
        leafMissingInXml++;
        docHasDiff = true;
        if (diffs.length < MAX_DIFFS) diffs.push({ type: "missing_in_xml", docPath, key: k, firestore: fsV });
      }
    }

    if (docHasDiff) docsDiffer++;
    else docsMatch++;
  }

  console.log("");
  console.log("========== SUMMARY ==========");
  console.log(`[audit] docs: match=${docsMatch}  differ=${docsDiffer}  missing=${docsMissing}`);
  console.log(`[audit] leafs: equal=${leafEqual}  diff=${leafDiff}  missing_in_firestore=${leafMissingInFs}  missing_in_xml=${leafMissingInXml}`);
  console.log("");

  if (diffs.length) {
    console.log(`========== SAMPLE DIFFS (up to ${MAX_DIFFS}) ==========`);

    for (const d of diffs) {
      if (d.type === "missing_doc") {
        console.log(`- [missing_doc] ${d.docPath}`);
      } else if (d.type === "missing_in_firestore") {
        console.log(`- [missing_in_firestore] ${d.docPath} :: ${d.key}  xml=${d.xml}`);
      } else if (d.type === "missing_in_xml") {
        console.log(`- [missing_in_xml] ${d.docPath} :: ${d.key}  firestore=${d.firestore}`);
      } else if (d.type === "value_diff") {
        console.log(`- [value_diff] ${d.docPath} :: ${d.key}  xml=${d.xml}  firestore=${d.firestore}`);
      }
    }
  } else {
    console.log("[audit] ✅ No diffs found. Firestore matches feed.xml.");
  }
}

main().catch((e) => {
  console.error("[fatal]", e?.message || e);
  process.exit(1);
});
