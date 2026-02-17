const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeInboundTrackingStatus } = require('../../helpers/shipengine');

test('maps ShipEngine status codes to canonical inbound states', () => {
  assert.equal(normalizeInboundTrackingStatus('DE'), 'DELIVERED');
  assert.equal(normalizeInboundTrackingStatus('sp'), 'DELIVERED_TO_AGENT');
  assert.equal(normalizeInboundTrackingStatus('it'), 'IN_TRANSIT');
  assert.equal(normalizeInboundTrackingStatus('AC'), 'ACCEPTED');
  assert.equal(normalizeInboundTrackingStatus('OC'), 'SHIPMENT_ACCEPTED');
  assert.equal(normalizeInboundTrackingStatus('NY'), 'NOT_YET_IN_SYSTEM');
});

test('falls back to status descriptions when codes are missing', () => {
  assert.equal(
    normalizeInboundTrackingStatus(null, 'Package delivered at the dock'),
    'DELIVERED'
  );
  assert.equal(
    normalizeInboundTrackingStatus('', 'Out for delivery to customer'),
    'OUT_FOR_DELIVERY'
  );
  assert.equal(
    normalizeInboundTrackingStatus(undefined, 'Label created, USPS awaiting item'),
    'LABEL_CREATED'
  );
  assert.equal(
    normalizeInboundTrackingStatus(null, 'In transit to next facility'),
    'IN_TRANSIT'
  );
});
