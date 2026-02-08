const nodemailer = require("nodemailer");
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const functions = require("firebase-functions");

const db = getFirestore();
const messaging = getMessaging();
const adminsCollection = db.collection("admins");

function firebaseNotificationsEnabled() {
    const raw = String(process.env.FIREBASE_NOTIFICATIONS_ENABLED || 'true').trim().toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(raw);
}

function toFcmData(obj = {}) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null) continue;
        out[String(k)] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
}

// Set up Nodemailer transporter using the Firebase Functions config
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: functions.config().email.user,
        pass: functions.config().email.pass,
    },
});

async function sendEmail(mailOptions) {
    try {
        await transporter.sendMail(mailOptions);
        console.log('Email sent successfully');
    } catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
}

async function sendAdminPushNotification(title, body, data = {}) {
    if (!firebaseNotificationsEnabled()) {
        console.warn('Skipping Firebase admin push notification; FIREBASE_NOTIFICATIONS_ENABLED is false.');
        return null;
    }

    try {
        const adminsSnapshot = await adminsCollection.get();
        const allTokens = [];

        for (const adminDoc of adminsSnapshot.docs) {
            const tokensSnapshot = await adminsCollection.doc(adminDoc.id).collection('fcmTokens').get();
            tokensSnapshot.forEach((doc) => {
                if (doc.id) {
                    allTokens.push(doc.id);
                }
            });
        }

        if (!allTokens.length) {
            console.log('No FCM tokens found for admins.');
            return null;
        }

        const message = {
            notification: { title, body },
            tokens: allTokens,
            data: toFcmData(data),
        };

        const response = await messaging.sendEachForMulticast(message);

        if (response.failureCount > 0) {
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    console.error(`Failed to send FCM to token ${allTokens[idx]}:`, resp.error?.message || resp.error);
                }
            });
        }

        return response;
    } catch (error) {
        console.error('Error sending FCM push notification:', error);
        return null;
    }
}

async function addAdminFirestoreNotification(adminUid, message, relatedDocType = null, relatedDocId = null, relatedUserId = null) {
    if (!firebaseNotificationsEnabled()) {
        console.warn('Skipping Firebase Firestore notification; FIREBASE_NOTIFICATIONS_ENABLED is false.');
        return null;
    }

    try {
        const createdAt = admin.firestore.FieldValue.serverTimestamp();

        if (adminUid) {
            await adminsCollection.doc(adminUid).collection('notifications').add({
                message,
                isRead: false,
                createdAt,
                relatedDocType,
                relatedDocId,
                relatedUserId,
            });
            return 1;
        }

        const adminsSnapshot = await adminsCollection.get();
        const writes = adminsSnapshot.docs.map((adminDoc) =>
            adminsCollection.doc(adminDoc.id).collection('notifications').add({
                message,
                isRead: false,
                createdAt,
                relatedDocType,
                relatedDocId,
                relatedUserId,
            })
        );

        await Promise.all(writes);
        return adminsSnapshot.size;
    } catch (error) {
        console.error('Error adding Firestore notifications:', error);
        return null;
    }
}

module.exports = {
    sendEmail,
    sendAdminPushNotification,
    addAdminFirestoreNotification,
};
