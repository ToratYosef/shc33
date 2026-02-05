const admin = require('firebase-admin');

function decodeBase64IfLikely(value) {
  if (!value || typeof value !== 'string') {
    return value;
  }

  const compact = value.replace(/\s+/g, '');
  if (!compact || compact.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(compact)) {
    return value;
  }

  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf8').trim();
    if (decoded) {
      return decoded;
    }
  } catch (error) {
    // Keep original input when decode fails.
  }

  return value;
}

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

  key = key.replace(/\\r/g, '');
  key = key.replace(/\\n/g, '\n');

  if (!key.includes('BEGIN')) {
    const decoded = decodeBase64IfLikely(key);
    if (decoded && decoded !== key) {
      key = decoded;
      key = key.replace(/\\r/g, '');
      key = key.replace(/\\n/g, '\n');
    }
  }

  return key;
}

function getServiceAccountFromEnv() {
  const jsonSources = [
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
  ].filter(Boolean);

  for (const source of jsonSources) {
    const candidate = decodeBase64IfLikely(String(source).trim());
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (error) {
      // Try next source.
    }
  }

  return null;
}

function initFirebaseAdmin() {
  if (admin.apps.length) {
    return admin.app();
  }

  const serviceAccount = getServiceAccountFromEnv();

  const projectId =
    serviceAccount?.project_id ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT;

  const clientEmail =
    serviceAccount?.client_email ||
    process.env.FIREBASE_CLIENT_EMAIL ||
    process.env.GOOGLE_CLIENT_EMAIL;

  const privateKey = normalizePrivateKey(
    serviceAccount?.private_key ||
    process.env.FIREBASE_PRIVATE_KEY ||
    process.env.GOOGLE_PRIVATE_KEY
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
