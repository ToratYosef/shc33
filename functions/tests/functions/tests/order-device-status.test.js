const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOrderDeviceKey,
  collectOrderDeviceKeys,
  deriveOrderStatusFromDevices,
} = require('../../../index');

test('buildOrderDeviceKey creates stable per-device keys', () => {
  assert.equal(buildOrderDeviceKey('ORDER123'), 'ORDER123::0');
  assert.equal(buildOrderDeviceKey('ORDER123', 2), 'ORDER123::2');
});

test('collectOrderDeviceKeys unions order items and existing maps', () => {
  const keys = collectOrderDeviceKeys({
    id: 'ORDER123',
    items: [{}, {}],
    deviceStatusByKey: {
      'ORDER123::2': 'received',
    },
    reofferByDevice: {
      'ORDER123::4': { newPrice: 10 },
    },
  });

  assert.deepEqual(
    keys.sort(),
    ['ORDER123::0', 'ORDER123::1', 'ORDER123::2', 'ORDER123::4'].sort()
  );
});

test('deriveOrderStatusFromDevices resolves declined and accepted outcomes', () => {
  const order = {
    id: 'ORDER123',
    items: [{}, {}],
    deviceStatusByKey: {
      'ORDER123::0': 're-offered-accepted',
      'ORDER123::1': 'completed',
    },
  };

  assert.equal(deriveOrderStatusFromDevices(order), 're-offered-accepted');

  const declined = {
    ...order,
    deviceStatusByKey: {
      'ORDER123::0': 'returned',
      'ORDER123::1': 'paid',
    },
  };
  assert.equal(deriveOrderStatusFromDevices(declined), 're-offered-declined');
});

