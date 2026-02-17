const axios = require('axios');

const DEFAULT_PHONECHECK_BASE_URL = 'https://clientapiv2.phonecheck.com';
const DEFAULT_PHONECHECK_SAMSUNG_BASE_URL = 'https://api.phonecheck.com';
const APPLE_HINT_REGEX = /(apple|iphone|ipad|ipod|ios|watch)/i;
const SAMSUNG_HINT_REGEX = /(samsung|galaxy)/i;
const COLOR_PHRASES = [
  'natural titanium',
  'blue titanium',
  'black titanium',
  'white titanium',
  'rose gold',
  'space gray',
  'space grey',
  'jet black',
  'pacific blue',
  'sierra blue',
  'product red',
  'midnight green',
  'space black',
  'midnight',
  'starlight',
  'graphite',
  'violet',
  'cream',
  'purple',
  'black',
  'white',
  'green',
  'yellow',
  'orange',
  'coral',
  'silver',
  'pink',
  'blue',
  'gold',
  'red',
  'titanium',
]
  .map((phrase) => phrase.trim())
  .filter(Boolean)
  .sort((a, b) => b.length - a.length);

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function stripHtml(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function extractSummaryValue(summary, label) {
  if (!summary || typeof summary !== 'string') {
    return null;
  }
  const sanitized = stripHtml(summary);
  if (!sanitized) {
    return null;
  }
  const regex = new RegExp(`${label}\s*:\s*([^\n]+)`, 'i');
  const match = sanitized.match(regex);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

function detectStorageFromText(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const match = text.match(/(\d+(?:\.\d+)?\s?(?:TB|GB|MB))/i);
  if (match) {
    return match[0].toUpperCase().replace(/\s+/g, '');
  }
  return null;
}

function detectColorFromModel(modelName) {
  if (typeof modelName !== 'string') {
    return null;
  }
  const normalized = modelName.replace(/\([^)]*\)/g, ' ').toLowerCase();
  for (const phrase of COLOR_PHRASES) {
    if (normalized.includes(phrase)) {
      return phrase
        .split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }
  }
  const storageMatch = normalized.match(/\d+(?:\.\d+)?\s?(?:tb|gb|mb)/i);
  if (storageMatch) {
    const after = normalized.slice(storageMatch.index + storageMatch[0].length).trim();
    if (after) {
      const cleaned = after.replace(/[^a-z\s]/gi, ' ').trim();
      if (cleaned) {
        return cleaned
          .split(' ')
          .filter(Boolean)
          .slice(0, 3)
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
      }
    }
  }
  return null;
}

function normalizeCarrierLockValue(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = stripHtml(value).toLowerCase();
  if (!cleaned) {
    return null;
  }
  if (cleaned.includes('unlock')) {
    return 'Unlocked';
  }
  if (cleaned.includes('lock')) {
    return 'Locked';
  }
  return value.trim();
}

function isAppleDeviceHint(...values) {
  return values.some((value) => typeof value === 'string' && APPLE_HINT_REGEX.test(value));
}

function isSamsungDeviceHint(...values) {
  return values.some((value) => typeof value === 'string' && SAMSUNG_HINT_REGEX.test(value));
}

function getPhonecheckConfig() {
  const apiKey = process.env.IMEI_API;
  const username = process.env.IMEI_USERNAME;
  const baseUrl = process.env.IMEI_BASE_URL || DEFAULT_PHONECHECK_BASE_URL;

  if (!apiKey || !username) {
    const missing = [];
    if (!apiKey) missing.push('IMEI_API');
    if (!username) missing.push('IMEI_USERNAME');
    const error = new Error(`Missing required Phonecheck environment variables: ${missing.join(', ')}`);
    error.code = 'phonecheck/missing-config';
    throw error;
  }

  return { apiKey, username, baseUrl };
}

function getSamsungPhonecheckConfig() {
  const token =
    process.env.PHONECHECK_SAMSUNG_TOKEN ||
    process.env.PHONECHECK_MASTER_TOKEN ||
    process.env.PHONECHECK_TOKEN;
  const baseUrl = process.env.PHONECHECK_SAMSUNG_BASE_URL || DEFAULT_PHONECHECK_SAMSUNG_BASE_URL;

  if (!token) {
    const error = new Error('Missing required Phonecheck Samsung token environment variable.');
    error.code = 'phonecheck/missing-config';
    throw error;
  }

  return { token, baseUrl };
}

function normalizePhonecheckBoolean(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    const collapsed = normalized.replace(/[^a-z0-9]+/g, ' ').trim();
    const tokens = collapsed ? collapsed.split(/\s+/) : [];

    const containsPhrase = (phrase) => collapsed.includes(phrase);
    const containsToken = (list) => list.some((token) => tokens.includes(token));

    if (
      containsToken([
        'bad',
        'barred',
        'blacklist',
        'blacklisted',
        'blocked',
        'lost',
        'stolen',
        'unpaid',
        'delinquent',
        'negative',
        'fail',
        'failed',
        'ub',
        'ob',
        'fraud',
        'financial',
        'stole',
        'theft',
      ]) ||
      containsPhrase('outstanding balance') ||
      containsPhrase('unpaid bill') ||
      containsPhrase('unpaid bills') ||
      containsPhrase('active payment') ||
      containsPhrase('payment plan') ||
      containsPhrase('finance') ||
      containsPhrase('financed') ||
      containsPhrase('ineligible') ||
      containsPhrase('not eligible') ||
      containsPhrase('not clean') ||
      containsPhrase('not clear') ||
      containsPhrase('not good') ||
      containsPhrase('not paid') ||
      containsPhrase('past due')
    ) {
      return true;
    }

    if (
      containsToken([
        'clean',
        'clear',
        'good',
        'eligible',
        'pass',
        'passed',
        'paid',
      ]) ||
      containsPhrase('no issues') ||
      containsPhrase('no issue') ||
      containsPhrase('device is eligible') ||
      containsPhrase('esn good') ||
      containsPhrase('status clean')
    ) {
      return false;
    }
  }
  return null;
}

