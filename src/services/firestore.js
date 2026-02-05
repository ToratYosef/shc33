const { admin, initFirebaseAdmin } = require('../../functions/helpers/firebaseAdmin');

initFirebaseAdmin();

const db = admin.firestore();

module.exports = { admin, db };
