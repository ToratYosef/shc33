const admin = require('firebase-admin');

function stripWrappingQuotes(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function normalizePrivateKey(rawPrivateKey) {
  if (!rawPrivateKey || typeof rawPrivateKey !== 'string') {
    return rawPrivateKey;
  }

  return stripWrappingQuotes(rawPrivateKey)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r');
}

function initFirebaseAdmin() {
  if (admin.apps.length) {
    return admin.app();
  }

  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
    FIREBASE_STORAGE_BUCKET,
  } = process.env;

  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    const privateKey = normalizePrivateKey(FIREBASE_PRIVATE_KEY);
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
      storageBucket: FIREBASE_STORAGE_BUCKET || undefined,
    });
  } else {
    admin.initializeApp({
      storageBucket: FIREBASE_STORAGE_BUCKET || undefined,
    });
  }

  return admin.app();
}

initFirebaseAdmin();

const db = admin.firestore();

module.exports = { admin, db };
