process.env.EMAIL_USER ||= 'test@example.com';
process.env.EMAIL_PASS ||= 'test-password';
process.env.SHIPENGINE_API_KEY ||= 'test-shipengine-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isManualGroundOnlyService,
  getManualGroundOnlyExclusionMessage,
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
