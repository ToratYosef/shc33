const { createPrivateKey } = require('crypto');
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

function normalizeScalarEnv(value) {
  if (typeof value !== 'string') {
    return value || null;
  }

  const normalized = stripWrappingQuotes(value);
  return normalized || null;
}

function decodeBase64Utf8(value) {
  if (!value || typeof value !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(value)) {
    return null;
  }

  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8').trim();
    return decoded || null;
  } catch (error) {
    return null;
  }
}

function parseJsonIfPossible(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function parseServiceAccountPayload(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return null;
  }

  const normalizedRaw = stripWrappingQuotes(rawValue);
  const directJson = parseJsonIfPossible(normalizedRaw);
  if (directJson && typeof directJson === 'object') {
    return directJson;
  }

  const decoded = decodeBase64Utf8(normalizedRaw);
  if (!decoded) {
    return null;
  }

  const decodedJson = parseJsonIfPossible(decoded);
  if (decodedJson && typeof decodedJson === 'object') {
    return decodedJson;
  }

  return null;
}

function normalizePrivateKey(privateKeyValue) {
  if (!privateKeyValue || typeof privateKeyValue !== 'string') {
    return null;
  }

  let key = stripWrappingQuotes(privateKeyValue);
  key = key.replace(/\\n/g, '\n').replace(/\\r/g, '\r');

  const jsonPayload = parseJsonIfPossible(key) || parseJsonIfPossible(decodeBase64Utf8(key));
  if (jsonPayload && typeof jsonPayload.private_key === 'string') {
    key = jsonPayload.private_key;
    key = key.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  }

  return stripWrappingQuotes(key);
}

function isValidPrivateKey(privateKey) {
  if (!privateKey || typeof privateKey !== 'string') {
    return false;
  }

  try {
    createPrivateKey({ key: privateKey, format: 'pem' });
    return true;
  } catch (error) {
    return false;
  }
}

function resolveExplicitServiceAccount() {
  const serviceAccountPayload =
    parseServiceAccountPayload(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) ||
    parseServiceAccountPayload(process.env.FIREBASE_SERVICE_ACCOUNT) ||
    parseServiceAccountPayload(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

  if (!serviceAccountPayload) {
    return null;
  }

  const projectId = normalizeScalarEnv(serviceAccountPayload.project_id);
  const clientEmail = normalizeScalarEnv(serviceAccountPayload.client_email);
  const privateKey = normalizePrivateKey(serviceAccountPayload.private_key);

  if (!projectId || !clientEmail || !isValidPrivateKey(privateKey)) {
    return null;
  }

  return {
    projectId,
    clientEmail,
    privateKey,
  };
}

function initFirebaseAdmin() {
  if (admin.apps.length) {
    return admin.app();
  }

  const storageBucket = normalizeScalarEnv(process.env.FIREBASE_STORAGE_BUCKET) || undefined;

  const envProjectId =
    normalizeScalarEnv(process.env.FIREBASE_PROJECT_ID) ||
    normalizeScalarEnv(process.env.GCLOUD_PROJECT) ||
    normalizeScalarEnv(process.env.GCP_PROJECT);
  const envClientEmail =
    normalizeScalarEnv(process.env.FIREBASE_CLIENT_EMAIL) ||
    normalizeScalarEnv(process.env.GOOGLE_CLIENT_EMAIL);
  const envPrivateKey = normalizePrivateKey(
    process.env.FIREBASE_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY
  );

  const explicitServiceAccount =
    resolveExplicitServiceAccount() ||
    (envProjectId && envClientEmail && isValidPrivateKey(envPrivateKey)
      ? {
          projectId: envProjectId,
          clientEmail: envClientEmail,
          privateKey: envPrivateKey,
        }
      : null);

  if (explicitServiceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(explicitServiceAccount),
      storageBucket,
    });
    return admin.app();
  }

  if (envProjectId || envClientEmail || envPrivateKey) {
    console.warn(
      'Firebase credential environment variables were provided but could not be parsed as a valid service account key. Falling back to Application Default Credentials.'
    );
  }

  admin.initializeApp({ storageBucket });
  return admin.app();
}

module.exports = {
  admin,
  initFirebaseAdmin,
  normalizePrivateKey,
};
