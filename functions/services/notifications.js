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

function stringifyData(obj = {}) {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value === undefined || value === null) {
            continue;
        }
        out[String(key)] = typeof value === 'string' ? value : String(value);
    }
    return out;
}

function isInvalidFcmToken(error) {
    const code = error?.code || error?.errorInfo?.code;
    const message = String(error?.message || '').toLowerCase();
    return (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token' ||
        message.includes('notregistered') ||
        message.includes('requested entity was not found')
    );
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
        const tokenEntries = [];

        for (const adminDoc of adminsSnapshot.docs) {
            const tokensSnapshot = await adminsCollection.doc(adminDoc.id).collection('fcmTokens').get();
            tokensSnapshot.forEach((doc) => {
                const data = doc.data() || {};
                const token = data.token || doc.id;
                if (token) {
                    tokenEntries.push({ token, ref: doc.ref });
                }
            });
        }

        if (!tokenEntries.length) {
            console.log('No FCM tokens found for admins.');
            return null;
        }

        const response = await messaging.sendEachForMulticast({
            notification: { title, body },
            data: stringifyData(data),
            tokens: tokenEntries.map((entry) => entry.token),
        });

        if (response.failureCount > 0) {
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    console.error(`Failed to send FCM to token ${tokenEntries[idx].token}:`, resp.error?.message || resp.error);
                    if (isInvalidFcmToken(resp.error)) {
                        tokenEntries[idx].ref.delete().catch((deleteError) => {
                            console.error('Failed to delete invalid FCM token document:', deleteError);
                        });
                    }
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
