const axios = require('axios');
const {
    getShipStationCredentials,
    fetchShipStationTracking,
    normalizeShipStationTracking,
} = require('../services/shipstation');

const DEFAULT_CARRIER_CODE = 'stamps_com';
const KIT_TRANSIT_STATUS = 'kit_on_the_way_to_customer';
const PHONE_TRANSIT_STATUS = 'phone_on_the_way';
const PHONE_TRANSIT_STATUS_LEGACY = 'phone_on_the_way_to_us';

const TRANSIT_STATUS_CODES = new Set([
    'IT',
    'OF',
    'AC',
    'AT',
    'NY',
    'SP',
    'PU',
    'OC',
    'OD',
    'OP',
    'PC',
    'SC',
    'AR',
    'AP',
    'IP',
]);

const INBOUND_STATUS_ALIASES = new Map([
    ['DELIVERED', 'DELIVERED'],
    ['DELIVERED_TO_AGENT', 'DELIVERED_TO_AGENT'],
    ['DELIVERED TO AGENT', 'DELIVERED_TO_AGENT'],
    ['DE', 'DELIVERED'],
    ['DL', 'DELIVERED'],
    ['SP', 'DELIVERED_TO_AGENT'],
    ['IT', 'IN_TRANSIT'],
    ['IN_TRANSIT', 'IN_TRANSIT'],
    ['NT', 'IN_TRANSIT'],
    ['OF', 'OUT_FOR_DELIVERY'],
    ['OD', 'OUT_FOR_DELIVERY'],
    ['OUT_FOR_DELIVERY', 'OUT_FOR_DELIVERY'],
    ['AC', 'ACCEPTED'],
    ['SHIPMENT_ACCEPTED', 'SHIPMENT_ACCEPTED'],
    ['OC', 'SHIPMENT_ACCEPTED'],
    ['AT', 'DELIVERY_ATTEMPT'],
    ['NY', 'NOT_YET_IN_SYSTEM'],
    ['OP', 'IN_TRANSIT'],
    ['PC', 'IN_TRANSIT'],
    ['SC', 'IN_TRANSIT'],
    ['AR', 'IN_TRANSIT'],
    ['AP', 'IN_TRANSIT'],
    ['IP', 'IN_TRANSIT'],
    ['PU', 'IN_TRANSIT'],
    ['LA', 'LABEL_CREATED'],
    ['LB', 'LABEL_CREATED'],
    ['LABEL_CREATED', 'LABEL_CREATED'],
    ['UNKNOWN', 'UNKNOWN'],
    ['UN', 'UNKNOWN'],
]);

const TRANSIT_KEYWORDS = [
    'in transit',
    'out for delivery',
    'on its way',
    'acceptance',
    'shipment received',
    'arrived at',
    'departed',
    'processed at',
    'moving through',
    'package acceptance',
];

function resolveInboundTransitResetStatus(order = {}) {
    const shippingPreference = String(order?.shippingPreference || '').toLowerCase();

    if (shippingPreference === 'shipping kit requested') {
        if (order?.kitDeliveredAt) {
            return 'kit_delivered';
        }

        if (order?.kitSentAt) {
            return 'kit_sent';
        }

        return 'kit_sent';
    }

    return 'label_generated';
}

function normalizeCarrierCode(code) {
    if (!code || typeof code !== 'string') {
        return null;
    }
    const trimmed = code.trim();
    return trimmed ? trimmed : null;
}

function findCarrierCodeInLabels(labels) {
    if (!labels || typeof labels !== 'object') {
        return null;
    }

    for (const value of Object.values(labels)) {
        if (!value || typeof value !== 'object') {
            continue;
        }

        const direct =
            normalizeCarrierCode(value.carrier_code) || normalizeCarrierCode(value.carrierCode);
        if (direct) {
            return direct;
        }

        const shipmentCarrier =
            normalizeCarrierCode(value.shipment?.carrier_code) ||
            normalizeCarrierCode(value.shipment?.carrierCode);
        if (shipmentCarrier) {
            return shipmentCarrier;
        }
    }

    return null;
}