function normalizePhonecheckResponse(raw = {}) {
  const remarks = typeof raw.Remarks === 'string' ? raw.Remarks.trim() : null;
  const api = typeof raw.API === 'string' ? raw.API.trim() : null;
  const reportedDeviceId = typeof raw.deviceid === 'string' ? raw.deviceid.trim() : null;

  let summary = null;
  let structuredResponse = null;
  if (typeof raw.RawResponse === 'string') {
    summary = raw.RawResponse.trim() || null;
  } else if (raw.RawResponse && typeof raw.RawResponse === 'object') {
    structuredResponse = raw.RawResponse;
    if (typeof raw.RawResponse.result === 'string') {
      summary = raw.RawResponse.result.trim() || null;
    } else {
      try {
        summary = JSON.stringify(raw.RawResponse);
      } catch (error) {
        summary = null;
      }
    }
  }

  const nestedData = structuredResponse && typeof structuredResponse.data === 'object' && structuredResponse.data !== null
    ? structuredResponse.data
    : null;

  const carrier = pickFirstString(
    structuredResponse?.carrier,
    structuredResponse?.Carrier,
    nestedData?.carrier,
    nestedData?.Carrier,
    typeof raw.Carrier === 'string' ? raw.Carrier : null,
    typeof raw.carrier === 'string' ? raw.carrier : null,
  );

  const normalized = {
    remarks,
    carrier: carrier ? carrier.trim() : null,
    api,
    deviceId: reportedDeviceId,
    summary,
    raw,
  };

  if (!normalized.carrier) {
    delete normalized.carrier;
  }

  const derivedBlacklist = normalizePhonecheckBoolean(remarks) ?? normalizePhonecheckBoolean(summary);
  if (derivedBlacklist !== null) {
    normalized.blacklisted = derivedBlacklist;
  }

  const brand = pickFirstString(
    structuredResponse?.brandname,
    structuredResponse?.brand,
    structuredResponse?.BrandName,
    structuredResponse?.Brand,
    nestedData?.brandname,
    nestedData?.brand,
    nestedData?.Brand,
  );

  const model = pickFirstString(
    structuredResponse?.modelname,
    structuredResponse?.model,
    structuredResponse?.ModelName,
    structuredResponse?.Model,
    structuredResponse?.marketingname,
    structuredResponse?.MarketingName,
    nestedData?.model,
    nestedData?.modelname,
    nestedData?.Model,
    nestedData?.description,
  );

  const deviceName = pickFirstString(
    structuredResponse?.deviceName,
    structuredResponse?.DeviceName,
    structuredResponse?.modelDescription,
    structuredResponse?.ModelDescription,
    nestedData?.model,
    nestedData?.description,
    extractSummaryValue(summary, 'Model Description'),
    extractSummaryValue(summary, 'Model'),
  );

  const storage = pickFirstString(
    structuredResponse?.storage,
    structuredResponse?.Storage,
    structuredResponse?.memory,
    structuredResponse?.Memory,
    nestedData?.storage,
    nestedData?.Storage,
    nestedData?.memory,
    nestedData?.Memory,
    detectStorageFromText(model),
    detectStorageFromText(deviceName),
    detectStorageFromText(summary),
  );

  const color = pickFirstString(
    structuredResponse?.color,
    structuredResponse?.Color,
    nestedData?.color,
    nestedData?.Color,
    detectColorFromModel(model || deviceName || ''),
  );

  const lockedCarrier = pickFirstString(
    structuredResponse?.lockedCarrier,
    structuredResponse?.LockedCarrier,
    structuredResponse?.Lockedcarrier,
    nestedData?.carrier,
    nestedData?.Carrier,
    extractSummaryValue(summary, 'Locked Carrier'),
  );

  const carrierLock = pickFirstString(
    structuredResponse?.simlock,
    structuredResponse?.Simlock,
    structuredResponse?.SimLockStatus,
    structuredResponse?.SimlockStatus,
    structuredResponse && structuredResponse['Sim-Lock Status'],
    nestedData?.simlock,
    nestedData?.Simlock,
    extractSummaryValue(summary, 'Sim-Lock Status'),
  );

  const warrantyStatus = pickFirstString(
    structuredResponse?.warrantystatus,
    structuredResponse?.WarrantyStatus,
    extractSummaryValue(summary, 'Warranty Status'),
  );

  const blacklistStatus = pickFirstString(
    structuredResponse?.blackliststatus,
    structuredResponse?.BlacklistStatus,
    nestedData?.blackliststatus,
    nestedData?.BlacklistStatus,
  );

  if (brand) {
    normalized.brand = brand;
  }
  if (model) {
    normalized.model = model;
  }
  if (deviceName) {
    normalized.deviceName = deviceName;
  }
  if (color) {
    normalized.color = color;
  }
  if (storage) {
    normalized.storage = storage;
  }
  if (lockedCarrier) {
    normalized.lockedCarrier = lockedCarrier;
  }
  const normalizedCarrierLock = normalizeCarrierLockValue(carrierLock);
  if (normalizedCarrierLock) {
    normalized.carrierLock = normalizedCarrierLock;
  } else if (carrierLock) {
    normalized.carrierLock = carrierLock;
  }
  if (warrantyStatus) {
    normalized.warrantyStatus = warrantyStatus;
  }
  if (blacklistStatus && normalized.blacklisted === undefined) {
    normalized.blacklisted = normalizePhonecheckBoolean(blacklistStatus);
  }

  return normalized;
}

