const axios = require("axios");
const functions = require("firebase-functions");

/**
 * Sends a Zendesk comment (public or private) for a given order.
 */
async function sendZendeskComment(orderData, subject, html_body, isPublic) {
    try {
        const zendeskUrl = functions.config().zendesk.url;
        const zendeskToken = functions.config().zendesk.token;
        if (!zendeskUrl || !zendeskToken) {
            console.warn("Zendesk configuration not complete. Cannot send notification.");
            return;
        }

        // Search for an existing ticket by subject
        const searchResponse = await axios.get(
            `${zendeskUrl}/search.json?query=type:ticket subject:"${subject}"`,
            {
                headers: { Authorization: `Basic ${zendeskToken}` },
            }
        );

        let ticketId = null;
        if (searchResponse.data.results.length > 0) {
            ticketId = searchResponse.data.results[0].id;
        }

        let payload;
        if (ticketId) {
            // Add a comment to an existing ticket
            payload = {
                ticket: {
                    comment: {
                        html_body: html_body,
                        public: isPublic,
                    },
                },
            };
            await axios.put(`${zendeskUrl}/tickets/${ticketId}.json`, payload, {
                headers: {
                    Authorization: `Basic ${zendeskToken}`,
                    "Content-Type": "application/json",
                },
            });
            console.log(`Zendesk comment added to existing ticket ${ticketId}.`);
        } else {
            // Create a new ticket
            payload = {
                ticket: {
                    subject: subject,
                    comment: {
                        html_body: html_body,
                        public: isPublic,
                    },
                    requester: {
                        name: orderData.shippingInfo.fullName,
                        email: orderData.shippingInfo.email,
                    },
                    tags: [`order_${orderData.id}`],
                    priority: "normal",
                },
            };
            await axios.post(`${zendeskUrl}/tickets.json`, payload, {
                headers: {
                    Authorization: `Basic ${zendeskToken}`,
                    "Content-Type": "application/json",
                },
            });
            console.log("New Zendesk ticket created.");
        }
    } catch (err) {
        console.error(
            "Failed to send Zendesk notification:",
            err.response?.data || err.message
        );
    }
}

module.exports = { sendZendeskComment };