function resolveCarrierCode(order = {}, direction = 'outbound', defaultCarrierCode = DEFAULT_CARRIER_CODE) {
    const candidates = [];

    if (direction === 'inbound') {
        candidates.push(order?.inboundCarrierCode);
        candidates.push(order?.labelTrackingCarrierCode);
    } else {
        candidates.push(order?.outboundCarrierCode);
    }

    const shipEngineLabels = order?.shipEngineLabels;
    if (shipEngineLabels && typeof shipEngineLabels === 'object') {
        if (direction === 'inbound') {
            candidates.push(shipEngineLabels.inbound?.shipment?.carrier_code);
            candidates.push(shipEngineLabels.inbound?.shipment?.carrierCode);
            candidates.push(shipEngineLabels.customer?.shipment?.carrier_code);
            candidates.push(shipEngineLabels.customer?.shipment?.carrierCode);
            candidates.push(shipEngineLabels.return?.shipment?.carrier_code);
            candidates.push(shipEngineLabels.return?.shipment?.carrierCode);
        } else {
            candidates.push(shipEngineLabels.outbound?.shipment?.carrier_code);
            candidates.push(shipEngineLabels.outbound?.shipment?.carrierCode);
            candidates.push(shipEngineLabels.kit?.shipment?.carrier_code);
            candidates.push(shipEngineLabels.kit?.shipment?.carrierCode);
        }

        candidates.push(shipEngineLabels.primary?.shipment?.carrier_code);
        candidates.push(shipEngineLabels.primary?.shipment?.carrierCode);
    }

    const directCandidate = candidates
        .map((value) => normalizeCarrierCode(value))
        .find(Boolean);

    if (directCandidate) {
        return directCandidate;
    }

    const labelCandidate = findCarrierCodeInLabels(shipEngineLabels);
    return labelCandidate || defaultCarrierCode;
}

function buildTrackingUrl({ trackingNumber, carrierCode, defaultCarrierCode = DEFAULT_CARRIER_CODE }) {
    if (!trackingNumber) {
        throw new Error('Tracking number is required to build a ShipEngine tracking URL.');
    }

    const normalizedCarrier = normalizeCarrierCode(carrierCode) || normalizeCarrierCode(defaultCarrierCode);
    if (!normalizedCarrier) {
        throw new Error('Carrier code is required to build a ShipEngine tracking URL.');
    }

    return `https://api.shipengine.com/v1/tracking?carrier_code=${encodeURIComponent(
        normalizedCarrier
    )}&tracking_number=${encodeURIComponent(trackingNumber)}`;
}

const INBOUND_TRACKING_STATUSES = new Set([
    'kit_delivered',
    KIT_TRANSIT_STATUS,
    'kit_on_the_way_to_us',
    'delivered_to_us',
    'label_generated',
    'emailed',
    'received',
    PHONE_TRANSIT_STATUS,
    PHONE_TRANSIT_STATUS_LEGACY,
    'completed',
    're-offered-pending',
    're-offered-accepted',
    're-offered-declined',
    're-offered-auto-accepted',
    'return-label-generated',
    'requote_accepted',
]);

function extractTrackingFields(trackingData = {}) {
    const statusCode = trackingData.status_code || trackingData.statusCode || null;
    const statusDescription =
        trackingData.status_description ||
        trackingData.statusDescription ||
        trackingData.carrier_status_description ||
        '';

    const normalizedDescription = statusDescription ? statusDescription.toLowerCase() : '';
    const delivered = statusCode === 'DE' || normalizedDescription.includes('delivered');

    return {
        delivered,
        statusCode,
        statusDescription,
        lastUpdated: trackingData.updated_at || trackingData.last_event?.occurred_at || null,
        estimatedDelivery: trackingData.estimated_delivery_date || null,
    };
}

function isTransitStatus(statusCode, statusDescription, estimatedDelivery) {
    const normalizedCode = statusCode ? String(statusCode).toUpperCase() : '';
    const hasEstimatedDelivery = Boolean(estimatedDelivery);

    if (normalizedCode === 'AC' && !hasEstimatedDelivery) {
        return false;
    }

    if (TRANSIT_STATUS_CODES.has(normalizedCode)) {
        return true;
    }

    const description = typeof statusDescription === 'string' ? statusDescription.toLowerCase() : '';
    if (!description) {
        return false;
    }

    if (!hasEstimatedDelivery && /\baccept(ed|ance)\b/.test(description)) {
        return false;
    }

    if (description.includes('delivered') || description.includes('delivery complete')) {
        return false;
    }

    return TRANSIT_KEYWORDS.some((keyword) => description.includes(keyword));
}

function isAcceptedWithoutEta(statusCode, statusDescription, estimatedDelivery) {
    if (estimatedDelivery) {
        return false;
    }

    const normalizedCode = statusCode ? String(statusCode).toUpperCase() : '';
    if (normalizedCode === 'AC' || normalizedCode === 'SHIPMENT_ACCEPTED') {
        return true;
    }

    const description = typeof statusDescription === 'string' ? statusDescription.toLowerCase() : '';
    return Boolean(description && /\baccept(ed|ance)\b/.test(description));
}

