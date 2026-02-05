const admin = require('firebase-admin');

function normalizePrivateKey(privateKeyValue) {
  if (!privateKeyValue || typeof privateKeyValue !== 'string') {
    return null;
  }

  let key = privateKeyValue.trim();

  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }

  key = key.replace(/\\n/g, '\n');

  if (!key.includes('BEGIN') && /^[A-Za-z0-9+/=\s]+$/.test(key)) {
    try {
      const decoded = Buffer.from(key, 'base64').toString('utf8').trim();
      if (decoded.includes('BEGIN')) {
        key = decoded;
      }
    } catch (error) {
      // Keep original key if decoding fails.
    }
  }

  return key;
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
