process.env.EMAIL_USER ||= 'test@example.com';
process.env.EMAIL_PASS ||= 'test-password';
process.env.SHIPENGINE_API_KEY ||= 'test-shipengine-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isManualGroundOnlyService,
  getManualGroundOnlyExclusionMessage,
  parseManualHazardousMaterialsFlag,
  shouldIncludeManualShipEngineRate,
  dedupeManualShipEngineRates,
  buildManualShipEngineShipment,
} = require('../../../index');

test('manual hazardous label rates allow ground-only services', () => {
  assert.equal(
    isManualGroundOnlyService({ service_code: 'usps_ground_advantage', service_type: 'USPS Ground Advantage' }),
    true
  );
  assert.equal(
    isManualGroundOnlyService({ service_code: 'ups_ground', service_type: 'UPS® Ground' }),
    true
  );
  assert.equal(
    isManualGroundOnlyService({ service_code: 'fedex_ground_economy_parcel_select' }),
    true
  );
});

test('manual hazardous label rates reject air, media, and priority services', () => {
  assert.equal(
    isManualGroundOnlyService({ service_code: 'usps_media_mail', service_type: 'USPS Media Mail' }),
    false
  );
  assert.equal(
    isManualGroundOnlyService({ service_code: 'usps_priority_mail', service_type: 'USPS Priority Mail' }),
    false
  );
  assert.equal(
    isManualGroundOnlyService({ service_code: 'ups_2nd_day_air', service_type: 'UPS 2nd Day Air®' }),
    false
  );
});

test('manual hazardous label exclusions explain the ground-only requirement', () => {
  assert.match(
    getManualGroundOnlyExclusionMessage({ service_type: 'USPS Media Mail' }),
    /USPS Media Mail was excluded because hazardous materials must use a ground-only service such as USPS Ground Advantage\./
  );
});

test('manual hazardous flag defaults to hazardous for existing clients', () => {
  assert.equal(parseManualHazardousMaterialsFlag(undefined), true);
  assert.equal(parseManualHazardousMaterialsFlag(null), true);
  assert.equal(parseManualHazardousMaterialsFlag(''), true);
});

test('manual hazardous flag accepts checkbox-style false values', () => {
  assert.equal(parseManualHazardousMaterialsFlag(false), false);
  assert.equal(parseManualHazardousMaterialsFlag('false'), false);
  assert.equal(parseManualHazardousMaterialsFlag('0'), false);
  assert.equal(parseManualHazardousMaterialsFlag('no'), false);
  assert.equal(parseManualHazardousMaterialsFlag('off'), false);
});

test('manual hazardous flag accepts checkbox-style true values', () => {
  assert.equal(parseManualHazardousMaterialsFlag(true), true);
  assert.equal(parseManualHazardousMaterialsFlag('true'), true);
  assert.equal(parseManualHazardousMaterialsFlag('1'), true);
  assert.equal(parseManualHazardousMaterialsFlag('yes'), true);
  assert.equal(parseManualHazardousMaterialsFlag('on'), true);
});

test('manual non-hazardous label rates include non-ground and carrier-selected package rates', () => {
  assert.equal(
    shouldIncludeManualShipEngineRate(
      { service_code: 'usps_media_mail', service_type: 'USPS Media Mail', package_type: 'thick_envelope' },
      false
    ),
    true
  );
  assert.equal(
    shouldIncludeManualShipEngineRate(
      { service_code: 'ups_2nd_day_air', service_type: 'UPS 2nd Day Air®', package_type: '' },
      false
    ),
    true
  );
});

test('manual hazardous label rates still reject non-ground and carrier-selected package rates', () => {
  assert.equal(
    shouldIncludeManualShipEngineRate(
      { service_code: 'usps_media_mail', service_type: 'USPS Media Mail', package_type: 'thick_envelope' },
      true
    ),
    false
  );
  assert.equal(
    shouldIncludeManualShipEngineRate(
      { service_code: 'usps_ground_advantage', service_type: 'USPS Ground Advantage', package_type: 'package' },
      true
    ),
    true
  );
});

test('manual rate dedupe keeps the cheapest duplicate carrier service', () => {
  const rates = dedupeManualShipEngineRates([
    {
      rateId: 'expensive-ups-ground',
      carrierCode: 'ups',
      carrierFriendlyName: 'UPS',
      serviceCode: 'ups_ground',
      serviceType: 'UPS Ground',
      packageType: 'package',
      totalAmount: 27.13,
      deliveryDays: 4,
      estimatedDeliveryDate: '2026-06-29T23:00:00Z',
    },
    {
      rateId: 'cheap-ups-ground',
      carrierCode: 'ups',
      carrierFriendlyName: 'UPS',
      serviceCode: 'ups_ground',
      serviceType: 'UPS Ground',
      packageType: 'package',
      totalAmount: 9.34,
      deliveryDays: 4,
      estimatedDeliveryDate: '2026-06-29T23:00:00Z',
    },
  ]);

  assert.equal(rates.length, 1);
  assert.equal(rates[0].rateId, 'cheap-ups-ground');
});

test('manual hazardous ShipEngine shipment sets shipment-level dangerous goods without extra product payload', () => {
  const shipment = buildManualShipEngineShipment(
    'customer_to_me',
    {
      fullName: 'Jane Customer',
      streetAddress: '123 Main St',
      city: 'Brooklyn',
      state: 'NY',
      zipCode: '11223',
    },
    true,
    { weightLb: 0, weightOz: 8, dimensions: { length: 6, width: 4, height: 2 } }
  );

  assert.equal(shipment.advanced_options.dangerous_goods, true);
  assert.equal(shipment.packages[0].products, undefined);
});
