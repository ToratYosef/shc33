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

function loadEmailConfig() {
    let firebaseEmailConfig = {};
    try {
        firebaseEmailConfig = functions.config()?.email || {};
    } catch (error) {
        console.warn("Unable to read Firebase email config:", error.message);
    }

    const rawPass = process.env.EMAIL_PASS ?? firebaseEmailConfig.pass ?? "";
    const sanitizedPass = rawPass ? String(rawPass).replace(/\s+/g, "") : "";

    return {
        user: String(process.env.EMAIL_USER ?? firebaseEmailConfig.user ?? "").trim(),
        pass: sanitizedPass,
        service: String(process.env.SMTP_SERVICE ?? firebaseEmailConfig.service ?? "").trim(),
        host: String(process.env.SMTP_HOST ?? firebaseEmailConfig.host ?? "").trim(),
        port: String(process.env.SMTP_PORT ?? firebaseEmailConfig.port ?? "").trim(),
        secure: String(process.env.SMTP_SECURE ?? firebaseEmailConfig.secure ?? "").trim(),
    };
}

function parseBoolean(value) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
        return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
        return false;
    }
    return undefined;
}

const emailConfig = loadEmailConfig();
const defaultEmailHost = "smtp.gmail.com";
const resolvedEmailHost = emailConfig.host || defaultEmailHost;
const resolvedEmailPort = Number(
    emailConfig.port ||
        (resolvedEmailHost === "smtp.gmail.com" ? 465 : 587)
);
const resolvedEmailSecure =
    parseBoolean(emailConfig.secure) ??
    (resolvedEmailPort === 465);
const resolvedEmailService =
    emailConfig.service ||
    (resolvedEmailHost === "smtp.gmail.com" ? "gmail" : "");

const transporter = nodemailer.createTransport({
    ...(resolvedEmailService ? { service: resolvedEmailService } : {}),
    host: resolvedEmailHost,
    port: resolvedEmailPort,
    secure: resolvedEmailSecure,
    auth: emailConfig.user && emailConfig.pass ? {
        user: emailConfig.user,
        pass: emailConfig.pass,
    } : undefined,
    connectionTimeout: Number(process.env.EMAIL_CONNECTION_TIMEOUT_MS || 10000),
    greetingTimeout: Number(process.env.EMAIL_GREETING_TIMEOUT_MS || 10000),
    socketTimeout: Number(process.env.EMAIL_SOCKET_TIMEOUT_MS || 20000),
    tls: {
        servername: resolvedEmailHost,
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
