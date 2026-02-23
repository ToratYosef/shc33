#!/usr/bin/env node
"use strict";

const admin = require("firebase-admin");

const args = process.argv.slice(2);
const getArg = (name, def = null) => {
  const idx = args.findIndex(a => a === `--${name}`);
  if (idx == -1) return def;
  const v = args[idx + 1];
  if (!v || v.startsWith("--")) return true;
  return v;
};

const DRY_RUN = !!getArg("dry-run", false);
const PROJECT_ID = getArg("project-id", null);

const TARGETS = [
  { brand: "iphone", slug: "12-pro" },
  { brand: "iphone", slug: "12-pro-max" },
  { brand: "iphone", slug: "13-mini" },
  { brand: "samsung", slug: "galaxy-s20-fe" },
  { brand: "samsung", slug: "galaxy-s21-ultra" },
];

async function main() {
  if (admin.apps.length === 0) {
    const opts = PROJECT_ID ? { projectId: PROJECT_ID } : {};
    admin.initializeApp(opts);
  }

  const db = admin.firestore();

  console.log(`[delete] dry-run=${DRY_RUN ? "yes" : "no"}`);
  if (PROJECT_ID) console.log(`[delete] project-id=${PROJECT_ID}`);

  let deleted = 0;
  let missing = 0;

  for (const target of TARGETS) {
    const docPath = `devices/${target.brand}/models/${target.slug}`;
    const ref = db.doc(docPath);
    const snap = await ref.get();

    if (!snap.exists) {
      missing++;
      console.log(`[delete] missing ${docPath}`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`[delete] would delete ${docPath}`);
      deleted++;
      continue;
    }

    await ref.delete();
    deleted++;
    console.log(`[delete] deleted ${docPath}`);
  }

  console.log(`[delete] done. deleted=${deleted} missing=${missing}`);
}

main().catch((error) => {
  console.error(`[delete] failed: ${error?.message || error}`);
  process.exitCode = 1;
});