async function fetchTrackingData({
    axiosClient = axios,
    trackingNumber,
    carrierCode,
    defaultCarrierCode = DEFAULT_CARRIER_CODE,
    shipengineKey,
    shipstationCredentials,
}) {
    if (!trackingNumber) {
        throw new Error('Tracking number not available for this order');
    }

    const credentials = shipstationCredentials || getShipStationCredentials();
    const errors = [];

    if (credentials) {
        try {
            const response = await fetchShipStationTracking({
                trackingNumber,
                carrierCode,
                axiosClient,
                credentials,
            });
            const normalized = normalizeShipStationTracking(response);
            if (normalized) {
                return normalized;
            }
        } catch (error) {
            errors.push(error);
        }
    }

    if (shipengineKey) {
        const trackingUrl = buildTrackingUrl({
            trackingNumber,
            carrierCode,
            defaultCarrierCode,
        });

        const response = await axiosClient.get(trackingUrl, {
            headers: {
                'API-Key': shipengineKey,
            },
            timeout: 20000,
        });

        return response?.data || {};
    }

    if (errors.length) {
        throw errors[0];
    }

    throw new Error('ShipEngine or ShipStation API credentials are required to fetch tracking data.');
}

async function buildKitTrackingUpdate(
    order,
    {
        axiosClient = axios,
        shipengineKey,
        shipstationCredentials,
        defaultCarrierCode = DEFAULT_CARRIER_CODE,
        serverTimestamp,
    } = {}
) {
    const hasOutbound = Boolean(order?.outboundTrackingNumber);
    const hasInbound = Boolean(order?.inboundTrackingNumber || order?.trackingNumber);

    if (!hasOutbound && !hasInbound) {
        throw new Error('Tracking number not available for this order');
    }

    const credentials = shipstationCredentials || getShipStationCredentials();

    if (!shipengineKey && !credentials) {
        throw new Error('ShipEngine or ShipStation API credentials not configured');
    }

    const normalizedStatus = String(order?.status || '').toLowerCase();
    const normalizedTransitStatus =
        normalizedStatus === PHONE_TRANSIT_STATUS_LEGACY ? PHONE_TRANSIT_STATUS : normalizedStatus;
    const prefersInbound =
        hasInbound &&
        (String(order?.kitTrackingStatus?.direction || '').toLowerCase() === 'inbound' ||
            INBOUND_TRACKING_STATUSES.has(normalizedTransitStatus));

    const useInbound = (!hasOutbound && hasInbound) || prefersInbound;
    const trackingNumber = useInbound
        ? order.inboundTrackingNumber || order.trackingNumber
        : order.outboundTrackingNumber;

    if (!trackingNumber) {
        throw new Error('Tracking number not available for this order');
    }

    const carrierCode = resolveCarrierCode(order, useInbound ? 'inbound' : 'outbound', defaultCarrierCode);
    const trackingData = await fetchTrackingData({
        axiosClient,
        trackingNumber,
        carrierCode,
        defaultCarrierCode,
        shipengineKey,
        shipstationCredentials: credentials,
    });
    const {
        delivered,
        statusCode,
        statusDescription,
        lastUpdated,
        estimatedDelivery,
    } = extractTrackingFields(trackingData);
    const inTransit = isTransitStatus(statusCode, statusDescription, estimatedDelivery);
    const acceptedWithoutEta = isAcceptedWithoutEta(statusCode, statusDescription, estimatedDelivery);

    const direction = useInbound ? 'inbound' : 'outbound';
    const statusPayload = {
        statusCode,
        statusDescription,
        carrierCode,
        lastUpdated,
        estimatedDelivery,
        trackingNumber,
        direction,
    };

    const updatePayload = {
        kitTrackingStatus: statusPayload,
    };

    if (normalizedStatus === PHONE_TRANSIT_STATUS_LEGACY) {
        updatePayload.status = PHONE_TRANSIT_STATUS;
    }

    const shippingPreference = String(order?.shippingPreference || '').toLowerCase();
    const isShippingKit = shippingPreference === 'shipping kit requested';

    const hasMovement = inTransit || acceptedWithoutEta;
    const inboundBaseStatus = resolveInboundTransitResetStatus(order);

    if (!useInbound) {
        if (delivered) {
            updatePayload.status = 'kit_delivered';
            if (typeof serverTimestamp === 'function') {
                updatePayload.kitDeliveredAt = serverTimestamp();
                updatePayload.lastStatusUpdateAt = serverTimestamp();
            }
        } else if (hasMovement) {
            updatePayload.status = KIT_TRANSIT_STATUS;
            if (typeof serverTimestamp === 'function') {
                updatePayload.lastStatusUpdateAt = serverTimestamp();
            }
            if (!order?.kitSentAt && typeof serverTimestamp === 'function') {
                updatePayload.kitSentAt = serverTimestamp();
            }
        } else if (normalizedStatus !== 'kit_sent') {
            updatePayload.status = 'kit_sent';
            if (typeof serverTimestamp === 'function') {
                updatePayload.lastStatusUpdateAt = serverTimestamp();
            }
            if (!order?.kitSentAt && typeof serverTimestamp === 'function') {
                updatePayload.kitSentAt = serverTimestamp();
            }
        }
    } else {
        if (delivered) {
            updatePayload.status = 'delivered_to_us';
            if (typeof serverTimestamp === 'function') {
                updatePayload.lastStatusUpdateAt = serverTimestamp();
            }

            if (isShippingKit) {
                if (typeof serverTimestamp === 'function') {
                    updatePayload.kitDeliveredToUsAt = serverTimestamp();
                }
            } else {
                if (typeof serverTimestamp === 'function') {
                    updatePayload.receivedAt = serverTimestamp();
                }
                updatePayload.autoReceived = true;
            }
        } else if (hasMovement) {
            updatePayload.status = PHONE_TRANSIT_STATUS;
            if (typeof serverTimestamp === 'function') {
                updatePayload.lastStatusUpdateAt = serverTimestamp();
            }
        } else if (inboundBaseStatus && inboundBaseStatus !== normalizedTransitStatus) {
            const inboundLockStatuses = new Set([
                PHONE_TRANSIT_STATUS,
                PHONE_TRANSIT_STATUS_LEGACY,
                'delivered_to_us',
                'received',
                'completed',
            ]);

            if (!inboundLockStatuses.has(normalizedTransitStatus)) {
                updatePayload.status = inboundBaseStatus;
                if (typeof serverTimestamp === 'function') {
                    updatePayload.lastStatusUpdateAt = serverTimestamp();
                }
            }
        }
    }

    return { updatePayload, delivered, direction };
}

