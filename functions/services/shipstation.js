const axios = require("axios");
const functions = require("firebase-functions");

let cachedCredentials;

function readShipStationConfig() {
    try {
        const config = functions.config?.() || functions.config();
        return config && typeof config === 'object' ? config.shipstation || {} : {};
    } catch (error) {
        return {};
    }
}

function getShipStationCredentials() {
    if (cachedCredentials !== undefined) {
        return cachedCredentials;
    }

    const config = readShipStationConfig();
    const key = process.env.SHIPSTATION_KEY || config?.key || null;
    const secret = process.env.SHIPSTATION_SECRET || config?.secret || null;

    if (key && secret) {
        cachedCredentials = { key, secret };
    } else {
        cachedCredentials = null;
    }

    return cachedCredentials;
}

function buildAuthHeader(credentials) {
    if (!credentials || !credentials.key || !credentials.secret) {
        throw new Error("ShipStation API credentials not configured. Please set 'shipstation.key' and 'shipstation.secret' environment variables.");
    }

    return `Basic ${Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')}`;
}

/**
 * Helper function to create a shipping label using the ShipStation API.
 */
async function createShipStationLabel(fromAddress, toAddress, carrierCode, serviceCode, packageCode = "package", weightInOunces = 8, testLabel = false, options = {}) {
    const credentials = options.credentials || getShipStationCredentials();

    if (!credentials) {
        throw new Error("ShipStation API credentials not configured. Please set 'shipstation.key' and 'shipstation.secret' environment variables.");
    }

    const authHeader = buildAuthHeader(credentials);
    const today = new Date().toISOString().split('T')[0];

    const payload = {
        carrierCode: carrierCode,
        serviceCode: serviceCode,
        packageCode: packageCode,
        shipDate: today,
        weight: {
            value: weightInOunces,
            units: "ounces"
        },
        shipFrom: fromAddress,
        shipTo: toAddress,
        testLabel: testLabel
    };

    try {
        const response = await axios.post("https://ssapi.shipstation.com/shipments/createlabel", payload, {
            headers: {
                "Authorization": authHeader,
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            timeout: 30000 // Add a 30-second timeout to prevent the function from hanging indefinitely
        });
        return response.data;
    } catch (error) {
        console.error("Error creating ShipStation label:", error.response?.data || error.message);
        throw new Error(`Failed to create ShipStation label: ${error.response?.data?.ExceptionMessage || error.message}`);
    }
}

async function fetchShipStationTracking({ trackingNumber, carrierCode, axiosClient = axios, credentials } = {}) {
    if (!trackingNumber) {
        throw new Error('Tracking number is required to request ShipStation tracking data.');
    }

    const authCredentials = credentials || getShipStationCredentials();
    if (!authCredentials) {
        throw new Error("ShipStation API credentials not configured. Please set 'shipstation.key' and 'shipstation.secret' environment variables.");
    }

    const params = { trackingNumber };
    if (carrierCode) {
        params.carrierCode = carrierCode;
    }

    const response = await axiosClient.get("https://ssapi.shipstation.com/shipments/tracking", {
        params,
        headers: {
            Authorization: buildAuthHeader(authCredentials),
            Accept: "application/json",
        },
        timeout: 30000,
    });

    return response?.data || null;
}

function normalizeTrackingEvent(event = {}) {
    if (!event || typeof event !== 'object') {
        return null;
    }

    const occurredAt = event.occurredAt || event.occurred_at || event.eventDate || event.event_date || null;
    const carrierOccurredAt = event.carrierOccurredAt || event.carrier_occurred_at || null;

    return {
        occurred_at: occurredAt || null,
        carrier_occurred_at: carrierOccurredAt || null,
        description: event.description || event.trackingStatus || event.statusDescription || null,
        city_locality: event.cityLocality || event.city_locality || event.city || null,
        state_province: event.stateProvince || event.state_province || event.state || null,
        postal_code: event.postalCode || event.postal_code || null,
        country_code: event.countryCode || event.country_code || null,
        company_name: event.companyName || event.company_name || null,
        signer: event.signer || null,
        event_code: event.eventCode || event.event_code || null,
        carrier_detail_code: event.carrierDetailCode || event.carrier_detail_code || null,
        status_code: event.statusCode || event.status_code || null,
        status_description: event.statusDescription || event.status_description || null,
        carrier_status_code: event.carrierStatusCode || event.carrier_status_code || null,
        carrier_status_description:
            event.carrierStatusDescription || event.carrier_status_description || null,
        latitude: event.latitude ?? null,
        longitude: event.longitude ?? null,
    };
}

function normalizeShipStationTracking(data) {
    if (!data || typeof data !== 'object') {
        return null;
    }

    const shipments = Array.isArray(data.shipments) ? data.shipments : [];
    const shipmentCandidate = shipments[0] || data.shipment || data;

    if (!shipmentCandidate || typeof shipmentCandidate !== 'object') {
        return null;
    }

    const eventsSource = Array.isArray(shipmentCandidate.events)
        ? shipmentCandidate.events
        : Array.isArray(shipmentCandidate.trackingEvents)
            ? shipmentCandidate.trackingEvents
            : [];

    const events = eventsSource
        .map((event) => normalizeTrackingEvent(event))
        .filter(Boolean);

    const trackingNumber =
        shipmentCandidate.trackingNumber ||
        shipmentCandidate.tracking_number ||
        data.trackingNumber ||
        data.tracking_number ||
        null;

    const statusCode =
        shipmentCandidate.statusCode ||
        shipmentCandidate.status_code ||
        shipmentCandidate.trackingStatusCode ||
        data.statusCode ||
        data.status_code ||
        null;

    const statusDescription =
        shipmentCandidate.statusDescription ||
        shipmentCandidate.status_description ||
        shipmentCandidate.trackingStatus ||
        data.statusDescription ||
        data.status_description ||
        null;

    const normalized = {
        tracking_number: trackingNumber,
        tracking_url:
            shipmentCandidate.trackingUrl ||
            shipmentCandidate.tracking_url ||
            data.trackingUrl ||
            data.tracking_url ||
            null,
        status_code: statusCode,
        status_description: statusDescription,
        carrier_code:
            shipmentCandidate.carrierCode ||
            shipmentCandidate.carrier_code ||
            data.carrierCode ||
            data.carrier_code ||
            null,
        carrier_status_code:
            shipmentCandidate.carrierStatusCode ||
            shipmentCandidate.carrier_status_code ||
            data.carrierStatusCode ||
            data.carrier_status_code ||
            null,
        carrier_status_description:
            shipmentCandidate.carrierStatusDescription ||
            shipmentCandidate.carrier_status_description ||
            data.carrierStatusDescription ||
            data.carrier_status_description ||
            null,
        ship_date: shipmentCandidate.shipDate || shipmentCandidate.ship_date || null,
        estimated_delivery_date:
            shipmentCandidate.estimatedDeliveryDate ||
            shipmentCandidate.estimated_delivery_date ||
            null,
        actual_delivery_date:
            shipmentCandidate.actualDeliveryDate ||
            shipmentCandidate.actual_delivery_date ||
            null,
        exception_description:
            shipmentCandidate.exceptionDescription ||
            shipmentCandidate.exception_description ||
            null,
        events,
        last_event: events.length ? events[0] : null,
    };

    if (shipmentCandidate.updatedAt || shipmentCandidate.updated_at) {
        normalized.updated_at = shipmentCandidate.updatedAt || shipmentCandidate.updated_at;
    } else if (data.updatedAt || data.updated_at) {
        normalized.updated_at = data.updatedAt || data.updated_at;
    } else if (events.length) {
        normalized.updated_at = events[0].occurred_at || events[0].carrier_occurred_at || null;
    }

    return normalized;
}

module.exports = {
    createShipStationLabel,
    getShipStationCredentials,
    fetchShipStationTracking,
    normalizeShipStationTracking,
};
