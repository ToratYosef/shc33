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

// Set up Nodemailer transporter using the Firebase Functions config
function createEmailTransportConfig({ pooled = true } = {}) {
    const config = {
        service: 'gmail',
        pool: pooled,
        maxConnections: Number(process.env.EMAIL_MAX_CONNECTIONS || 5),
        maxMessages: Number(process.env.EMAIL_MAX_MESSAGES || 100),
        connectionTimeout: Number(process.env.EMAIL_CONNECTION_TIMEOUT_MS || 8000),
        greetingTimeout: Number(process.env.EMAIL_GREETING_TIMEOUT_MS || 8000),
        socketTimeout: Number(process.env.EMAIL_SOCKET_TIMEOUT_MS || 15000),
        auth: {
            user: functions.config().email.user,
            pass: functions.config().email.pass,
        },
    };

    return config;
}

const transporter = nodemailer.createTransport(createEmailTransportConfig({ pooled: true }));

async function sendMailWithFallback(mailOptions) {
    try {
        return await transporter.sendMail(mailOptions);
    } catch (error) {
        const isTimeout = error && (error.code === 'ETIMEDOUT' || error.command === 'CONN');
        if (!isTimeout) {
            throw error;
        }

        console.error('Primary SMTP attempt timed out; retrying with fresh Gmail transport.', {
            code: error.code,
            command: error.command,
            message: error.message,
        });

        const retryTransporter = nodemailer.createTransport(
            createEmailTransportConfig({ pooled: false })
        );
        return retryTransporter.sendMail(mailOptions);
    }
}

async function sendEmail(mailOptions) {
    try {
        await sendMailWithFallback(mailOptions);
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

        const response = await messaging.sendEachForMulticast({
            notification: { title, body },
            data,
            tokens: allTokens,
        });

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