function normalizeSamsungCarrierInfo(raw = {}) {
  const data = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' ? raw.data : raw;

  const normalized = {};

  const fullName = pickFirstString(
    data?.fullName,
    data?.FullName,
    data?.modelDescription,
    data?.ModelDescription,
    data?.description,
    data?.Description,
  );
  if (fullName) {
    normalized.fullName = fullName;
  }

  const imei = pickFirstString(data?.imei, data?.IMEI);
  if (imei) {
    normalized.imei = imei;
  }

  const serialNumber = pickFirstString(data?.serialNumber, data?.SerialNumber, data?.serial, data?.Serial);
  if (serialNumber) {
    normalized.serialNumber = serialNumber;
  }

  const modelNumber = pickFirstString(
    data?.modelNumber,
    data?.ModelNumber,
    data?.modelCode,
    data?.ModelCode,
    data?.SKU,
  );
  if (modelNumber) {
    normalized.modelNumber = modelNumber;
  }

  const modelDescription = pickFirstString(
    data?.modelDescription,
    data?.ModelDescription,
    data?.description,
    data?.Description,
  );
  if (modelDescription) {
    normalized.modelDescription = modelDescription;
  }

  const warranty = pickFirstString(data?.warranty, data?.Warranty, data?.warrantyStatus, data?.WarrantyStatus);
  if (warranty) {
    normalized.warranty = warranty;
  }

  const productionDate = pickFirstString(data?.productionDate, data?.ProductionDate);
  if (productionDate) {
    normalized.productionDate = productionDate;
  }

  const warrantyUntil = pickFirstString(data?.warrantyUntil, data?.WarrantyUntil);
  if (warrantyUntil) {
    normalized.warrantyUntil = warrantyUntil;
  }

  const manufacturer = pickFirstString(data?.manufacturer, data?.Manufacturer);
  if (manufacturer) {
    normalized.manufacturer = manufacturer;
  }

  const carrier = pickFirstString(data?.carrier, data?.Carrier);
  if (carrier) {
    normalized.carrier = carrier;
  }

  const soldBy = pickFirstString(data?.soldBy, data?.SoldBy);
  if (soldBy) {
    normalized.soldBy = soldBy;
  }

  const purchaseDate = pickFirstString(data?.purchaseDate, data?.PurchaseDate);
  if (purchaseDate) {
    normalized.purchaseDate = purchaseDate;
  }

  const country = pickFirstString(data?.country, data?.Country);
  if (country) {
    normalized.country = country;
  }

  if (typeof raw.fromCache === 'boolean') {
    normalized.fromCache = raw.fromCache;
  }

  if (Array.isArray(raw.serviceProviders) && raw.serviceProviders.length > 0) {
    normalized.serviceProviders = raw.serviceProviders.map((provider) => ({ ...provider }));
  }

  return normalized;
}

