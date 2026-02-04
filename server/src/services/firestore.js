const admin = require('firebase-admin');

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
    const privateKey = FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
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
