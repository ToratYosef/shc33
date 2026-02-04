const { getAuth } = require('firebase-admin/auth');
const auth = getAuth();
const { getFirestore } = require('firebase-admin/firestore');
const db = getFirestore();
const { adminsCollection } = require('../helpers/db');

// Authentication Middleware
const verifyFirebaseToken = async (req, res, next) => {
    // The /submit-order route is public, so we bypass the check for it.
    if (req.originalUrl.endsWith('/submit-order')) {
        return next();
    }
    
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.error('No Firebase ID token was passed as a Bearer token in the Authorization header.');
        return res.status(403).send('Unauthorized');
    }

    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        req.user = decodedToken;
        // Optional: Check if the user is an admin
        const adminDoc = await adminsCollection.doc(req.user.uid).get();
        if (!adminDoc.exists) {
            return res.status(403).send('Forbidden: User is not an admin.');
        }
        next();
    } catch (error) {
        console.error('Error while verifying Firebase ID token:', error);
        res.status(403).send('Unauthorized');
    }
};

module.exports = { verifyFirebaseToken };