function normalizeInboundTrackingStatus(statusCode, statusDescription) {
    const normalizeString = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : '');

    const normalizedCode = normalizeString(statusCode);
    if (normalizedCode && INBOUND_STATUS_ALIASES.has(normalizedCode)) {
        return INBOUND_STATUS_ALIASES.get(normalizedCode);
    }

    if (normalizedCode.includes('DELIVERED')) {
        return normalizedCode.includes('AGENT') ? 'DELIVERED_TO_AGENT' : 'DELIVERED';
    }
    if (normalizedCode.includes('OUT_FOR_DELIVERY')) {
        return 'OUT_FOR_DELIVERY';
    }
    if (normalizedCode.includes('ACCEPT')) {
        return normalizedCode.includes('SHIPMENT') ? 'SHIPMENT_ACCEPTED' : 'ACCEPTED';
    }
    if (normalizedCode.includes('TRANSIT')) {
        return 'IN_TRANSIT';
    }
    if (normalizedCode.includes('LABEL')) {
        return 'LABEL_CREATED';
    }
    if (normalizedCode.includes('ATTEMPT')) {
        return 'DELIVERY_ATTEMPT';
    }
    if (normalizedCode.includes('UNKNOWN')) {
        return 'UNKNOWN';
    }

    const description = typeof statusDescription === 'string' ? statusDescription.toLowerCase() : '';
    if (description.includes('out for delivery')) {
        return 'OUT_FOR_DELIVERY';
    }
    if (description.includes('deliver') && description.includes('agent')) {
        return 'DELIVERED_TO_AGENT';
    }
    if (description.includes('deliver')) {
        return 'DELIVERED';
    }
    if (description.includes('in transit') || description.includes('moving through')) {
        return 'IN_TRANSIT';
    }
    if (description.includes('accept')) {
        return 'ACCEPTED';
    }
    if (description.includes('label')) {
        return 'LABEL_CREATED';
    }
    if (description.includes('not yet')) {
        return 'NOT_YET_IN_SYSTEM';
    }
    if (description.includes('attempt')) {
        return 'DELIVERY_ATTEMPT';
    }
    if (description.includes('unknown')) {
        return 'UNKNOWN';
    }

    return normalizedCode || null;
}

module.exports = {
    DEFAULT_CARRIER_CODE,
    extractTrackingFields,
    buildKitTrackingUpdate,
    buildTrackingUrl,
    resolveCarrierCode,
    INBOUND_TRACKING_STATUSES,
    fetchTrackingData,
    KIT_TRANSIT_STATUS,
    PHONE_TRANSIT_STATUS,
    normalizeInboundTrackingStatus,
};
