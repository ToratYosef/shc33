const { getFirestore } = require('firebase-admin/firestore');
const db = getFirestore();
const { ordersCollection } = require('../db/db');

/**
 * Generates the next sequential order number in SHC-XXXXX format using a Firestore transaction.
 * Starts at SHC-30000 and increments by 1 per order.
 * @returns {Promise<string>} The next unique, sequential order number (e.g., "SHC-30000", then "SHC-30001").
 */
async function generateNextOrderNumber() {
    const counterRef = db.collection("counters").doc("orders");
    const orderNumberStart = 30000;
    const counterFloor = orderNumberStart + 1;

    try {
        const nextOrderNumber = await db.runTransaction(async (transaction) => {
            const counterDoc = await transaction.get(counterRef);
            const rawCurrent = Number(counterDoc.data()?.currentNumber);
            const currentValue = Number.isFinite(rawCurrent) ? rawCurrent : 0;
            const nextValue = Math.max(currentValue + 1, counterFloor);

            transaction.set(
                counterRef,
                { currentNumber: nextValue },
                { merge: true }
            );

            return nextValue - 1;
        });

        const paddedNumber = String(nextOrderNumber).padStart(5, "0");
        return `SHC-${paddedNumber}`;
    } catch (e) {
        console.error("Transaction to generate order number failed:", e);
        throw new Error("Failed to generate a unique order number. Please try again.");
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