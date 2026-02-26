#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const CONDITION_ALIASES = {
  flawless: 'flawless',
  good: 'good',
  fair: 'fair',
  damaged: 'broken',
  broken: 'broken',
};

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseCli(argv) {
  const requestedConditions = new Set();
  const modelParts = [];

  for (const token of argv) {
    if (token.startsWith('--')) {
      const flag = token.slice(2).toLowerCase();
      if (!CONDITION_ALIASES[flag]) {
        console.error(`Unknown flag: ${token}`);
        process.exit(1);
      }
      requestedConditions.add(CONDITION_ALIASES[flag]);
      continue;
    }
    modelParts.push(token);
  }

  if (modelParts.length === 0) {
    console.error('Usage: price <model with storage> [--flawless] [--good] [--fair] [--damaged]');
    process.exit(1);
  }

  const modelInput = modelParts.join(' ');
  const storageMatch = modelInput.match(/(\d+)\s*\(?\s*gb\s*\)?/i);
  const storage = storageMatch ? `${storageMatch[1]}GB` : '';
  const modelName = normalizeText(modelInput.replace(/\d+\s*\(?\s*gb\s*\)?/gi, ''));

  if (!storage) {
    console.error('Please include storage in the model input (example: "iphone 13 pro max 128gb").');
    process.exit(1);
  }

  return { storage, modelName, requestedConditions };
}

function pickRows(rows) {
  const byCondition = new Map();
  for (const row of rows) {
    if (!byCondition.has(row.condition)) {
      byCondition.set(row.condition, row);
      continue;
    }

    const existing = byCondition.get(row.condition);
    if (existing.lock_status !== 'unlocked' && row.lock_status === 'unlocked') {
      byCondition.set(row.condition, row);
    }
  }
  return byCondition;
}

function main() {
  const { storage, modelName, requestedConditions } = parseCli(process.argv.slice(2));
  const csvPath = path.resolve(__dirname, '..', 'feed', 'repricer-output.csv');

  if (!fs.existsSync(csvPath)) {
    console.error(`Pricing file not found at ${csvPath}`);
    process.exit(1);
  }

  const records = parse(fs.readFileSync(csvPath, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
  });

  const matched = records.filter((row) => {
    return normalizeText(row.name) === modelName && normalizeText(row.storage) === normalizeText(storage);
  });

  if (matched.length === 0) {
    console.error(`No pricing found for "${modelName}" ${storage}.`);
    process.exit(1);
  }

  const byCondition = pickRows(matched);
  const outputOrder = [
    ['flawless', 'flawless'],
    ['good', 'good'],
    ['fair', 'fair'],
    ['damaged', 'broken'],
  ];

  for (const [label, conditionKey] of outputOrder) {
    if (requestedConditions.size > 0 && !requestedConditions.has(conditionKey)) {
      continue;
    }

    const row = byCondition.get(conditionKey);
    const price = row ? row.price : 'N/A';
    console.log(`${label} --> ${price}`);
  }
}

main();
