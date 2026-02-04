const { getFirestore } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
const { randomUUID } = require('crypto');

const db = getFirestore();

const ordersCollection = db.collection("orders");
const usersCollection = db.collection("users");
const adminsCollection = db.collection("admins");

function formatStatusLabel(value) {
    if (!value) return "";
    return String(value)
        .replace(/[_-]+/g, " ")
        .trim()
        .replace(/\s+/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeLogEntries(entries = []) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return [];
    }

    return entries
        .filter(Boolean)
        .map((entry) => {
            const atValue = entry.at;
            let timestamp;

            if (atValue instanceof admin.firestore.Timestamp) {
                timestamp = atValue;
            } else if (atValue instanceof Date) {
                timestamp = admin.firestore.Timestamp.fromDate(atValue);
            } else if (atValue && typeof atValue === 'object' && typeof atValue.seconds === 'number') {
                timestamp = new admin.firestore.Timestamp(atValue.seconds, atValue.nanoseconds || 0);
            } else {
                timestamp = admin.firestore.Timestamp.now();
            }

            return {
                id: entry.id || randomUUID(),
                type: entry.type || 'update',
                message: entry.message || '',
                metadata: entry.metadata ?? null,
                at: timestamp,
            };
        });
}

/**
 * Write & update in BOTH locations:
 * 1) Top-level /orders/{orderId}
 * 2) If userId present: /users/{userId}/orders/{orderId}
 */
async function writeOrderBoth(orderId, data) {
    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    const dataToWrite = { ...data, updatedAt: timestamp };

    if (data.status !== undefined && data.lastStatusUpdateAt === undefined) {
        dataToWrite.lastStatusUpdateAt = timestamp;
    }

    await ordersCollection.doc(orderId).set(dataToWrite);
    if (data.userId) {
        await usersCollection.doc(data.userId).collection("orders").doc(orderId).set(dataToWrite);
    }
}

async function updateOrderBoth(orderId, partialData = {}, options = {}) {
    const orderRef = ordersCollection.doc(orderId);
    const existingSnap = await orderRef.get();
    const existing = existingSnap.data() || {};
    const userId = existing.userId;

    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    const dataToMerge = { ...partialData, updatedAt: timestamp };

    const statusProvided = Object.prototype.hasOwnProperty.call(partialData, 'status');

    if (statusProvided && options.skipStatusTimestamp !== true) {
        dataToMerge.lastStatusUpdateAt = timestamp;
    }

    let logEntries = [];

    if (statusProvided && existing.status !== partialData.status && options.autoLogStatus !== false) {
        logEntries.push({
            type: 'status',
            message: `Status changed to ${formatStatusLabel(partialData.status)}`,
            metadata: { status: partialData.status },
        });
    }

    if (Array.isArray(options.logEntries)) {
        logEntries = logEntries.concat(options.logEntries);
    }

    const normalizedLogs = normalizeLogEntries(logEntries);
    if (normalizedLogs.length) {
        dataToMerge.activityLog = admin.firestore.FieldValue.arrayUnion(...normalizedLogs);
    }

    await orderRef.set(dataToMerge, { merge: true });

    if (userId) {
        const userUpdate = { ...dataToMerge };
        if (normalizedLogs.length) {
            userUpdate.activityLog = admin.firestore.FieldValue.arrayUnion(...normalizedLogs);
        }

        await usersCollection.doc(userId).collection("orders").doc(orderId).set(userUpdate, { merge: true });
    }

    const updatedSnap = await orderRef.get();
    const updated = updatedSnap.data() || {};

    return { order: { id: orderId, ...updated }, userId };
}

module.exports = { writeOrderBoth, updateOrderBoth, ordersCollection, usersCollection, adminsCollection };
