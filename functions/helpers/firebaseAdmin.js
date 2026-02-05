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

function tryExtractPrivateKeyFromJson(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.private_key === 'string') {
      return parsed.private_key;
    }
  } catch (error) {
    // Value is not JSON.
  }

  return null;
}

function normalizePrivateKey(privateKeyValue) {
  if (!privateKeyValue || typeof privateKeyValue !== 'string') {
    return null;
  }

  let key = stripWrappingQuotes(privateKeyValue);

  const keyFromJson = tryExtractPrivateKeyFromJson(key);
  if (keyFromJson) {
    key = keyFromJson;
  }

  key = key.replace(/\\n/g, '\n');

  if (!key.includes('BEGIN') && /^[A-Za-z0-9+/=\s]+$/.test(key)) {
    try {
      const decoded = Buffer.from(key, 'base64').toString('utf8').trim();
      const decodedJsonPrivateKey = tryExtractPrivateKeyFromJson(decoded);
      if (decodedJsonPrivateKey) {
        key = decodedJsonPrivateKey;
      } else if (decoded.includes('BEGIN')) {
        key = decoded;
      }
    } catch (error) {
      // Keep original key if decoding fails.
    }
  }

  return stripWrappingQuotes(key);
}

function initFirebaseAdmin() {
  if (admin.apps.length) {
    return admin.app();
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = normalizePrivateKey(
    process.env.FIREBASE_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY
  );
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || undefined;

  if (projectId && clientEmail && privateKey) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
      storageBucket,
    });
  } else {
    admin.initializeApp({ storageBucket });
  }

  return admin.app();
}

module.exports = {
  admin,
  initFirebaseAdmin,
  normalizePrivateKey,
};
