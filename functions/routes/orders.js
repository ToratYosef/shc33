const express = require('express');
const fs = require('fs');
const path = require('path');
const { resolveUspsServiceAndWeightByDeviceCount } = require('../helpers/shipengine');
// Updated: Added DELETE endpoint for shipping address

function createOrdersRouter({
  axios,
  admin,
  ordersCollection,
  adminsCollection,
  writeOrderBoth,
  updateOrderBoth,
  generateNextOrderNumber,
  stateAbbreviations,
  templates,
  notifications,
  pdf,
  shipEngine,
  createShipEngineLabel,
  getShipEngineApiKey,
  transporter,
  deviceHelpers,
}) {
  const router = express.Router();

  const {
    ORDER_RECEIVED_EMAIL_HTML,
    ORDER_PLACED_ADMIN_EMAIL_HTML,
    SHIPPING_KIT_EMAIL_HTML,
    SHIPPING_LABEL_EMAIL_HTML,
  } = templates;
  const { sendAdminPushNotification, addAdminFirestoreNotification } = notifications;
  const { generateCustomLabelPdf, generateBagLabelPdf, mergePdfBuffers } = pdf;
  const {
    cloneShipEngineLabelMap,
    buildLabelIdList,
    isLabelPendingVoid,
    handleLabelVoid,
    sendVoidNotificationEmail,
  } = shipEngine;
  const { buildOrderDeviceKey, collectOrderDeviceKeys, deriveOrderStatusFromDevices } = deviceHelpers;

  const PRINT_QUEUE_STATUSES = [
    'shipping_kit_requested',
    'kit_needs_printing',
    'needs_printing',
  ];

  const PRINT_BUNDLE_ALLOWED_ORIGINS = new Set([
    'https://toratyosef.github.io',
    'https://buyback-a0f05.web.app',
    'https://secondhandcell.com',
    'https://www.secondhandcell.com',
  ]);

  const PRINT_BUNDLE_ALLOWED_METHODS = 'GET,POST,OPTIONS';
  const PRINT_BUNDLE_ALLOWED_HEADERS = 'Authorization, Content-Type, X-Requested-With';
  const firestore = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;
  const Timestamp = admin.firestore.Timestamp;
  const SWIFT_BUYBACK_ADDRESS = {
    name: 'SHC Returns',
    company_name: 'SecondHandCell',
    phone: '3475591707',
    address_line1: '1602 MCDONALD AVE STE REAR ENTRANCE',
    city_locality: 'Brooklyn',
    state_province: 'NY',
    postal_code: '11230-6336',
    country_code: 'US',
  };

  const EMAIL_LABEL_PACKAGE_DATA = {
    dimensions: { unit: 'inch', height: 2, width: 4, length: 6 },
  };

  const SHIPPING_PREFERENCE = {
    KIT: 'shipping_kit_requested',
    EMAIL_LABEL: 'email_label_requested',
  };


  const UPS_CARRIER_ID = 'se-4054857';
  const UPS_CONNECTION_PAYLOAD = {
    nickname: process.env.SHIPENGINE_UPS_NICKNAME || 'UPS Account',
    account_number:
      process.env.SHIPENGINE_UPS_ACCOUNT_NUMBER ||
      process.env.UPS_ACCOUNT_NUMBER ||
      '000076979A',
    account_postal_code: process.env.SHIPENGINE_UPS_ACCOUNT_POSTAL_CODE || '11230',
    account_country_code: process.env.SHIPENGINE_UPS_ACCOUNT_COUNTRY_CODE || 'US',
  };

  function normalizeShippingPreference(preference) {
    const value = String(preference || '').trim().toLowerCase();

    if (!value) {
      return SHIPPING_PREFERENCE.EMAIL_LABEL;
    }

    if (value.includes('kit')) {
      return SHIPPING_PREFERENCE.KIT;
    }

    if (
      value.includes('no label') ||
      value.includes('without label') ||
      value.includes('customer send') ||
      value.includes('self ship')
    ) {
      return SHIPPING_PREFERENCE.EMAIL_LABEL;
    }

    return SHIPPING_PREFERENCE.EMAIL_LABEL;
  }

  function resolveShippingPreferenceLabel(normalizedPreference) {
    if (normalizedPreference === SHIPPING_PREFERENCE.KIT) {
      return 'Shipping Kit Requested';
    }

    return 'Email Label Requested';
  }

  function detectLabelCarrierFromValue(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return null;

    if (
      normalized === 'ups' ||
      normalized.includes('ups') ||
      normalized.includes('ups_ground') ||
      normalized.includes('ground')
    ) {
      return 'ups';
    }

    if (
      normalized === 'usps' ||
      normalized.includes('usps') ||
      normalized.includes('stamps_com') ||
      normalized.includes('postal') ||
      normalized.includes('first_class') ||
      normalized.includes('priority_mail')
    ) {
      return 'usps';
    }

    return null;
  }

  function resolveRequestedLabelCarrier(orderData = {}) {
    const shippingInfo = orderData.shippingInfo || {};
    const candidates = [
      orderData.labelCarrier,
      orderData.shippingLabelCarrier,
      orderData.selectedShippingLabelCarrier,
      orderData.selectedLabelCarrier,
      orderData.labelProvider,
      orderData.shippingLabelProvider,
      orderData.labelDeliveryMethod,
      orderData.shippingMethod,
      orderData.selectedShippingMethod,
      orderData.selectedShippingOption,
      orderData.returnLabelCarrier,
      orderData.preferredLabelCarrier,
      orderData.preferredShippingCarrier,
      orderData.requestedLabelCarrier,
      orderData.shippingCarrier,
      orderData.shipCarrier,
      orderData.labelType,
      orderData.selectedLabelType,
      orderData.requestedLabelType,
      orderData.labelServiceCode,
      orderData.selectedLabelServiceCode,
      shippingInfo.labelCarrier,
      shippingInfo.shippingLabelCarrier,
      shippingInfo.selectedLabelCarrier,
      shippingInfo.selectedShippingLabelCarrier,
      shippingInfo.labelDeliveryMethod,
      shippingInfo.shippingMethod,
      shippingInfo.selectedShippingMethod,
      shippingInfo.selectedShippingOption,
      shippingInfo.requestedLabelCarrier,
      shippingInfo.labelServiceCode,
    ];

    const detectedCarriers = new Set();
    for (const candidate of candidates) {
      const detected = detectLabelCarrierFromValue(candidate);
      if (detected) {
        detectedCarriers.add(detected);
      }
    }

    if (detectedCarriers.size === 1) {
      return { carrier: Array.from(detectedCarriers)[0], ambiguous: false };
    }

    if (detectedCarriers.size > 1) {
      return { carrier: null, ambiguous: true };
    }

    return { carrier: null, ambiguous: false };
  }

  function resolveOrderDeviceCount(order = {}) {
    const items = Array.isArray(order.items) ? order.items : [];
    const itemCount = items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    const qty = Number(order.qty) || 0;
    const count = itemCount || qty || 1;
    return Math.max(1, count);
  }

  function buildHttpError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  function buildShipEngineErrorMessage(error, fallbackMessage) {
    const responseData = error?.response?.data || error?.responseData || null;
    const errors = Array.isArray(responseData?.errors) ? responseData.errors : [];
    const details = errors
      .map((entry) => entry?.message || entry?.error_source || null)
      .filter(Boolean);
    if (details.length) {
      return details.join('; ');
    }
    return responseData?.message || error?.message || fallbackMessage;
  }

  function extractShipEngineWarnings(error) {
    const responseData = error?.response?.data || error?.responseData || null;
    if (Array.isArray(responseData?.errors)) {
      return responseData.errors
        .map((entry) => entry?.message || null)
        .filter(Boolean);
    }
    if (Array.isArray(responseData?.warnings)) {
      return responseData.warnings
        .map((entry) => entry?.message || null)
        .filter(Boolean);
    }
    return [];
  }

  function extractLabelDownloadUrl(labelData = {}) {
    return (
      labelData?.label_download?.pdf ||
      labelData?.label_download?.href ||
      labelData?.label_download?.url ||
      labelData?.labelDownload?.pdf ||
      labelData?.labelDownload?.href ||
      labelData?.labelDownload?.url ||
      null
    );
  }

  function extractLabelCarrierCode(labelData = {}, fallback = null) {
    return (
      labelData?.shipment?.carrier_code ||
      labelData?.shipment?.carrierCode ||
      labelData?.shipment?.carrier_id ||
      labelData?.carrier_code ||
      labelData?.carrierCode ||
      fallback ||
      null
    );
  }

  function extractLabelServiceCode(labelData = {}, fallback = null) {
    return (
      labelData?.shipment?.service_code ||
      labelData?.shipment?.serviceCode ||
      labelData?.service_code ||
      labelData?.serviceCode ||
      fallback ||
      null
    );
  }

  function buildSingleLabelRecord({
    labelData,
    labelKey,
    displayName,
    labelReference,
    serviceCode,
    carrierCode,
  }) {
    const nowTimestamp = Timestamp.now();
    const downloadUrl = extractLabelDownloadUrl(labelData);
    const labelId =
      labelData?.label_id ||
      labelData?.labelId ||
      labelData?.shipengine_label_id ||
      null;

    const labelRecord = {
      id: labelId,
      trackingNumber: labelData?.tracking_number || null,
      downloadUrl,
      carrierCode: extractLabelCarrierCode(labelData, carrierCode),
      serviceCode: extractLabelServiceCode(labelData, serviceCode),
      generatedAt: nowTimestamp,
      createdAt: nowTimestamp,
      status: 'active',
      voidStatus: 'active',
      message: null,
      displayName,
      labelReference,
    };

    const labelRecords = { [labelKey]: labelRecord };
    const labelIds = buildLabelIdList(labelRecords);
    const hasActive = Object.values(labelRecords).some((entry) =>
      entry && entry.id ? !isLabelPendingVoid(entry) : false
    );

    return {
      nowTimestamp,
      downloadUrl,
      labelId,
      labelRecord,
      labelRecords,
      labelIds,
      hasActive,
    };
  }

  function assertLabelGenerationAllowed(order = {}, carrierName = 'shipping') {
    const labels = cloneShipEngineLabelMap(order.shipEngineLabels);
    const activeExistingLabel = Object.values(labels).find(
      (entry) => entry && entry.id && !isLabelPendingVoid(entry)
    );

    if (activeExistingLabel) {
      throw buildHttpError(
        `A shipping label already exists for this order. Void the current label before generating a new ${carrierName} label.`,
        409
      );
    }

    const voidedStatus = String(order?.labelVoidStatus || '').toLowerCase();
    if (
      (order?.trackingNumber || order?.uspsLabelUrl || order?.upsLabelUrl) &&
      !['voided', 'void_denied'].includes(voidedStatus)
    ) {
      throw buildHttpError(
        `A shipping label already exists for this order. Void the current label before generating a new ${carrierName} label.`,
        409
      );
    }
  }

  function buildShippingLabelEmail(order, { carrierName, labelDownloadUrl, trackingNumber }) {
    const shippingInfo = order?.shippingInfo || {};
    const trackStatusLink = `https://secondhandcell.com/track-order.html?orderId=${encodeURIComponent(order.id)}&fromEmailLink=1`;

    return {
      from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
      to: shippingInfo.email,
      subject: `Your ${carrierName} SecondHandCell Shipping Label for Order #${order.id}`,
      html: SHIPPING_LABEL_EMAIL_HTML
        .replace(/\*\*CUSTOMER_NAME\*\*/g, shippingInfo.fullName || 'Customer')
        .replace(/\*\*ORDER_ID\*\*/g, order.id)
        .replace(/\*\*TRACKING_NUMBER\*\*/g, trackingNumber || 'N/A')
        .replace(/\*\*LABEL_DOWNLOAD_LINK\*\*/g, labelDownloadUrl)
        .replace(/\*\*TRACK_STATUS_LINK\*\*/g, trackStatusLink)
        .replace(/\*\*CARRIER_NAME\*\*/g, carrierName),
    };
  }


  async function reconnectUpsCarrierConnection() {
    const shipEngineApiKey =
      (typeof getShipEngineApiKey === 'function' ? getShipEngineApiKey() : null) ||
      process.env.SHIPENGINE_KEY ||
      null;

    if (!shipEngineApiKey) {
      throw buildHttpError(
        'ShipEngine API key not configured. Cannot reconnect UPS carrier connection.',
        500
      );
    }

    try {
      const response = await axios.put(
        `https://api.shipengine.com/v1/connections/carriers/ups/${UPS_CARRIER_ID}`,
        UPS_CONNECTION_PAYLOAD,
        {
          headers: {
            'API-Key': shipEngineApiKey,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log('[ShipEngine][UPS] Carrier connection refreshed', {
        carrier_id: UPS_CARRIER_ID,
        account_number_configured: Boolean(UPS_CONNECTION_PAYLOAD.account_number),
      });

      return response.data;
    } catch (error) {
      const statusCode = Number(error?.response?.status || 0);
      const details = error?.response?.data || error?.message || error;
      console.error(
        '[ShipEngine][UPS] Failed to refresh carrier connection',
        JSON.stringify({ carrier_id: UPS_CARRIER_ID, statusCode }),
        typeof details === 'string' ? details : JSON.stringify(details)
      );

      if (statusCode === 405) {
        console.warn(
          '[ShipEngine][UPS] Refresh endpoint returned 405. Proceeding with existing UPS carrier connection.'
        );
        return { skipped: true, reason: 'method_not_allowed' };
      }

      throw buildHttpError('Failed to reconnect UPS carrier configuration in ShipEngine.', 502);
    }
  }

  async function createSingleInboundLabelForOrder(order, {
    carrierName,
    carrierCode = null,
    carrierId = null,
    serviceCode,
    weight,
    dimensions = EMAIL_LABEL_PACKAGE_DATA.dimensions,
    packageProducts = null,
    advancedOptions = null,
    labelKey,
    labelReferenceSuffix,
    displayName,
    labelDeliveryMethod,
    labelGeneratedSource,
    urlField,
    accountNumberConfigured = false,
  }) {
    if (!order?.id) {
      throw buildHttpError('Order not found.', 404);
    }

    const shippingInfo = order.shippingInfo;
    if (!shippingInfo) {
      throw buildHttpError('Shipping information is required to generate a label.', 400);
    }

    if (!shippingInfo.email) {
      throw buildHttpError('Customer email is required to send the generated label.', 400);
    }

    assertLabelGenerationAllowed(order, carrierName);

    const buyerAddress = normalizeCustomerAddress(shippingInfo);
    const labelReference = `${order.id}-${labelReferenceSuffix}`;

    const packageData = {
      dimensions,
      service_code: serviceCode,
      carrier_code: carrierCode || undefined,
      carrier_id: carrierId || undefined,
      weight,
      products: packageProducts || undefined,
      advanced_options: advancedOptions || undefined,
    };

    let labelData;
    try {
      labelData = await createShipEngineLabel(
        buyerAddress,
        SWIFT_BUYBACK_ADDRESS,
        labelReference,
        packageData,
        {
          orderId: order.id,
          orderData: order,
          carrierCode,
          carrierId,
          carrierName,
          serviceCode,
          accountNumberConfigured,
          labelType: labelKey,
        }
      );
    } catch (error) {
      const message = buildShipEngineErrorMessage(
        error,
        `Failed to generate ${carrierName} shipping label.`
      );
      const wrapped = buildHttpError(message, error.status || error.response?.status || 502);
      wrapped.responseData = error.response?.data || error.responseData || null;
      wrapped.warnings = extractShipEngineWarnings(error);
      throw wrapped;
    }

    const singleLabel = buildSingleLabelRecord({
      labelData,
      labelKey,
      displayName,
      labelReference,
      serviceCode,
      carrierCode,
    });

    if (!singleLabel.downloadUrl) {
      throw buildHttpError('Label PDF link not available from ShipEngine.', 502);
    }

    const labelTimestamp = FieldValue.serverTimestamp();
    const orderUpdates = {
      status: 'label_generated',
      labelGeneratedAt: labelTimestamp,
      lastStatusUpdateAt: labelTimestamp,
      trackingNumber: singleLabel.labelRecord.trackingNumber,
      shipEngineLabels: singleLabel.labelRecords,
      shipEngineLabelIds: singleLabel.labelIds,
      shipEngineLabelsLastUpdatedAt: singleLabel.nowTimestamp,
      hasShipEngineLabel: singleLabel.labelIds.length > 0,
      hasActiveShipEngineLabel: singleLabel.hasActive,
      shipEngineLabelId: singleLabel.labelId || singleLabel.labelIds[0] || null,
      labelDeliveryMethod,
      labelGeneratedSource,
      labelVoidStatus: 'active',
      labelVoidMessage: null,
      labelCarrierCode: singleLabel.labelRecord.carrierCode,
      labelServiceCode: singleLabel.labelRecord.serviceCode,
      labelCarrierName: carrierName,
      labelTrackingCarrierCode: singleLabel.labelRecord.carrierCode,
      labelTrackingStatus:
        labelData?.status_code || labelData?.statusCode || 'LABEL_CREATED',
      labelTrackingStatusDescription:
        labelData?.status_description || labelData?.statusDescription || 'Label created',
      labelTrackingCarrierStatusCode:
        labelData?.carrier_status_code || labelData?.carrierStatusCode || null,
      labelTrackingCarrierStatusDescription:
        labelData?.carrier_status_description || labelData?.carrierStatusDescription || null,
      labelTrackingLastSyncedAt: labelTimestamp,
      shipEngineShipmentId:
        labelData?.shipment_id || labelData?.shipmentId || labelData?.shipment?.shipment_id || null,
      [urlField]: singleLabel.downloadUrl,
    };

    const emailOptions = buildShippingLabelEmail(order, {
      carrierName,
      labelDownloadUrl: singleLabel.downloadUrl,
      trackingNumber: singleLabel.labelRecord.trackingNumber,
    });

    await updateOrderBoth(order.id, orderUpdates);

    let emailWarning = null;
    try {
      await transporter.sendMail(emailOptions);
    } catch (emailError) {
      emailWarning = `Label was generated, but the confirmation email failed to send: ${emailError?.message || 'unknown error'}`;
      console.error(`[Shipping Label Email] Order ${order.id}:`, emailError);
    }

    return {
      orderUpdates,
      labelData,
      labelDownloadUrl: singleLabel.downloadUrl,
      trackingNumber: singleLabel.labelRecord.trackingNumber,
      carrierCode: singleLabel.labelRecord.carrierCode,
      serviceCode: singleLabel.labelRecord.serviceCode,
      labelId: singleLabel.labelId,
      warnings: emailWarning ? [emailWarning] : [],
    };
  }

  function normalizeCustomerAddress(raw = {}, fallback = {}) {
    const merged = {
      fullName: raw.fullName ?? raw.name ?? fallback.fullName,
      streetAddress: raw.streetAddress ?? raw.address_line1 ?? raw.addressLine1 ?? fallback.streetAddress,
      city: raw.city ?? raw.city_locality ?? raw.cityLocality ?? fallback.city,
      state: raw.state ?? raw.state_province ?? raw.stateProvince ?? fallback.state,
      zipCode: raw.zipCode ?? raw.postal_code ?? raw.postalCode ?? fallback.zipCode,
    };

    const fullName = String(merged.fullName || '').trim();
    const streetAddress = String(merged.streetAddress || '').trim();
    const city = String(merged.city || '').trim();
    const state = String(merged.state || '').trim().toUpperCase();
    const zipCode = String(merged.zipCode || '').trim();

    if (!fullName || !streetAddress || !city || !state || !zipCode) {
      throw buildHttpError(
        'Customer address is required (fullName, streetAddress, city, state, zipCode).',
        400
      );
    }

    return {
      name: fullName,
      phone: '3475591707',
      address_line1: streetAddress,
      city_locality: city,
      state_province: state,
      postal_code: zipCode,
      country_code: 'US',
    };
  }

  const resolvedStorageBucketName = [
    process.env.FIREBASE_STORAGE_BUCKET,
    process.env.STORAGE_BUCKET,
    process.env.GCLOUD_STORAGE_BUCKET,
    admin.apps?.[0]?.options?.storageBucket,
  ].find((value) => typeof value === 'string' && value.trim());

  let storageBucket = null;

  if (resolvedStorageBucketName) {
    try {
      storageBucket = admin.storage().bucket(resolvedStorageBucketName.trim());
    } catch (error) {
      console.warn('Bulk print storage bucket unavailable:', error?.message || error);
    }
  }

  function applyPrintBundleCorsHeaders(res, origin) {
    if (origin && PRINT_BUNDLE_ALLOWED_ORIGINS.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Vary', 'Origin');
    }

    res.header('Access-Control-Allow-Methods', PRINT_BUNDLE_ALLOWED_METHODS);
    res.header('Access-Control-Allow-Headers', PRINT_BUNDLE_ALLOWED_HEADERS);
    res.header(
      'Access-Control-Expose-Headers',
      'X-Printed-Order-Ids, X-Kit-Sent-Order-Ids, X-Bulk-Print-Folder, X-Bulk-Print-Job-Id'
    );
  }

  function handlePrintBundlePreflight(req, res) {
    applyPrintBundleCorsHeaders(res, req.headers.origin);
    res.sendStatus(204);
  }

  function toMillis(value) {
    if (!value) return null;
    if (typeof value === 'number') return value;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value === 'object') {
      const seconds = value._seconds ?? value.seconds ?? null;
      if (typeof seconds === 'number') {
        const nanos = value._nanoseconds ?? value.nanoseconds ?? 0;
        return seconds * 1000 + Math.floor(nanos / 1e6);
      }
    }
    return null;
  }

  function resolveCreatedAtMillis(order = {}) {
    const candidates = [
      order.createdAt,
      order.created_at,
      order.createdAtMillis,
      order.createdAtMs,
      order.created_at_ms,
      order.created_at_millis,
    ];

    for (const candidate of candidates) {
      const millis = toMillis(candidate);
      if (millis) {
        return millis;
      }
    }

    if (typeof order.createdAtSeconds === 'number') {
      return order.createdAtSeconds * 1000;
    }

    return null;
  }

  function normaliseBuffer(data) {
    if (!data) return null;
    return Buffer.isBuffer(data) ? data : Buffer.from(data);
  }

  function collectLabelUrlCandidates(order = {}) {
    const urls = new Set();
    const pushUrl = (value) => {
      if (!value) return;
      const stringValue = String(value).trim();
      if (!stringValue) return;
      if (/^https?:\/\//i.test(stringValue)) {
        urls.add(stringValue);
      }
    };

    pushUrl(order.outboundLabelUrl);
    pushUrl(order.inboundLabelUrl);
    pushUrl(order.uspsLabelUrl);

    Object.keys(order)
      .filter((key) => key && key.toLowerCase().includes('label') && key.toLowerCase().includes('url'))
      .forEach((key) => pushUrl(order[key]));

    const collections = [order.shipEngineLabels, order.labelRecords, order.labels, order.labelUrls];

    collections.forEach((collection) => {
      if (!collection) return;
      if (Array.isArray(collection)) {
        collection.forEach((entry) => {
          if (!entry) return;
          if (typeof entry === 'string') {
            pushUrl(entry);
            return;
          }
          if (typeof entry === 'object') {
            Object.values(entry).forEach((value) => pushUrl(value));
            if (entry.label_download && typeof entry.label_download === 'object') {
              Object.values(entry.label_download).forEach((value) => pushUrl(value));
            }
          }
        });
      } else if (typeof collection === 'object') {
        Object.values(collection).forEach((entry) => {
          if (!entry) return;
          if (typeof entry === 'string') {
            pushUrl(entry);
            return;
          }
          if (typeof entry === 'object') {
            Object.values(entry).forEach((value) => pushUrl(value));
            if (entry.label_download && typeof entry.label_download === 'object') {
              Object.values(entry.label_download).forEach((value) => pushUrl(value));
            }
          }
        });
      }
    });

    return urls;
  }

  async function fetchPrintQueueOrders(orderIds = []) {
    const results = new Map();

    if (Array.isArray(orderIds) && orderIds.length) {
      const docs = await Promise.all(
        orderIds.map((id) =>
          ordersCollection
            .doc(String(id))
            .get()
            .catch((error) => {
              console.error(`Failed to load order ${id} for print queue:`, error);
              return null;
            })
        )
      );

      docs.forEach((doc) => {
        if (doc && doc.exists) {
          results.set(doc.id, { id: doc.id, ...doc.data() });
        }
      });
    } else {
      await Promise.all(
        PRINT_QUEUE_STATUSES.map(async (status) => {
          try {
            const snapshot = await ordersCollection.where('status', '==', status).get();
            snapshot.docs.forEach((doc) => {
              results.set(doc.id, { id: doc.id, ...doc.data() });
            });
          } catch (error) {
            console.error(`Failed to load ${status} orders for print queue:`, error);
          }
        })
      );
    }

    const orders = Array.from(results.values());
    orders.sort((a, b) => {
      const aMillis = resolveCreatedAtMillis(a) ?? Number.MAX_SAFE_INTEGER;
      const bMillis = resolveCreatedAtMillis(b) ?? Number.MAX_SAFE_INTEGER;
      return aMillis - bMillis;
    });
    return orders;
  }

  function serialisePrintQueueOrder(order = {}) {
    const shippingInfo = order.shippingInfo || {};
    const labelUrls = Array.from(collectLabelUrlCandidates(order));
    const items = Array.isArray(order.items) ? order.items : [];
    const primaryItem = items[0] || {};
    const deviceSummary =
      items.length > 1
        ? `${primaryItem.modelName || primaryItem.device || order.device || 'Device'} + ${
            items.length - 1
          } more`
        : primaryItem.modelName || primaryItem.device || order.device || '';

    return {
      id: order.id,
      status: order.status || null,
      shippingPreference: order.shippingPreference || null,
      shippingInfo: {
        fullName: shippingInfo.fullName || shippingInfo.name || '',
        email: shippingInfo.email || '',
        phone:
          shippingInfo.phone ||
          shippingInfo.phoneNumber ||
          shippingInfo.phone_number ||
          shippingInfo.contactPhone ||
          '',
        city: shippingInfo.city || '',
        state: shippingInfo.state || '',
      },
      device: deviceSummary,
      brand: order.brand || primaryItem.brand || '',
      storage: order.storage || order.memory || primaryItem.storage || '',
      carrier: order.carrier || primaryItem.carrier || primaryItem.lock || '',
      estimatedQuote:
        typeof order.estimatedQuote === 'number'
          ? order.estimatedQuote
          : Number(order.estimatedQuote) || null,
      createdAtMillis: resolveCreatedAtMillis(order),
      labelUrls,
    };
  }

  async function downloadPdfBuffer(url) {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
  }

  function sanitisePathSegment(value) {
    return String(value || '')
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-');
  }

  async function collectOrderPrintParts(order, options = {}) {
    const parts = [];
    const seenUrls = new Set();
    const includeShippingLabels = options.includeShippingLabels !== false;
    const shippingPreference = String(
      order.shippingPreference || order.shipping_preference || ''
    ).toLowerCase();
    const normalizedStatus = String(order.status || '').toLowerCase();
    const isKitOrder =
      shippingPreference.includes('kit') ||
      normalizedStatus.includes('kit') ||
      [
        'shipping_kit_requested',
        'kit_needs_printing',
        'kit_sent',
        'kit_on_the_way_to_customer',
        'kit_delivered',
        'kit_on_the_way_to_us',
      ].includes(normalizedStatus);

    async function pushLabelPart(url, kind) {
      if (!url) {
        return;
      }

      const stringUrl = String(url).trim();
      if (!stringUrl || seenUrls.has(stringUrl)) {
        return;
      }

      try {
        const buffer = await downloadPdfBuffer(stringUrl);
        if (buffer && buffer.length) {
          parts.push({ kind, buffer, sourceUrl: stringUrl });
          seenUrls.add(stringUrl);
        }
      } catch (error) {
        console.error(`Failed to download label for order ${order?.id} from ${stringUrl}:`, error.message || error);
      }
    }

    let hasInboundLabel = false;

    if (includeShippingLabels) {
      await pushLabelPart(order.outboundLabelUrl, 'outbound');

      if (order.inboundLabelUrl) {
        await pushLabelPart(order.inboundLabelUrl, 'inbound');
        hasInboundLabel = true;
      }

      if (order.uspsLabelUrl) {
        if (!hasInboundLabel) {
          await pushLabelPart(order.uspsLabelUrl, 'inbound');
          hasInboundLabel = true;
        } else {
          await pushLabelPart(order.uspsLabelUrl, 'extra');
        }
      }

      const labelUrls = Array.from(collectLabelUrlCandidates(order));
      for (const url of labelUrls) {
        if (seenUrls.has(url)) {
          continue;
        }
        const nextKind = hasInboundLabel ? 'extra' : 'inbound';
        await pushLabelPart(url, nextKind);
        if (nextKind === 'inbound') {
          hasInboundLabel = true;
        }
      }
    }

    try {
      const infoLabel = await generateCustomLabelPdf(order);
      const infoBuffer = normaliseBuffer(infoLabel);
      if (infoBuffer && infoBuffer.length) {
        parts.push({ kind: 'info', buffer: infoBuffer });
      }
    } catch (error) {
      console.error(`Failed to generate info label PDF for order ${order.id}:`, error);
    }

    try {
      const bagLabel = await generateBagLabelPdf(order);
      const bagBuffer = normaliseBuffer(bagLabel);
      if (bagBuffer && bagBuffer.length) {
        parts.push({ kind: 'bag', buffer: bagBuffer });
      }
    } catch (error) {
      console.error(`Failed to generate bag label PDF for order ${order.id}:`, error);
    }

    const shippingParts = parts.filter((part) =>
      ['outbound', 'inbound', 'extra'].includes(part?.kind)
    );

    if (includeShippingLabels && isKitOrder && shippingParts.length === 1) {
      const duplicate = shippingParts[0];
      const duplicateBuffer = normaliseBuffer(duplicate?.buffer);
      if (duplicateBuffer?.length) {
        parts.push({ ...duplicate, buffer: Buffer.from(duplicateBuffer) });
      }
    }

    return parts;
  }

  function createSuffixResolver(parts = []) {
    const used = new Set();
    const baseSuffixes = new Map([
      ['outbound', '1'],
      ['inbound', '2'],
      ['info', '3'],
      ['bag', '4'],
    ]);
    let fallbackIndex = 1;

    return (part = {}) => {
      const base = baseSuffixes.get(part.kind);
      if (base && !used.has(base)) {
        used.add(base);
        return base;
      }

      while (used.has(String(fallbackIndex))) {
        fallbackIndex += 1;
      }

      const suffix = String(fallbackIndex);
      used.add(suffix);
      fallbackIndex += 1;
      return suffix;
    };
  }

  async function persistBulkPrintAssets(context, plans = []) {
    if (!context || !context.folderName || !Array.isArray(plans) || !plans.length) {
      return null;
    }

    if (!storageBucket) {
      return null;
    }

    const uploads = [];

    plans.forEach(({ order, parts }) => {
      if (!order?.id || !Array.isArray(parts) || !parts.length) {
        return;
      }

      const orderId = String(order.id).trim();
      if (!orderId) {
        return;
      }

      const suffixResolver = createSuffixResolver(parts);

      parts.forEach((part) => {
        if (!part?.buffer) {
          return;
        }

        const suffix = suffixResolver(part);
        const filePath = `${context.folderName}/${sanitisePathSegment(orderId)}-${suffix}.pdf`;

        uploads.push(
          storageBucket
            .file(filePath)
            .save(part.buffer, { contentType: 'application/pdf' })
            .catch((error) => {
              console.error(`Failed to upload bulk print asset ${filePath}:`, error);
            })
        );
      });
    });

    if (uploads.length) {
      await Promise.all(uploads);
    }

    return null;
  }

  async function reserveBulkPrintContext(orderIds = []) {
    if (!firestore) {
      return null;
    }

    const counterRef = firestore.collection('adminCounters').doc('bulkPrint');
    let sequence = 0;

    await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(counterRef);
      const current = snapshot.exists && typeof snapshot.data()?.sequence === 'number'
        ? snapshot.data().sequence
        : 0;
      sequence = current + 1;
      transaction.set(counterRef, { sequence }, { merge: true });
    });

    const folderName = `bulk-print-${sequence}`;
    let jobId = null;

    try {
      const jobRef = firestore.collection('bulkPrintJobs').doc();
      jobId = jobRef.id;
      await jobRef.set({
        createdAt: FieldValue.serverTimestamp(),
        orderIds,
        folder: folderName,
        sequence,
      });
    } catch (error) {
      console.error('Failed to record bulk print job metadata:', error);
    }

    return { folderName, sequence, jobId };
  }

  async function buildPrintBundleResponse({
    orderIds = [],
    res,
    origin,
    allowEmptySelection = false,
    includeShippingLabels = true,
  }) {
    const cleanedOrderIds = Array.isArray(orderIds)
      ? orderIds.map((id) => String(id).trim()).filter(Boolean)
      : [];

    if (!cleanedOrderIds.length && !allowEmptySelection) {
      return res.status(400).json({ error: 'At least one order ID must be provided.' });
    }

    applyPrintBundleCorsHeaders(res, origin);

    const orders = await fetchPrintQueueOrders(cleanedOrderIds);
    if (!orders.length) {
      return res.status(404).json({ error: 'No printable orders available for the requested selection.' });
    }

    const printableOrderIds = [];
    const printableOrders = [];
    const mergedParts = [];
    const bulkPlans = [];

    for (const order of orders) {
      const parts = await collectOrderPrintParts(order, { includeShippingLabels });
      if (!parts.length) {
        console.warn(`No printable documents generated for order ${order.id}`);
        continue;
      }
      printableOrderIds.push(order.id);
      printableOrders.push(order);
      parts.forEach((part) => {
        if (part?.buffer) {
          mergedParts.push(part.buffer);
        }
      });
      bulkPlans.push({ order, parts });
    }

    if (!mergedParts.length) {
      return res
        .status(404)
        .json({ error: 'No printable documents available for the requested orders.' });
    }

    const mergedPdf = await mergePdfBuffers(mergedParts);
    const mergedBuffer = normaliseBuffer(mergedPdf);

    let bulkContext = null;
    if (printableOrderIds.length) {
      try {
        const context = await reserveBulkPrintContext(printableOrderIds);
        if (context) {
          await persistBulkPrintAssets(context, bulkPlans);
          bulkContext = context;
        }
      } catch (storageError) {
        console.error('Failed to persist bulk print assets:', storageError);
      }
    }

    let kitSentOrderIds = [];
    try {
      kitSentOrderIds = await markOrdersKitSent(printableOrders);
    } catch (updateError) {
      console.error('Failed to update kit sent status after bundle:', updateError);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="print-queue-bundle.pdf"');
    res.setHeader('X-Printed-Order-Ids', JSON.stringify(printableOrderIds));
    res.setHeader('X-Kit-Sent-Order-Ids', JSON.stringify(kitSentOrderIds));
    if (bulkContext?.folderName) {
      res.setHeader('X-Bulk-Print-Folder', bulkContext.folderName);
    }
    if (bulkContext?.jobId) {
      res.setHeader('X-Bulk-Print-Job-Id', bulkContext.jobId);
    }
    res.send(mergedBuffer);

    return null;
  }

  async function markOrdersKitSent(orders = []) {
    if (!Array.isArray(orders) || !orders.length) {
      return [];
    }

    const results = await Promise.all(
      orders.map(async (order) => {
        if (!order || !order.id) {
          return null;
        }

        try {
          const updatePayload = {
            status: 'kit_sent',
          };

          if (!order.kitSentAt) {
            updatePayload.kitSentAt = admin.firestore.FieldValue.serverTimestamp();
          }

          await updateOrderBoth(order.id, updatePayload);
          return order.id;
        } catch (error) {
          console.error(`Failed to mark order ${order.id} as kit sent after bundle:`, error);
          return null;
        }
      })
    );

    return results.filter(Boolean);
  }

  router.post('/fetch-pdf', async (req, res) => {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'PDF URL is required.' });
    }

    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
      });

      const base64Data = Buffer.from(response.data).toString('base64');

      res.json({
        base64: base64Data,
        mimeType: response.headers['content-type'] || 'application/pdf',
      });
    } catch (error) {
      console.error('Error fetching external PDF:', error.message);
      if (error.response) {
        console.error('External API Response Status:', error.response.status);
        console.error(
          'External API Response Data (partial):',
          error.response.data
            ? Buffer.from(error.response.data)
                .toString('utf-8')
                .substring(0, 200)
            : 'No data'
        );
        return res.status(error.response.status).json({
          error: `Failed to fetch PDF from external service. Status: ${error.response.status}`,
          details: error.message,
        });
      }
      res.status(500).json({ error: 'Internal server error during PDF proxy fetch.' });
    }
  });

  router.get('/orders', async (req, res) => {
    try {
      const snapshot = await ordersCollection.get();
      const orders = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json(orders);
    } catch (err) {
      console.error('Error fetching orders:', err);
      res.status(500).json({ error: 'Failed to fetch orders' });
    }
  });

  router.get('/orders/needs-printing', async (req, res) => {
    try {
      const orders = await fetchPrintQueueOrders();
      const payload = orders.map(serialisePrintQueueOrder);
      res.json({ orders: payload });
    } catch (error) {
      console.error('Failed to load print queue orders:', error);
      res.status(500).json({ error: 'Failed to load print queue orders' });
    }
  });

  router.post('/orders/needs-printing/bundle', async (req, res) => {
    try {
      const orderIds = Array.isArray(req.body?.orderIds)
        ? req.body.orderIds.filter(Boolean)
        : [];

      await buildPrintBundleResponse({
        orderIds,
        res,
        origin: req.headers.origin,
        allowEmptySelection: true,
      });
    } catch (error) {
      console.error('Failed to generate print queue bundle:', error);
      res.status(500).json({ error: 'Failed to build print queue bundle' });
    }
  });

  router.options('/orders/needs-printing/bundle', handlePrintBundlePreflight);

  router.post('/merge-print', async (req, res) => {
    try {
      const orderIds = Array.isArray(req.body?.orderIds)
        ? req.body.orderIds.filter(Boolean)
        : [];

      await buildPrintBundleResponse({
        orderIds,
        res,
        origin: req.headers.origin,
        allowEmptySelection: false,
        includeShippingLabels: false,
      });
    } catch (error) {
      console.error('Failed to generate merge print bundle (POST):', error);
      res.status(500).json({ error: 'Failed to merge print documents' });
    }
  });

  router.options('/merge-print', handlePrintBundlePreflight);

  router.get('/merge-print/:orderIds', async (req, res) => {
    try {
      const rawIds = String(req.params.orderIds || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);

      await buildPrintBundleResponse({
        orderIds: rawIds,
        res,
        origin: req.headers.origin,
        allowEmptySelection: false,
        includeShippingLabels: false,
      });
    } catch (error) {
      console.error('Failed to generate merge print bundle:', error);
      res.status(500).json({ error: 'Failed to merge print documents' });
    }
  });

  router.options('/merge-print/:orderIds', handlePrintBundlePreflight);

  router.get('/orders/find', async (req, res) => {
    try {
      const { identifier } = req.query;
      if (!identifier) {
        return res
          .status(400)
          .json({ error: 'Identifier query parameter is required.' });
      }

      // Normalize identifier: trim whitespace and convert to uppercase
      const normalizedIdentifier = String(identifier).trim().toUpperCase();

      let orderDoc;
      if (normalizedIdentifier.match(/^SHC-\d{5}$/)) {
        orderDoc = await ordersCollection.doc(normalizedIdentifier).get();
      } else if (normalizedIdentifier.length === 26 && normalizedIdentifier.match(/^\d+$/)) {
        const snapshot = await ordersCollection
          .where('externalId', '==', normalizedIdentifier)
          .limit(1)
          .get();
        if (!snapshot.empty) {
          orderDoc = snapshot.docs[0];
        }
      }

      if (!orderDoc || !orderDoc.exists) {
        return res
          .status(404)
          .json({ error: 'Order not found with provided identifier.' });
      }

      res.json({ id: orderDoc.id, ...orderDoc.data() });
    } catch (err) {
      console.error('Error finding order:', err);
      res.status(500).json({ error: 'Failed to find order' });
    }
  });

  router.get('/orders/:id', async (req, res) => {
    try {
      const docRef = ordersCollection.doc(req.params.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }
      res.json({ id: doc.id, ...doc.data() });
    } catch (err) {
      console.error('Error fetching single order:', err);
      res.status(500).json({ error: 'Failed to fetch order' });
    }
  });

  router.get('/orders/by-user/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required.' });
      }

      const snapshot = await ordersCollection
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .get();
      const orders = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      res.json(orders);
    } catch (err) {
      console.error("Error fetching user's orders:", err);
      res.status(500).json({ error: "Failed to fetch user orders" });
    }
  });

  router.post('/submit-order', async (req, res) => {
    try {
      const orderData = req.body;

      if (
        !orderData?.shippingInfo ||
        (typeof orderData.estimatedQuote === 'undefined' &&
          typeof orderData.totalPayout === 'undefined')
      ) {
        return res.status(400).json({ error: 'Invalid order data' });
      }

      const normalizeAmount = (value) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
      };

      const normalizeItems = (items = []) => {
        if (!Array.isArray(items)) return [];
        return items
          .map((item) => ({
            ...item,
            qty: Number(item.qty) || 1,
            unitPrice: normalizeAmount(item.unitPrice) ?? normalizeAmount(item.price) ?? null,
            totalPayout: normalizeAmount(item.totalPayout) ?? null,
            estimatedQuote: normalizeAmount(item.estimatedQuote) ?? null,
          }))
          .filter((item) => item.device || item.modelName || item.modelId);
      };

      const items = normalizeItems(orderData.items);
      if (items.length) {
        orderData.items = items;
        orderData.itemCount = items.length;
        orderData.qty = items.reduce((sum, item) => sum + (item.qty || 0), 0);

        const firstItem = items[0];
        orderData.device = orderData.device || firstItem.modelName || firstItem.device || '';
        orderData.brand = orderData.brand || firstItem.brand || '';
        orderData.modelId = orderData.modelId || firstItem.modelId || '';
        orderData.modelName = orderData.modelName || firstItem.modelName || firstItem.device || '';
        orderData.storage = orderData.storage || firstItem.storage || '';
        orderData.carrier = orderData.carrier || firstItem.carrier || firstItem.lock || '';
        orderData.lock = orderData.lock || firstItem.lock || firstItem.carrier || '';
        orderData.condition = orderData.condition || firstItem.condition || '';
        orderData.condition_power_on = orderData.condition_power_on || firstItem.condition_power_on || '';
        orderData.condition_functional = orderData.condition_functional || firstItem.condition_functional || '';
        orderData.condition_cracks = orderData.condition_cracks || firstItem.condition_cracks || '';
        orderData.condition_cosmetic = orderData.condition_cosmetic || firstItem.condition_cosmetic || '';

        const itemsTotal = items.reduce((sum, item) => {
          const fallbackTotal =
            (item.unitPrice ?? normalizeAmount(item.price) ?? 0) * (item.qty || 1);
          const itemTotal =
            normalizeAmount(item.totalPayout) ??
            normalizeAmount(item.estimatedQuote) ??
            fallbackTotal;
          return sum + (itemTotal || 0);
        }, 0);
        if (typeof orderData.totalPayout === 'undefined') {
          orderData.totalPayout = itemsTotal;
        }
        if (typeof orderData.estimatedQuote === 'undefined') {
          orderData.estimatedQuote = itemsTotal;
        }
        if (typeof orderData.originalQuote === 'undefined') {
          orderData.originalQuote = itemsTotal;
        }
      }

      const normalizedOriginal = normalizeAmount(orderData.originalQuote);
      const normalizedTotal = normalizeAmount(orderData.totalPayout);
      const normalizedEstimated = normalizeAmount(orderData.estimatedQuote);

      const payoutToPersist =
        normalizedTotal ?? normalizedEstimated ?? normalizedOriginal ?? 0;
      const originalToPersist =
        normalizedOriginal ?? normalizedEstimated ?? normalizedTotal ?? payoutToPersist;

      orderData.originalQuote = originalToPersist;

      const orderId = await generateNextOrderNumber();
      const finalPayout = payoutToPersist;
      const normalizedShippingPreference = normalizeShippingPreference(
        orderData.shippingPreference || orderData.shipping_preference
      );
      orderData.shippingPreference = resolveShippingPreferenceLabel(
        normalizedShippingPreference
      );
      orderData.shippingPreferenceNormalized = normalizedShippingPreference;
      orderData.totalPayout = finalPayout;
      orderData.estimatedQuote =
        Number.isFinite(normalizedEstimated) && normalizedEstimated !== null
          ? normalizedEstimated
          : finalPayout;

      if (typeof orderData.shippingKitFee !== 'undefined') {
        const normalizedFee = normalizeAmount(orderData.shippingKitFee);
        orderData.shippingKitFee = normalizedFee ?? 0;
      }

      const fullStateName = orderData.shippingInfo.state;
      const normalizedStateName =
        typeof fullStateName === 'string' ? fullStateName.trim() : '';
      const titleCasedStateName = normalizedStateName
        ? normalizedStateName
            .toLowerCase()
            .replace(/\b\w/g, (char) => char.toUpperCase())
        : '';
      const mappedStateAbbreviation =
        stateAbbreviations[normalizedStateName] ||
        stateAbbreviations[titleCasedStateName];

      if (mappedStateAbbreviation) {
        orderData.shippingInfo.state = mappedStateAbbreviation;
      } else if (/^[A-Za-z]{2}$/.test(normalizedStateName)) {
        orderData.shippingInfo.state = normalizedStateName.toUpperCase();
      } else {
        console.warn(
          `Could not find abbreviation for state: ${fullStateName}. Assuming it is already an abbreviation or is invalid.`
        );
      }

      let shippingInstructions = '';
      let autoLabelDraft = null;
      let newOrderStatus =
        normalizedShippingPreference === SHIPPING_PREFERENCE.KIT
          ? 'shipping_kit_requested'
          : 'order_pending';
      const trackOrderUrl = `https://secondhandcell.com/track-order.html?orderId=${encodeURIComponent(orderId)}&fromEmailLink=1`;
      const trackStatusButtonHtml = `
        <div style="text-align:center; margin-top:18px;">
          <a href="${trackOrderUrl}" class="button-link" style="background-color:#2563eb;">Track your status here</a>
        </div>
      `;

      if (normalizedShippingPreference === SHIPPING_PREFERENCE.KIT) {
        shippingInstructions = `
        <div style="margin-top: 24px;">
          <h2 style="font-size:18px; color:#0f172a; margin:0 0 10px;">Shipping kit instructions</h2>
          <p style="margin:0 0 12px; color:#475569;">We're sending a padded mailer with an adhesive strip, device sleeve, and prepaid USPS label. We'll email tracking as soon as it ships.</p>
          <ol style="margin:0 0 12px 18px; padding-left:18px; color:#475569;">
            <li style="margin-bottom:8px;">When it arrives, place your device in the protective sleeve and add the included padding.</li>
            <li style="margin-bottom:8px;">Include the device ID sticker from the kit (or a note with your order number) inside the mailer.</li>
            <li style="margin-bottom:8px;">Seal the mailer firmly, attach the prepaid label, and drop it at any USPS location.</li>
          </ol>
          <p style="margin:0; color:#475569;">Keep your USPS receipt for tracking. Questions? Just reply to this email.</p>
          ${trackStatusButtonHtml}
        </div>
      `;
      } else {
        const requestedLabelResolution = resolveRequestedLabelCarrier(orderData);
        const requestedLabelCarrier = requestedLabelResolution.carrier;

        console.log('[Submit Order] Requested auto-label carrier resolution', {
          orderId,
          carrier: requestedLabelCarrier,
          ambiguous: requestedLabelResolution.ambiguous,
        });

        const autoLabelWarnings = [];
        let autoLabelMessage =
          'Your order is saved. On the next step, choose your prepaid USPS or UPS label and we’ll email the download link immediately.';

        try {
          const draftOrder = { id: orderId, ...orderData, shipEngineLabels: null };

          if (requestedLabelCarrier === 'ups') {
            const deviceCount = resolveOrderDeviceCount(draftOrder);
            const sku =
              String(draftOrder?.modelId || draftOrder?.modelName || draftOrder?.device || 'PHONE-DEVICE')
                .trim()
                .replace(/[^A-Za-z0-9_-]+/g, '-')
                .toUpperCase();
            const upsCarrierCode = String(
              process.env.SHIPENGINE_UPS_CARRIER_CODE || process.env.UPS_SHIPENGINE_CARRIER_CODE || 'ups'
            ).trim();
            if (!upsCarrierCode) {
              throw buildHttpError('SHIPENGINE_UPS_CARRIER_CODE is required for UPS label generation.', 500);
            }

            await reconnectUpsCarrierConnection();

            const dangerousGoods = [
              {
                id_number: 'UN3481',
                shipping_name: 'Lithium ion batteries contained in equipment',
                product_class: '9',
                transport_mean: 'ground',
              },
            ];

            const requestedWeight = Number(orderData.packageWeightLb);
            const packageWeightLb = Number.isFinite(requestedWeight) && requestedWeight > 0
              ? requestedWeight
              : Math.max(1.5, Number((deviceCount * 1.5).toFixed(2)));

            const labelData = await createShipEngineLabel(
              normalizeCustomerAddress(orderData.shippingInfo),
              SWIFT_BUYBACK_ADDRESS,
              `${orderId}-UPS-INBOUND-DEVICE`,
              {
                dimensions: EMAIL_LABEL_PACKAGE_DATA.dimensions,
                service_code: 'ups_ground',
                carrier_code: upsCarrierCode,
                carrier_id: UPS_CARRIER_ID,
                weight: { value: packageWeightLb, unit: 'pound' },
                products: [
                  {
                    sku,
                    description: draftOrder?.device || draftOrder?.modelName || 'Mobile Phone',
                    quantity: Math.max(1, deviceCount),
                    dangerous_goods: dangerousGoods,
                  },
                ],
                advanced_options: { dangerous_goods: true },
              },
              {
                orderId,
                orderData,
                carrierCode: upsCarrierCode,
                carrierId: UPS_CARRIER_ID,
                carrierName: 'UPS',
                serviceCode: 'ups_ground',
                labelType: 'ups',
                labelSource: 'submit_order_before_write',
                accountNumberConfigured: Boolean(UPS_CONNECTION_PAYLOAD.account_number),
              }
            );

            const singleLabel = buildSingleLabelRecord({
              labelData,
              labelKey: 'ups',
              displayName: 'UPS Shipping Label',
              labelReference: `${orderId}-UPS-INBOUND-DEVICE`,
              serviceCode: 'ups_ground',
              carrierCode: upsCarrierCode,
            });

            if (!singleLabel.downloadUrl) {
              throw buildHttpError('Label PDF link not available from ShipEngine.', 502);
            }

            newOrderStatus = 'label_generated';
            autoLabelDraft = {
              autoLabelStatus: 'generated',
              autoLabelWarnings,
              orderFields: {
                status: newOrderStatus,
                labelGeneratedAt: FieldValue.serverTimestamp(),
                lastStatusUpdateAt: FieldValue.serverTimestamp(),
                trackingNumber: singleLabel.labelRecord.trackingNumber,
                shipEngineLabels: singleLabel.labelRecords,
                shipEngineLabelIds: singleLabel.labelIds,
                shipEngineLabelsLastUpdatedAt: singleLabel.nowTimestamp,
                hasShipEngineLabel: singleLabel.labelIds.length > 0,
                hasActiveShipEngineLabel: singleLabel.hasActive,
                shipEngineLabelId: singleLabel.labelId || singleLabel.labelIds[0] || null,
                labelDeliveryMethod: 'ups',
                labelGeneratedSource: 'submit_order_auto_ups',
                labelVoidStatus: 'active',
                labelVoidMessage: null,
                labelCarrierCode: singleLabel.labelRecord.carrierCode,
                labelServiceCode: singleLabel.labelRecord.serviceCode,
                labelCarrierName: 'UPS',
                labelTrackingCarrierCode: singleLabel.labelRecord.carrierCode,
                labelTrackingStatus: labelData?.status_code || labelData?.statusCode || 'LABEL_CREATED',
                labelTrackingStatusDescription:
                  labelData?.status_description || labelData?.statusDescription || 'Label created',
                labelTrackingCarrierStatusCode:
                  labelData?.carrier_status_code || labelData?.carrierStatusCode || null,
                labelTrackingCarrierStatusDescription:
                  labelData?.carrier_status_description || labelData?.carrierStatusDescription || null,
                labelTrackingLastSyncedAt: FieldValue.serverTimestamp(),
                shipEngineShipmentId:
                  labelData?.shipment_id ||
                  labelData?.shipmentId ||
                  labelData?.shipment?.shipment_id ||
                  null,
                upsLabelUrl: singleLabel.downloadUrl,
              },
            };

            autoLabelMessage =
              'Your prepaid UPS shipping label has been generated and sent to your email, so your order is fully submitted.';

            try {
              await transporter.sendMail(
                buildShippingLabelEmail(
                  { ...orderData, id: orderId },
                  {
                    carrierName: 'UPS',
                    labelDownloadUrl: singleLabel.downloadUrl,
                    trackingNumber: singleLabel.labelRecord.trackingNumber,
                  }
                )
              );
            } catch (emailError) {
              const warning =
                `Label was generated, but the confirmation email failed to send: ${emailError?.message || 'unknown error'}`;
              autoLabelWarnings.push(warning);
              console.error(`[Shipping Label Email] Order ${orderId}:`, emailError);
            }
          } else if (requestedLabelCarrier === 'usps') {
            const deviceCount = resolveOrderDeviceCount(draftOrder);
            const shippingProfile = resolveUspsServiceAndWeightByDeviceCount(deviceCount);

            const labelData = await createShipEngineLabel(
              normalizeCustomerAddress(orderData.shippingInfo),
              SWIFT_BUYBACK_ADDRESS,
              `${orderId}-USPS-INBOUND-DEVICE`,
              {
                dimensions: EMAIL_LABEL_PACKAGE_DATA.dimensions,
                service_code: shippingProfile.serviceCode,
                carrier_code: 'stamps_com',
                weight: { value: shippingProfile.weightOz, unit: 'ounce' },
              },
              {
                orderId,
                orderData,
                carrierCode: 'stamps_com',
                carrierName: 'USPS',
                serviceCode: shippingProfile.serviceCode,
                labelType: 'usps',
                labelSource: 'submit_order_before_write',
              }
            );

            const singleLabel = buildSingleLabelRecord({
              labelData,
              labelKey: 'usps',
              displayName: 'USPS Shipping Label',
              labelReference: `${orderId}-USPS-INBOUND-DEVICE`,
              serviceCode: shippingProfile.serviceCode,
              carrierCode: 'stamps_com',
            });

            if (!singleLabel.downloadUrl) {
              throw buildHttpError('Label PDF link not available from ShipEngine.', 502);
            }

            newOrderStatus = 'label_generated';
            autoLabelDraft = {
              autoLabelStatus: 'generated',
              autoLabelWarnings,
              orderFields: {
                status: newOrderStatus,
                labelGeneratedAt: FieldValue.serverTimestamp(),
                lastStatusUpdateAt: FieldValue.serverTimestamp(),
                trackingNumber: singleLabel.labelRecord.trackingNumber,
                shipEngineLabels: singleLabel.labelRecords,
                shipEngineLabelIds: singleLabel.labelIds,
                shipEngineLabelsLastUpdatedAt: singleLabel.nowTimestamp,
                hasShipEngineLabel: singleLabel.labelIds.length > 0,
                hasActiveShipEngineLabel: singleLabel.hasActive,
                shipEngineLabelId: singleLabel.labelId || singleLabel.labelIds[0] || null,
                labelDeliveryMethod: 'usps',
                labelGeneratedSource: 'submit_order_auto_usps',
                labelVoidStatus: 'active',
                labelVoidMessage: null,
                labelCarrierCode: singleLabel.labelRecord.carrierCode,
                labelServiceCode: singleLabel.labelRecord.serviceCode,
                labelCarrierName: 'USPS',
                labelTrackingCarrierCode: singleLabel.labelRecord.carrierCode,
                labelTrackingStatus: labelData?.status_code || labelData?.statusCode || 'LABEL_CREATED',
                labelTrackingStatusDescription:
                  labelData?.status_description || labelData?.statusDescription || 'Label created',
                labelTrackingCarrierStatusCode:
                  labelData?.carrier_status_code || labelData?.carrierStatusCode || null,
                labelTrackingCarrierStatusDescription:
                  labelData?.carrier_status_description || labelData?.carrierStatusDescription || null,
                labelTrackingLastSyncedAt: FieldValue.serverTimestamp(),
                shipEngineShipmentId:
                  labelData?.shipment_id ||
                  labelData?.shipmentId ||
                  labelData?.shipment?.shipment_id ||
                  null,
                uspsLabelUrl: singleLabel.downloadUrl,
              },
            };

            autoLabelMessage =
              'Your prepaid USPS shipping label has been generated and sent to your email, so your order is fully submitted.';

            try {
              await transporter.sendMail(
                buildShippingLabelEmail(
                  { ...orderData, id: orderId },
                  {
                    carrierName: 'USPS',
                    labelDownloadUrl: singleLabel.downloadUrl,
                    trackingNumber: singleLabel.labelRecord.trackingNumber,
                  }
                )
              );
            } catch (emailError) {
              const warning =
                `Label was generated, but the confirmation email failed to send: ${emailError?.message || 'unknown error'}`;
              autoLabelWarnings.push(warning);
              console.error(`[Shipping Label Email] Order ${orderId}:`, emailError);
            }
          } else {
            const message = requestedLabelResolution.ambiguous
              ? 'Multiple label carrier values were detected in submit payload. Skipping automatic label generation to avoid choosing the wrong carrier.'
              : 'No explicit label carrier was provided. Skipping automatic label generation.';
            autoLabelDraft = {
              autoLabelStatus: 'not_generated',
              autoLabelWarnings: [message],
              orderFields: {},
            };
            newOrderStatus = 'order_pending';
            autoLabelMessage =
              'Your order was submitted without generating a label yet. Please choose UPS or USPS and generate your label from the next step.';
            console.warn(`[Submit Order] Order ${orderId}: ${message}`);
          }
        } catch (labelError) {
          const warning =
            buildShipEngineErrorMessage(
              labelError,
              'Failed to generate prepaid shipping label before submission.'
            );
          autoLabelDraft = {
            autoLabelStatus: 'not_generated',
            autoLabelWarnings: [warning, ...extractShipEngineWarnings(labelError)],
            orderFields: {},
          };
          newOrderStatus = 'order_pending';
          console.warn(`[Submit Order] Proceeding without label for order ${orderId}:`, warning);
        }

        shippingInstructions = `
        <div style="margin-top: 24px;">
          <h2 style="font-size:18px; color:#0f172a; margin:0 0 10px;">Shipping label instructions</h2>
          <p style="margin:0 0 12px; color:#475569;">${autoLabelMessage}</p>
          <ol style="margin:0 0 12px 18px; padding-left:18px; color:#475569;">
            <li style="margin-bottom:8px;">Back up data, remove SIM/eSIM, and sign out of Apple/Google/Samsung accounts.</li>
            <li style="margin-bottom:8px;">Factory reset the device, then wrap it in padding and place it in a sturdy box.</li>
            <li style="margin-bottom:8px;">If your label is ready, print it, seal the box, attach it securely, and keep your carrier receipt.</li>
          </ol>
          <p style="margin:0; color:#475569;">Questions? Reply to this email.</p>
          ${trackStatusButtonHtml}
        </div>
      `;
      }

      const shippingInfo = orderData.shippingInfo || {};
      const conditions = orderData.conditions || {};
      const paymentDetails = orderData.paymentDetails || orderData.paymentInfo || {};

      // Format condition values properly
      const formatCondition = (value) => {
        if (!value || value === 'N/A') return 'N/A';
        if (value === 'yes' || value === 'Yes' || value === true) return 'Yes';
        if (value === 'no' || value === 'No' || value === false) return 'No';
        // Handle cosmetic grades
        if (typeof value === 'string') return value;
        return 'N/A';
      };

      const cosmeticGrade = formatCondition(
        orderData.condition_cosmetic || 
        conditions.cosmetic || 
        conditions.cosmeticCondition || 
        conditions.grade
      );

      const shippingAddress = [
        shippingInfo.streetAddress,
        [shippingInfo.city, shippingInfo.state].filter(Boolean).join(', '),
        shippingInfo.zipCode,
        shippingInfo.country,
      ]
        .filter((part) => part && String(part).trim())
        .join('<br>') || 'Not provided';

      const paymentInfo = paymentDetails.summary
        || paymentDetails.value
        || paymentDetails.details
        || paymentDetails.paypalEmail
        || paymentDetails.zelleEmail
        || paymentDetails.account
        || 'Not provided';

      const customerEmailHtml = ORDER_RECEIVED_EMAIL_HTML
        .replace(/\*\*CUSTOMER_NAME\*\*/g, shippingInfo.fullName || 'Valued customer')
        .replace(/\*\*ORDER_ID\*\*/g, orderId)
        .replace(/\*\*DEVICE_NAME\*\*/g, `${orderData.device || 'Device'} ${orderData.storage || ''}`.trim())
        .replace(/\*\*SHIPPING_INSTRUCTION\*\*/g, shippingInstructions);

      const adminEmailHtml = ORDER_PLACED_ADMIN_EMAIL_HTML
        .replace(/\*\*CUSTOMER_NAME\*\*/g, shippingInfo.fullName || 'Unknown customer')
        .replace(/\*\*CUSTOMER_EMAIL\*\*/g, shippingInfo.email || 'Not provided')
        .replace(/\*\*CUSTOMER_PHONE\*\*/g, shippingInfo.phone || shippingInfo.phoneNumber || 'Not provided')
        .replace(/\*\*ORDER_ID\*\*/g, orderId)
        .replace(/\*\*DEVICE_NAME\*\*/g, orderData.device || 'Unknown device')
        .replace(/\*\*STORAGE\*\*/g, orderData.storage || 'N/A')
        .replace(/\*\*CARRIER\*\*/g, orderData.carrier || 'Not provided')
        .replace(/\*\*ESTIMATED_QUOTE\*\*/g, (orderData.estimatedQuote || 0).toFixed(2))
        .replace(/\*\*PAYMENT_METHOD\*\*/g, orderData.paymentMethod || 'Not provided')
        .replace(/\*\*PAYMENT_INFO\*\*/g, paymentInfo)
        .replace(/\*\*SHIPPING_ADDRESS\*\*/g, shippingAddress)
        .replace(/\*\*COSMETIC_GRADE\*\*/g, cosmeticGrade);

      const customerMailOptions = {
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to: orderData.shippingInfo.email,
        subject: `Your SecondHandCell Order #${orderId} Has Been Received!`,
        html: customerEmailHtml,
      };

      const adminMailOptions = {
        from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
        to: 'sales@secondhandcell.com',
        subject: `${orderData.shippingInfo.fullName} - placed an order for a ${orderData.device}`,
        html: adminEmailHtml,
      };

      const notificationPromises = [
        transporter.sendMail(customerMailOptions),
        transporter.sendMail(adminMailOptions),
        sendAdminPushNotification(
          '⚡ New Order Placed!',
          `Order #${orderId} for ${orderData.device} from ${orderData.shippingInfo.fullName}.`,
          {
            orderId: orderId,
            userId: orderData.userId || 'guest',
            relatedDocType: 'order',
            relatedDocId: orderId,
            relatedUserId: orderData.userId,
          }
        ).catch((e) => console.error('FCM Send Error (New Order):', e)),
      ];

      const adminsSnapshot = await adminsCollection.get();
      adminsSnapshot.docs.forEach((adminDoc) => {
        notificationPromises.push(
          addAdminFirestoreNotification(
            adminDoc.id,
            `New Order: #${orderId} from ${orderData.shippingInfo.fullName}.`,
            'order',
            orderId,
            orderData.userId
          ).catch((e) =>
            console.error('Firestore Notification Error (New Order):', e)
          )
        );
      });

      Promise.allSettled(notificationPromises)
        .then((notificationResults) => {
          notificationResults.forEach((result, index) => {
            if (result.status === 'rejected') {
              console.error(
                `Order notification ${index + 1} failed:`,
                result.reason?.message || result.reason
              );
            }
          });
        })
        .catch((notificationError) => {
          console.error('Unexpected order notification error:', notificationError);
        });

      const toSave = {
        ...orderData,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: newOrderStatus,
        id: orderId,
        ...(autoLabelDraft?.orderFields || {}),
      };
      await writeOrderBoth(orderId, toSave);

      const responsePayload = {
        message: 'Order submitted',
        orderId,
        autoLabelStatus: autoLabelDraft?.autoLabelStatus || 'not_generated',
        warnings: autoLabelDraft?.autoLabelWarnings || [],
      };

      res.status(201).json(responsePayload);
    } catch (err) {
      console.error('Error submitting order:', err);
      const statusCode = err.status || 500;
      res.status(statusCode).json({ error: err.message || 'Failed to submit order' });
    }
  });

  router.post('/api/shipping/generate-usps-label', async (req, res) => {
    try {
      const orderId = String(req.body?.orderId || '').trim();
      if (!orderId) {
        return res.status(400).json({ error: 'orderId is required.' });
      }

      const doc = await ordersCollection.doc(orderId).get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = { id: doc.id, ...doc.data() };
      const deviceCount = resolveOrderDeviceCount(order);
      const shippingProfile = resolveUspsServiceAndWeightByDeviceCount(deviceCount);

      console.log('[ShipEngine] USPS label profile selected', {
        orderId,
        deviceCount,
        chosenService: shippingProfile.chosenService,
        weightOz: shippingProfile.weightOz,
        blocks: shippingProfile.blocks,
      });

      const result = await createSingleInboundLabelForOrder(order, {
        carrierName: 'USPS',
        carrierCode: 'stamps_com',
        serviceCode: shippingProfile.serviceCode,
        weight: { value: shippingProfile.weightOz, unit: 'ounce' },
        labelKey: 'usps',
        labelReferenceSuffix: 'USPS-INBOUND-DEVICE',
        displayName: 'USPS Shipping Label',
        labelDeliveryMethod: 'usps',
        labelGeneratedSource: 'shipping_endpoint_usps',
        urlField: 'uspsLabelUrl',
      });

      return res.json({
        message: 'USPS shipping label generated successfully.',
        orderId,
        labelDownloadUrl: result.labelDownloadUrl,
        trackingNumber: result.trackingNumber,
        carrier: 'USPS',
        carrierCode: result.carrierCode,
        serviceCode: result.serviceCode,
        labelId: result.labelId,
        warnings: result.warnings || [],
      });
    } catch (error) {
      const statusCode = error.status || error.response?.status || 500;
      const responseData = error.responseData || error.response?.data || null;
      console.error('Error generating USPS shipping label:', responseData || error.message || error);
      return res.status(statusCode).json({
        error: error.message || 'Failed to generate USPS shipping label.',
        details: responseData,
        warnings: error.warnings || extractShipEngineWarnings(error),
      });
    }
  });

  router.post('/api/shipping/generate-ups-label', async (req, res) => {
    try {
      const orderId = String(req.body?.orderId || '').trim();
      if (!orderId) {
        return res.status(400).json({ error: 'orderId is required.' });
      }

      const doc = await ordersCollection.doc(orderId).get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = { id: doc.id, ...doc.data() };
      const deviceCount = resolveOrderDeviceCount(order);
      const sku =
        String(order?.modelId || order?.modelName || order?.device || 'PHONE-DEVICE')
          .trim()
          .replace(/[^A-Za-z0-9_-]+/g, '-')
          .toUpperCase();
      const upsCarrierCode = String(
        process.env.SHIPENGINE_UPS_CARRIER_CODE || process.env.UPS_SHIPENGINE_CARRIER_CODE || 'ups'
      ).trim();
      const upsCarrierId = UPS_CARRIER_ID;
      const requestedWeight = Number(req.body?.packageWeightLb);
      const packageWeightLb = Number.isFinite(requestedWeight) && requestedWeight > 0
        ? requestedWeight
        : Math.max(1.5, Number((deviceCount * 1.5).toFixed(2)));

      if (!upsCarrierCode) {
        throw buildHttpError('SHIPENGINE_UPS_CARRIER_CODE is required for UPS label generation.', 500);
      }

      await reconnectUpsCarrierConnection();

      const dangerousGoods = [
        {
          id_number: 'UN3481',
          shipping_name: 'Lithium ion batteries contained in equipment',
          product_class: '9',
          transport_mean: 'ground',
        },
      ];

      const result = await createSingleInboundLabelForOrder(order, {
        carrierName: 'UPS',
        carrierCode: upsCarrierCode,
        carrierId: upsCarrierId,
        serviceCode: 'ups_ground',
        weight: { value: packageWeightLb, unit: 'pound' },
        packageProducts: [
          {
            sku,
            description: order?.device || order?.modelName || 'Mobile Phone',
            quantity: Math.max(1, deviceCount),
            dangerous_goods: dangerousGoods,
          },
        ],
        advancedOptions: {
          dangerous_goods: true,
        },
        labelKey: 'ups',
        labelReferenceSuffix: 'UPS-INBOUND-DEVICE',
        displayName: 'UPS Shipping Label',
        labelDeliveryMethod: 'ups',
        labelGeneratedSource: 'shipping_endpoint_ups',
        urlField: 'upsLabelUrl',
        accountNumberConfigured: Boolean(UPS_CONNECTION_PAYLOAD.account_number),
      });

      return res.json({
        message: 'UPS shipping label generated successfully.',
        orderId,
        labelDownloadUrl: result.labelDownloadUrl,
        trackingNumber: result.trackingNumber,
        carrier: 'UPS',
        carrierCode: result.carrierCode,
        serviceCode: result.serviceCode,
        labelId: result.labelId,
        dangerousGoods,
        warnings: result.warnings || [],
      });
    } catch (error) {
      const statusCode = error.status || error.response?.status || 500;
      const responseData = error.responseData || error.response?.data || null;
      console.error('Error generating UPS shipping label:', responseData || error.message || error);
      return res.status(statusCode).json({
        error: error.message || 'Failed to generate UPS shipping label.',
        details: responseData,
        warnings: error.warnings || extractShipEngineWarnings(error),
      });
    }
  });

  router.post('/generate-label/:id', async (req, res) => {
    try {
      const doc = await ordersCollection.doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ error: 'Order not found' });

      const order = { id: doc.id, ...doc.data() };
      const normalizedShippingPreference = normalizeShippingPreference(
        order.shippingPreferenceNormalized || order.shippingPreference
      );
      const deviceCount = resolveOrderDeviceCount(order);
      const buyerShippingInfo = order.shippingInfo;
      const orderIdForLabel = order.id || 'N/A';
      const nowTimestamp = admin.firestore.Timestamp.now();
      const statusTimestamp = nowTimestamp;
      const labelRecords = cloneShipEngineLabelMap(order.shipEngineLabels);
      const generatedStatus =
        normalizedShippingPreference === SHIPPING_PREFERENCE.KIT
          ? 'needs_printing'
          : 'label_generated';

      const shippingProfile = resolveUspsServiceAndWeightByDeviceCount(deviceCount);

      const outboundPackageData = {
        service_code: shippingProfile.serviceCode,
        dimensions: { unit: 'inch', height: 2, width: 4, length: 6 },
        weight: { value: shippingProfile.weightOz, unit: 'ounce' },
      };

      const inboundPackageData = {
        service_code: shippingProfile.serviceCode,
        dimensions: { unit: 'inch', height: 2, width: 4, length: 6 },
        weight: { value: shippingProfile.weightOz, unit: 'ounce' },
      };

      const swiftBuyBackAddress = {
        name: 'SHC Returns',
        company_name: 'SecondHandCell',
        phone: '3475591707',
        address_line1: '1602 MCDONALD AVE STE REAR ENTRANCE',
        city_locality: 'Brooklyn',
        state_province: 'NY',
        postal_code: '11230-6336',
        country_code: 'US',
      };

      const buyerAddress = {
        name: buyerShippingInfo.fullName,
        phone: '3475591707',
        address_line1: buyerShippingInfo.streetAddress,
        city_locality: buyerShippingInfo.city,
        state_province: buyerShippingInfo.state,
        postal_code: buyerShippingInfo.zipCode,
        country_code: 'US',
      };

      console.log('[ShipEngine] label profile selected', {
        orderId: orderIdForLabel,
        deviceCount,
        chosenService: shippingProfile.chosenService,
        weightOz: shippingProfile.weightOz,
        blocks: shippingProfile.blocks,
      });

      let updateData = {
        status: generatedStatus,
        labelGeneratedAt: statusTimestamp,
        lastStatusUpdateAt: statusTimestamp,
      };
      if (generatedStatus === 'needs_printing') {
        updateData.needsPrintingAt = statusTimestamp;
      }
      let customerEmailSubject = '';
      let customerEmailHtml = '';
      let customerMailOptions;

      if (normalizedShippingPreference === SHIPPING_PREFERENCE.KIT) {
        const outboundLabelData = await createShipEngineLabel(
          swiftBuyBackAddress,
          buyerAddress,
          `${orderIdForLabel}-OUTBOUND-KIT`,
          outboundPackageData,
          {
            orderId: orderIdForLabel,
            orderData: order,
            deviceCount,
            chosenService: shippingProfile.chosenService,
            weightOz: shippingProfile.weightOz,
            blocks: shippingProfile.blocks,
          }
        );

        const inboundLabelData = await createShipEngineLabel(
          buyerAddress,
          swiftBuyBackAddress,
          `${orderIdForLabel}-INBOUND-DEVICE`,
          inboundPackageData,
          {
            orderId: orderIdForLabel,
            orderData: order,
            deviceCount,
            chosenService: shippingProfile.chosenService,
            weightOz: shippingProfile.weightOz,
            blocks: shippingProfile.blocks,
          }
        );

        labelRecords.outbound = {
          id:
            outboundLabelData.label_id ||
            outboundLabelData.labelId ||
            outboundLabelData.shipengine_label_id ||
            null,
          trackingNumber: outboundLabelData.tracking_number || null,
          downloadUrl: outboundLabelData.label_download?.pdf || null,
          carrierCode:
            outboundLabelData.shipment?.carrier_id ||
            outboundLabelData.carrier_code ||
            null,
          serviceCode:
            outboundLabelData.shipment?.service_code ||
            outboundPackageData.service_code ||
            null,
          generatedAt: nowTimestamp,
          createdAt: nowTimestamp,
          status: 'active',
          voidStatus: 'active',
          message: null,
          displayName: 'Outbound Shipping Label',
          labelReference: `${orderIdForLabel}-OUTBOUND-KIT`,
        };

        labelRecords.inbound = {
          id:
            inboundLabelData.label_id ||
            inboundLabelData.labelId ||
            inboundLabelData.shipengine_label_id ||
            null,
          trackingNumber: inboundLabelData.tracking_number || null,
          downloadUrl: inboundLabelData.label_download?.pdf || null,
          carrierCode:
            inboundLabelData.shipment?.carrier_id ||
            inboundLabelData.carrier_code ||
            null,
          serviceCode:
            inboundLabelData.shipment?.service_code ||
            inboundPackageData.service_code ||
            null,
          generatedAt: nowTimestamp,
          createdAt: nowTimestamp,
          status: 'active',
          voidStatus: 'active',
          message: null,
          displayName: 'Inbound Shipping Label',
          labelReference: `${orderIdForLabel}-INBOUND-DEVICE`,
        };

        updateData = {
          ...updateData,
          outboundLabelUrl: outboundLabelData.label_download?.pdf,
          outboundTrackingNumber: outboundLabelData.tracking_number,
          inboundLabelUrl: inboundLabelData.label_download?.pdf,
          inboundTrackingNumber: inboundLabelData.tracking_number,
          uspsLabelUrl: inboundLabelData.label_download?.pdf,
          trackingNumber: inboundLabelData.tracking_number,
        };

        customerEmailSubject = `Your SecondHandCell Shipping Kit for Order #${order.id} is on its Way!`;
        customerEmailHtml = SHIPPING_KIT_EMAIL_HTML
          .replace(/\*\*CUSTOMER_NAME\*\*/g, order.shippingInfo.fullName)
          .replace(/\*\*ORDER_ID\*\*/g, order.id)
          .replace(
            /\*\*TRACKING_NUMBER\*\*/g,
            outboundLabelData.tracking_number || 'N/A'
          );

        customerMailOptions = {
          from: `${process.env.EMAIL_NAME} <${process.env.EMAIL_USER}>`,
          to: order.shippingInfo.email,
          subject: customerEmailSubject,
          html: customerEmailHtml,
        };
      } else {
        throw buildHttpError(
          'Regular customer labels now require the dedicated shipping endpoints: /api/shipping/generate-usps-label or /api/shipping/generate-ups-label.',
          400
        );
      }

      const labelIds = buildLabelIdList(labelRecords);
      const hasActive = Object.values(labelRecords).some((entry) =>
        entry && entry.id ? isLabelPendingVoid(entry) : false
      );

      updateData = {
        ...updateData,
        shipEngineLabels: labelRecords,
        shipEngineLabelIds: labelIds,
        shipEngineLabelsLastUpdatedAt: nowTimestamp,
        hasShipEngineLabel: labelIds.length > 0,
        hasActiveShipEngineLabel: hasActive,
        shipEngineLabelId:
          labelRecords.inbound?.id ||
          labelRecords.email?.id ||
          labelIds[0] ||
          null,
        labelVoidStatus: labelIds.length ? 'active' : order.labelVoidStatus || null,
        labelVoidMessage: null,
      };

      await updateOrderBoth(req.params.id, updateData);

      await transporter.sendMail(customerMailOptions);

      res.json({ message: 'Label(s) generated successfully', orderId: order.id, ...updateData });
    } catch (err) {
      const responseData = err.response?.data || err.responseData;
      const statusCode = err.status || err.response?.status || 500;
      console.error('Error generating label:', responseData || err.message || err);
      res
        .status(statusCode)
        .json({ error: 'Failed to generate label', details: responseData || err.message });
    }
  });

  router.post('/orders/:id/void-label', async (req, res) => {
    try {
      const orderId = req.params.id;
      const labels = Array.isArray(req.body?.labels) ? req.body.labels : [];
      if (!labels.length) {
        return res
          .status(400)
          .json({ error: 'Please select at least one label to void.' });
      }

      const doc = await ordersCollection.doc(orderId).get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = { id: doc.id, ...doc.data() };
      const { results } = await handleLabelVoid(order, labels, {
        reason: 'manual',
      });

      // Silently void label - no customer email sent
      // Status automatically set to "canceled" by handleLabelVoid

      res.json({ orderId, results });
    } catch (error) {
      console.error('Error voiding label(s):', error);
      res.status(500).json({
        error: error.message || 'Failed to void the selected label(s).',
      });
    }
  });

  router.post('/orders/:id/clear-data', async (req, res) => {
    try {
      const orderId = req.params.id;
      const selections = Array.isArray(req.body?.selections) ? req.body.selections : [];
      
      if (!selections.length) {
        return res.status(400).json({ error: 'No data selections provided.' });
      }

      const doc = await ordersCollection.doc(orderId).get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const updatePayload = {};
      const clearedItems = [];

      for (const selection of selections) {
        if (selection === 'shipLabel:primary') {
          updatePayload.labelUrl = FieldValue.delete();
          updatePayload.trackingNumber = FieldValue.delete();
          updatePayload.shipEngineLabelId = FieldValue.delete();
          clearedItems.push('Primary shipping label');
        } else if (selection === 'shipLabel:outboundkit') {
          updatePayload.outboundLabelUrl = FieldValue.delete();
          updatePayload.outboundTrackingNumber = FieldValue.delete();
          clearedItems.push('Outbound kit label');
        } else if (selection === 'shipLabel:inbounddevice') {
          updatePayload.inboundLabelUrl = FieldValue.delete();
          updatePayload.inboundTrackingNumber = FieldValue.delete();
          clearedItems.push('Inbound device label');
        } else if (selection === 'tracking:primary') {
          updatePayload.trackingNumber = FieldValue.delete();
          clearedItems.push('Primary tracking number');
        } else if (selection === 'tracking:outbound') {
          updatePayload.outboundTrackingNumber = FieldValue.delete();
          clearedItems.push('Outbound tracking number');
        } else if (selection === 'tracking:inbound') {
          updatePayload.inboundTrackingNumber = FieldValue.delete();
          clearedItems.push('Inbound tracking number');
        } else if (selection === 'returnLabel') {
          updatePayload.returnLabelUrl = FieldValue.delete();
          updatePayload.returnTrackingNumber = FieldValue.delete();
          clearedItems.push('Return label');
        } else if (selection.startsWith('shipLabel:')) {
          const labelKey = selection.replace('shipLabel:', '');
          updatePayload[`shipEngineLabels.${labelKey}`] = FieldValue.delete();
          clearedItems.push(`Label: ${labelKey}`);
        }
      }

      if (Object.keys(updatePayload).length === 0) {
        return res.status(400).json({ error: 'No valid selections to clear.' });
      }

      await updateOrderBoth(orderId, updatePayload);

      res.json({
        success: true,
        message: `Cleared: ${clearedItems.join(', ')}`,
        clearedItems,
      });
    } catch (error) {
      console.error('Error clearing order data:', error);
      res.status(500).json({
        error: error.message || 'Failed to clear selected data.',
      });
    }
  });

  router.get('/packing-slip/:id', async (req, res) => {
    try {
      const doc = await ordersCollection.doc(req.params.id).get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = { id: doc.id, ...doc.data() };
      const pdfData = await generateCustomLabelPdf(order);
      const buffer = Buffer.isBuffer(pdfData) ? pdfData : Buffer.from(pdfData);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="packing-slip-${order.id}.pdf"`
      );
      res.send(buffer);
    } catch (error) {
      console.error('Failed to generate packing slip PDF:', error);
      res.status(500).json({ error: 'Failed to generate packing slip PDF' });
    }
  });

  router.get('/print-bundle/:id', async (req, res) => {
    try {
      const doc = await ordersCollection.doc(req.params.id).get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = { id: doc.id, ...doc.data() };

      async function fetchPdfBuffer(url) {
        if (!url) {
          return null;
        }

        try {
          const response = await axios.get(url, { responseType: 'arraybuffer' });
          const buffer = Buffer.from(response.data);
          return buffer.length ? buffer : null;
        } catch (downloadError) {
          console.error(
            `Failed to download print-bundle PDF part from ${url}:`,
            downloadError.message || downloadError
          );
          return null;
        }
      }

      function resolveRequestOrigin(request) {
        const forwardedProtoRaw = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
        const forwardedHostRaw = String(request.headers['x-forwarded-host'] || '').split(',')[0].trim();
        const hostRaw = String(request.get('host') || '').trim();
        const protocol = forwardedProtoRaw || request.protocol || 'https';
        const host = forwardedHostRaw || hostRaw;
        return host ? `${protocol}://${host}` : null;
      }

      const origin = resolveRequestOrigin(req);
      const basePath = String(req.baseUrl || '').replace(/\/$/, '');
      const packingSlipPath = `${basePath}/packing-slip/${encodeURIComponent(order.id)}`;
      const packingSlipUrl = origin ? `${origin}${packingSlipPath}` : null;

      const labelUrls = Array.from(collectLabelUrlCandidates(order));
      const labelBuffers = [];

      for (const labelUrl of labelUrls) {
        const buffer = await fetchPdfBuffer(labelUrl);
        if (buffer) {
          labelBuffers.push(buffer);
        }
      }

      const packingSlipBuffer = await fetchPdfBuffer(packingSlipUrl);

      if (!labelUrls.length) {
        return res.status(400).json({
          error: 'Missing required label URL(s): no shipping label URL found on order',
        });
      }

      const pdfParts = [...labelBuffers, packingSlipBuffer].filter(Boolean);
      if (!pdfParts.length) {
        return res.status(500).json({ error: 'Failed to prepare print bundle' });
      }

      const merged = await mergePdfBuffers(pdfParts);
      const mergedBuffer = Buffer.isBuffer(merged) ? merged : Buffer.from(merged);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="print-bundle-${order.id}.pdf"`
      );
      res.send(mergedBuffer);
    } catch (error) {
      console.error('Failed to generate print bundle:', error);
      res.status(500).json({ error: 'Failed to prepare print bundle' });
    }
  });

  async function repairLabelGeneratedOrders(req, res) {
    try {
      const snapshot = await ordersCollection.where('status', '==', 'label_generated').get();
      const timestamp = admin.firestore.FieldValue.serverTimestamp();

      let updatedCount = 0;

      await Promise.all(
        snapshot.docs.map(async (doc) => {
          const data = doc.data() || {};
          const deliveryMethod = (data.labelDeliveryMethod || data.shippingPreference || '').toString().toLowerCase();
          const isKitDelivery = deliveryMethod.includes('kit');
          const alreadySent = Boolean(data.kitSentAt);

          if (!isKitDelivery || alreadySent) {
            return;
          }

          const targetStatus = isKitDelivery ? 'kit_needs_printing' : 'needs_printing';

          try {
            const needsPrintingAt = data.needsPrintingAt || timestamp;
            await updateOrderBoth(doc.id, {
              status: targetStatus,
              needsPrintingAt,
              lastStatusUpdateAt: timestamp,
            });
            updatedCount += 1;
          } catch (updateError) {
            console.error(`Failed to reset label_generated order ${doc.id}:`, updateError);
          }
        })
      );

      res.json({ processedCount: snapshot.size, updatedCount });
    } catch (error) {
      console.error('Failed to repair label-generated orders:', error);
      res.status(500).json({ error: 'Unable to repair label-generated orders' });
    }
  }

  router.post('/repair-label-generated', repairLabelGeneratedOrders);
  router.post('/orders/repair-label-generated', repairLabelGeneratedOrders);

  // Helper function for logging shipping address
  function formatShippingAddressForLog(shippingInfo = {}) {
    if (!shippingInfo || typeof shippingInfo !== 'object') {
      return 'N/A';
    }

    const parts = [];
    if (shippingInfo.streetAddress) {
      parts.push(shippingInfo.streetAddress);
    }

    const cityState = [shippingInfo.city, shippingInfo.state]
      .filter((value) => value && String(value).trim().length)
      .join(', ');

    if (cityState) {
      const withZip = shippingInfo.zipCode
        ? `${cityState} ${shippingInfo.zipCode}`
        : cityState;
      parts.push(withZip);
    } else if (shippingInfo.zipCode) {
      parts.push(shippingInfo.zipCode);
    }

    return parts.length ? parts.join(', ') : 'N/A';
  }

  router.put('/orders/:id/shipping-info', async (req, res) => {
    try {
      const orderId = req.params.id;
      const incoming = req.body && typeof req.body === 'object' ? req.body : {};

      if (!orderId) {
        return res.status(400).json({ error: 'Order ID is required.' });
      }

      const orderRef = ordersCollection.doc(orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) {
        return res.status(404).json({ error: 'Order not found.' });
      }

      const existingOrder = orderSnap.data() || {};
      const fieldLabels = {
        fullName: 'Full name',
        email: 'Email',
        phone: 'Phone',
        streetAddress: 'Street address',
        city: 'City',
        state: 'State',
        zipCode: 'ZIP / Postal code',
      };

      const updatePayload = {};
      const providedFields = Object.keys(fieldLabels).filter((field) =>
        Object.prototype.hasOwnProperty.call(incoming, field)
      );

      if (!providedFields.length) {
        return res.status(400).json({ error: 'No shipping fields were provided.' });
      }

      for (const field of providedFields) {
        const label = fieldLabels[field];
        let value = incoming[field];
        if (typeof value === 'string') {
          value = value.trim();
        }

        if (!value) {
          return res.status(400).json({ error: `${label} is required.` });
        }

        if (field === 'state') {
          value = String(value).toUpperCase();
          if (value.length !== 2) {
            return res
              .status(400)
              .json({ error: 'State must use the 2-letter abbreviation.' });
          }
        }

        updatePayload[`shippingInfo.${field}`] = value;
      }

      const mergedShippingInfo = {
        ...(existingOrder.shippingInfo || {}),
        ...providedFields.reduce((acc, field) => {
          acc[field] = updatePayload[`shippingInfo.${field}`];
          return acc;
        }, {}),
      };

      const logEntries = [
        {
          type: 'update',
          message: `Updated shipping address: ${formatShippingAddressForLog(mergedShippingInfo)}`,
        },
      ];

      const { order } = await updateOrderBoth(orderId, updatePayload, {
        autoLogStatus: false,
        logEntries,
      });

      res.json({
        message: 'Shipping address updated.',
        shippingInfo: order.shippingInfo || {},
      });
    } catch (error) {
      console.error('Error updating shipping info:', error);
      res.status(500).json({ error: 'Failed to update shipping address.' });
    }
  });

  router.delete('/orders/:id/shipping-info', async (req, res) => {
    try {
      const orderId = req.params.id;

      if (!orderId) {
        return res.status(400).json({ error: 'Order ID is required.' });
      }

      const orderRef = ordersCollection.doc(orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) {
        return res.status(404).json({ error: 'Order not found.' });
      }

      const logEntries = [
        {
          type: 'update',
          message: 'Deleted shipping address',
        },
      ];

      const { order } = await updateOrderBoth(orderId, { shippingInfo: null }, {
        autoLogStatus: false,
        logEntries,
      });

      res.json({
        message: 'Shipping address deleted.',
        shippingInfo: null,
      });
    } catch (error) {
      console.error('Error deleting shipping info:', error);
      res.status(500).json({ error: 'Failed to delete shipping address.' });
    }
  });

  // Issue Resolved endpoint - customer confirms issue fixed
  router.get('/orders/:id/issue-resolved', async (req, res) => {
    try {
      const orderId = String(req.params.id || '').trim();
      if (!orderId) {
        return res.status(400).send('Order ID is required.');
      }

      const deviceKey = req.query.deviceKey ? String(req.query.deviceKey).trim() : null;

      const orderRef = ordersCollection.doc(orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) {
        return res.status(404).send('Order not found.');
      }

      const order = { id: orderSnap.id, ...orderSnap.data() };
      
      // Determine which device was resolved
      const resolvedDeviceKey = deviceKey || buildOrderDeviceKey(orderId, 0);

      const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
      const deleteField = admin.firestore.FieldValue.delete();

      // Build update payload
      const updatePayload = {
        [`deviceStatusByKey.${resolvedDeviceKey}`]: 'issue_resolved',
        [`qcDataByDevice.${resolvedDeviceKey}`]: deleteField,
        [`qcIssuesByDevice.${resolvedDeviceKey}`]: deleteField,
        lastUpdatedAt: serverTimestamp,
      };

      // Derive order status from all devices
      const nextDeviceStatusByKey = {
        ...(order.deviceStatusByKey || {}),
        [resolvedDeviceKey]: 'issue_resolved',
      };
      const derivedStatus = deriveOrderStatusFromDevices(order, nextDeviceStatusByKey);
      if (derivedStatus) {
        updatePayload.status = derivedStatus;
      } else {
        // If not all devices are in terminal states, check if single device order
        const deviceKeys = collectOrderDeviceKeys(order);
        if (deviceKeys.length === 1) {
          updatePayload.status = 'issue_resolved';
        }
      }

      // Update order
      await updateOrderBoth(orderRef, updatePayload, {
        context: 'Issue resolved by customer via email link',
        autoLogStatus: false,
      });

      // Send admin notification
      try {
        const deviceIndex = resolvedDeviceKey.split('::')[1] || '0';
        const notificationMessage = `Customer confirmed issue resolved for order #${orderId} (Device ${Number(deviceIndex) + 1})`;
        await addAdminFirestoreNotification({
          title: 'Issue Resolved',
          message: notificationMessage,
          orderId,
          deviceKey: resolvedDeviceKey,
          type: 'issue_resolved',
          createdAt: serverTimestamp,
        });
        await sendAdminPushNotification('Issue Resolved', notificationMessage);
      } catch (notifError) {
        console.error('Failed to send admin notification:', notifError);
      }

      // Redirect to confirmation page with device context
      const deviceIndex = Number(resolvedDeviceKey.split('::')[1] || '0');
      const confirmationParams = new URLSearchParams({
        orderId,
        deviceKey: resolvedDeviceKey,
        deviceLabel: `Device ${deviceIndex + 1}`,
      });
      return res.redirect(`/issue-resolved-confirmation.html?${confirmationParams.toString()}`);
    } catch (error) {
      console.error('Error processing issue resolution:', error);
      return res.status(500).send('Failed to process issue resolution.');
    }
  });

  return router;
}

module.exports = createOrdersRouter;
