#!/usr/bin/env node

/**
 * Cleanup script to remove duplicate device documents from Firestore.
 * 
 * This script removes legacy slug documents (e.g., samsung-galaxy-s21) 
 * and keeps only the canonical slug documents (e.g., galaxy-s21).
 * 
 * Run with: node cleanup-duplicate-slugs.js [--dry-run] [--project-id=<id>]
 */

const admin = require("firebase-admin");
const path = require("path");

// Parse CLI args
function getArg(key, defaultValue) {
  const prefix = `--${key}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  if (found) return found.substring(prefix.length);
  
  const flagIndex = process.argv.indexOf(`--${key}`);
  if (flagIndex !== -1) return true;
  
  return defaultValue;
}

const DRY_RUN = !!getArg("dry-run", false);
const FIREBASE_PROJECT_ID = getArg("project-id", null);

function getFirestoreDb() {
  if (admin.apps.length === 0) {
    const serviceAccountPath = path.join(__dirname, "buyback-a0f05-firebase-adminsdk-fbsvc-c9befd867c.json");
    const options = { credential: admin.credential.cert(serviceAccountPath) };
    if (FIREBASE_PROJECT_ID) options.projectId = FIREBASE_PROJECT_ID;
    admin.initializeApp(options);
  }
  return admin.firestore();
}

async function cleanupDuplicates() {
  const db = getFirestoreDb();
  
  console.log(`[cleanup] mode=${DRY_RUN ? "DRY-RUN" : "LIVE"}`);
  
  const brands = ["iphone", "samsung"];
  let totalChecked = 0;
  let totalDeleted = 0;
  
  for (const brand of brands) {
    const collectionPath = `devices/${brand}/models`;
    const snapshot = await db.collection(collectionPath).get();
    
    console.log(`\n[${brand}] found ${snapshot.size} documents`);
    
    const slugMap = new Map(); // canonical -> [legacy slugs]
    
    // Group documents by canonical slug
    for (const doc of snapshot.docs) {
      const slug = doc.id;
      totalChecked++;
      
      let canonicalSlug = slug;
      let isLegacy = false;
      
      // Identify legacy Samsung slugs
      if (brand === "samsung" && slug.startsWith("samsung-galaxy-")) {
        canonicalSlug = slug.replace(/^samsung-/, "");
        isLegacy = true;
      }
      
      // Identify legacy iPhone slugs (e.g., "13" instead of "iphone-13")
      if (brand === "iphone" && /^\d/.test(slug)) {
        canonicalSlug = `iphone-${slug}`;
        isLegacy = true;
      }
      
      if (!slugMap.has(canonicalSlug)) {
        slugMap.set(canonicalSlug, []);
      }
      
      if (isLegacy) {
        slugMap.get(canonicalSlug).push(slug);
      }
    }
    
    // Delete legacy documents
    for (const [canonical, legacySlugs] of slugMap.entries()) {
      if (legacySlugs.length === 0) continue;
      
      console.log(`  ${canonical}: removing ${legacySlugs.length} duplicate(s): ${legacySlugs.join(", ")}`);
      
      for (const legacySlug of legacySlugs) {
        if (!DRY_RUN) {
          await db.doc(`${collectionPath}/${legacySlug}`).delete();
        }
        totalDeleted++;
      }
    }
  }
  
  console.log(`\n[cleanup] checked=${totalChecked}  deleted=${totalDeleted}`);
  if (DRY_RUN) {
    console.log(`[cleanup] DRY-RUN mode - no documents were actually deleted`);
    console.log(`[cleanup] Run without --dry-run to actually delete duplicates`);
  } else {
    console.log(`[cleanup] DONE ✅`);
  }
}

cleanupDuplicates().catch((e) => {
  console.error("[fatal]", e?.message || e);
  process.exit(1);
});
