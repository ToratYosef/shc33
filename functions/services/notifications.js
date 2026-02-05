const nodemailer = require("nodemailer");
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const functions = require("firebase-functions");

const db = getFirestore();
const messaging = getMessaging();
const adminsCollection = db.collection("admins");

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
        throw error; // Re-throw the error to be handled by the caller
    }
}

async function sendAdminPushNotification(title, body, data = {}) {
    console.warn(
        "Skipping Firebase admin push notification; Firebase notifications are disabled."
    );
    return null;
}

async function addAdminFirestoreNotification(message, relatedDocType = null, relatedDocId = null, relatedUserId = null) {
    console.warn(
        "Skipping Firebase Firestore notification; Firebase notifications are disabled."
    );
    return null;
}

module.exports = {
    sendEmail,
    sendAdminPushNotification,
    addAdminFirestoreNotification,
};