function normalizeCarrierForPhonecheck(carrier) {
  if (typeof carrier !== 'string') {
    return null;
  }
  const value = carrier.trim();
  if (!value) {
    return null;
  }
  const upper = value.toUpperCase();
  if (upper.includes('AT&T') || upper === 'ATT' || upper === 'AT&T' || upper.includes('AT T')) {
    return 'AT&T';
  }
  if (upper.includes('TMOBILE') || upper.includes('T-MOBILE') || upper.includes('T MOBILE')) {
    return 'T-Mobile';
  }
  if (upper.includes('SPRINT')) {
    return 'Sprint';
  }
  if (upper.includes('VERIZON') || upper === 'VZW') {
    return 'Verizon';
  }
  if (upper.includes('UNLOCK')) {
    return 'Unlocked';
  }
  if (upper.includes('BLACKLIST')) {
    return 'Blacklist';
  }
  return value;
}

function normalizeDeviceType(brand, providedType) {
  if (typeof providedType === 'string' && providedType.trim()) {
    const normalized = providedType.trim().toLowerCase();
    if (normalized.includes('apple') || normalized.includes('ios') || normalized.includes('iphone')) {
      return 'Apple';
    }
    if (normalized.includes('android') || normalized.includes('samsung') || normalized.includes('google')) {
      return 'Android';
    }
  }

  if (typeof brand === 'string' && brand.trim()) {
    const normalizedBrand = brand.trim().toLowerCase();
    if (normalizedBrand.includes('apple') || normalizedBrand.includes('iphone') || normalizedBrand.includes('ipad')) {
      return 'Apple';
    }
  }

  return null;
}

