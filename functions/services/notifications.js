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
    try {
        const adminsSnapshot = await adminsCollection.get();
        let allTokens = [];

        for (const adminDoc of adminsSnapshot.docs) {
            const adminUid = adminDoc.id;
            const fcmTokensRef = adminsCollection.doc(adminUid).collection("fcmTokens");
            const tokensSnapshot = await fcmTokensRef.get();
            tokensSnapshot.forEach((doc) => {
                allTokens.push(doc.id); // doc.id is the FCM token itself
            });
        }

        if (allTokens.length === 0) {
            console.log("No FCM tokens found for any admin. Cannot send push notification.");
            return;
        }

        const message = {
            notification: {
                title: title,
                body: body,
            },
            data: data, // Custom data payload
            tokens: allTokens,
        };

        const response = await messaging.sendEachForMulticast(message);
        console.log("Successfully sent FCM messages:", response.successCount, "failures:", response.failureCount);
        if (response.failureCount > 0) {
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    console.error(`Failed to send FCM to token ${allTokens[idx]}: ${resp.error}`);
                }
            });
        }
    } catch (error) {
        console.error("Error sending FCM push notification:", error);
    }
}

async function addAdminFirestoreNotification(message, relatedDocType = null, relatedDocId = null, relatedUserId = null) {
    try {
        const adminsSnapshot = await adminsCollection.get();
        const promises = adminsSnapshot.docs.map(async (adminDoc) => {
            const notificationsCollectionRef = adminsCollection.doc(adminDoc.id).collection("notifications");
            await notificationsCollectionRef.add({
                message: message,
                isRead: false,
                createdAt: db.FieldValue.serverTimestamp(),
                relatedDocType: relatedDocType,
                relatedDocId: relatedDocId,
                relatedUserId: relatedUserId,
            });
        });
        await Promise.all(promises);
        console.log(`Firestore notifications added for all admins.`);
    } catch (error) {
        console.error("Error adding Firestore notifications:", error);
    }
}

module.exports = {
    sendEmail,
    sendAdminPushNotification,
    addAdminFirestoreNotification,
};
