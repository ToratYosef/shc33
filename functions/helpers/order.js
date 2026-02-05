const { getFirestore } = require('firebase-admin/firestore');
const db = getFirestore();
const { randomUUID } = require('crypto');
const { ordersCollection } = require('../db/db');

/**
 * Generates the next sequential order number in SHC-XXXXX format using a Firestore transaction.
 * Starts at SHC-30000 and increments by 1 per order.
 * @returns {Promise<string>} The next unique, sequential order number (e.g., "SHC-30000", then "SHC-30001").
 */
async function generateNextOrderNumber() {
    const counterRef = db.collection("counters").doc("ordersCurrentNumber");
    const orderNumberStart = 30000;

    try {
        const newOrderNumber = await db.runTransaction(async (transaction) => {
            const counterDoc = await transaction.get(counterRef);

            const currentNumber = counterDoc.exists
                ? counterDoc.data().currentNumber ?? orderNumberStart
                : orderNumberStart;

            transaction.set(
                counterRef,
                { currentNumber: currentNumber + 1 },
                { merge: true }
            );

            const paddedNumber = String(currentNumber).padStart(5, "0");
            return `SHC-${paddedNumber}`;
        });

        return newOrderNumber;
    } catch (e) {
        console.error("Transaction to generate order number failed:", e);

        const fallbackOrderId = `SHC-FB-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`;
        console.warn(
            "Falling back to non-sequential order ID due to counter transaction failure:",
            fallbackOrderId
        );
        return fallbackOrderId;
    }
}

function formatStatusForEmail(status) {
    if (status === "order_pending") return "Order Pending";
    if (status === "shipping_kit_requested" || status === "kit_needs_printing" || status === "needs_printing") return "Needs Printing";
    if (status === "kit_sent") return "Kit Sent";
    if (status === "kit_delivered") return "Kit Delivered";
    return status
        .replace(/_/g, " ")
        .split(" ")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

module.exports = { generateNextOrderNumber, formatStatusForEmail };