async function checkEsn({
  imei,
  carrier,
  deviceType,
  brand,
  checkAll = false,
  axiosInstance = axios,
} = {}) {
  if (!imei || typeof imei !== 'string') {
    const error = new Error('IMEI is required for Phonecheck.');
    error.code = 'phonecheck/invalid-imei';
    throw error;
  }

  const { apiKey, username, baseUrl } = getPhonecheckConfig();
  const url = new URL('/cloud/cloudDB/CheckEsn/', baseUrl).toString();

  const params = new URLSearchParams();
  params.append('apiKey', apiKey);
  params.append('username', username);
  params.append('IMEI', imei);

  const normalizedCarrier = normalizeCarrierForPhonecheck(carrier);
  if (normalizedCarrier) {
    params.append('carrier', normalizedCarrier);
  }

  const normalizedDeviceType = normalizeDeviceType(brand, deviceType);
  if (normalizedDeviceType) {
    params.append('devicetype', normalizedDeviceType);
  }

  if (checkAll !== undefined && checkAll !== null) {
    params.append('checkAll', checkAll ? '1' : '0');
  }

  const response = await axiosInstance({
    method: 'post',
    url,
    data: params.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  const { status, data } = response;

  if (status >= 400) {
    let message = 'Phonecheck ESN request failed.';
    if (data) {
      if (typeof data === 'string') {
        message = data;
      } else if (typeof data === 'object' && data !== null) {
        message = data.message || data.error || message;
      }
    }
    const error = new Error(message || 'Phonecheck ESN request failed.');
    error.code = 'phonecheck/http-error';
    error.status = status;
    error.responseData = data;
    throw error;
  }

  if (!data || typeof data !== 'object') {
    const error = new Error('Phonecheck returned an unexpected response.');
    error.code = 'phonecheck/invalid-response';
    error.responseData = data;
    throw error;
  }

  return {
    raw: data,
    normalized: normalizePhonecheckResponse(data),
  };
}

async function checkCarrierLock({
  imei,
  deviceType = 'Apple',
  axiosInstance = axios,
} = {}) {
  if (!imei || typeof imei !== 'string') {
    const error = new Error('IMEI is required for Phonecheck carrier lock lookup.');
    error.code = 'phonecheck/invalid-imei';
    throw error;
  }

  const { apiKey, username, baseUrl } = getPhonecheckConfig();
  const url = new URL('/cloud/cloudDB/CheckCarrierLock', baseUrl).toString();

  const params = new URLSearchParams();
  params.append('ApiKey', apiKey);
  params.append('UserId', username);
  params.append('DeviceId', imei.trim());
  params.append('DeviceType', deviceType || 'Apple');

  const response = await axiosInstance({
    method: 'post',
    url,
    data: params.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  const { status, data } = response;

  if (status >= 400) {
    let message = 'Phonecheck carrier lock request failed.';
    if (data) {
      if (typeof data === 'string') {
        message = data;
      } else if (typeof data === 'object' && data !== null) {
        message = data.message || data.error || message;
      }
    }
    const error = new Error(message || 'Phonecheck carrier lock request failed.');
    error.code = 'phonecheck/http-error';
    error.status = status;
    error.responseData = data;
    throw error;
  }

  if (!data || typeof data !== 'object') {
    const error = new Error('Phonecheck returned an unexpected carrier lock response.');
    error.code = 'phonecheck/invalid-response';
    error.responseData = data;
    throw error;
  }

  return {
    raw: data,
    normalized: normalizePhonecheckResponse(data),
  };
}

async function checkSamsungCarrierInfo({
  identifier,
  axiosInstance = axios,
} = {}) {
  const trimmedIdentifier = typeof identifier === 'string' ? identifier.trim() : null;
  if (!trimmedIdentifier) {
    const error = new Error('An IMEI or serial number is required for the Samsung carrier lookup.');
    error.code = 'phonecheck/invalid-imei';
    throw error;
  }

  const { token, baseUrl } = getSamsungPhonecheckConfig();
  const url = new URL(`/v2/imei/samsung/${encodeURIComponent(trimmedIdentifier)}`, baseUrl).toString();

  const response = await axiosInstance({
    method: 'get',
    url,
    headers: {
      token_master: token,
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  const { status, data } = response;

  if (status >= 400) {
    let message = 'Phonecheck Samsung carrier info request failed.';
    if (data) {
      if (typeof data === 'string') {
        message = data;
      } else if (typeof data === 'object' && data !== null) {
        message = data.message || data.msg || data.error || message;
      }
    }
    const error = new Error(message || 'Phonecheck Samsung carrier info request failed.');
    error.code = 'phonecheck/http-error';
    error.status = status;
    error.responseData = data;
    throw error;
  }

  if (!data || typeof data !== 'object') {
    const error = new Error('Phonecheck returned an unexpected Samsung carrier response.');
    error.code = 'phonecheck/invalid-response';
    error.responseData = data;
    throw error;
  }

  return {
    raw: data,
    normalized: normalizeSamsungCarrierInfo(data),
  };
}

module.exports = {
  checkEsn,
  checkCarrierLock,
  checkSamsungCarrierInfo,
  normalizePhonecheckResponse,
  normalizeCarrierForPhonecheck,
  normalizeDeviceType,
  isAppleDeviceHint,
  isSamsungDeviceHint,
};
