// Import the Firebase Admin SDK
const admin = require('firebase-admin');

// --- IMPORTANT ---
// 1. Download your service account key JSON file from Firebase Project Settings
// 2. Place it in the same directory as this script
// 3. Rename it to 'service-account-key.json'
const serviceAccount = require('/workspaces/BuyBacking/admin/serviceAccountKey.json');

// --- PASTE THE USER UID HERE ---
const uidToMakeAdmin = 'IAq7dIQVREYUwo9udfX338Aqbwj1';

// Initialize the app
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Set the custom claim { admin: true } for the specified user
admin.auth().setCustomUserClaims(uidToMakeAdmin, { admin: true })
  .then(() => {
    console.log(`✅ Success! User ${uidToMakeAdmin} is now an admin.`);
    // End the script process
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error setting custom claims:', error);
    process.exit(1);
  });