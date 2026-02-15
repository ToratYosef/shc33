const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveUspsServiceAndWeightByDeviceCount } = require('../../helpers/shipengine');

const cases = [
  { deviceCount: 1, serviceCode: 'usps_first_class_mail', chosenService: 'First Class', weightOz: 15.9, blocks: null },
  { deviceCount: 4, serviceCode: 'usps_first_class_mail', chosenService: 'First Class', weightOz: 15.9, blocks: null },
  { deviceCount: 5, serviceCode: 'usps_priority_mail', chosenService: 'Priority', weightOz: 32, blocks: 2 },
  { deviceCount: 8, serviceCode: 'usps_priority_mail', chosenService: 'Priority', weightOz: 32, blocks: 2 },
  { deviceCount: 9, serviceCode: 'usps_priority_mail', chosenService: 'Priority', weightOz: 48, blocks: 3 },
  { deviceCount: 12, serviceCode: 'usps_priority_mail', chosenService: 'Priority', weightOz: 48, blocks: 3 },
  { deviceCount: 13, serviceCode: 'usps_priority_mail', chosenService: 'Priority', weightOz: 64, blocks: 4 },
];

test('resolveUspsServiceAndWeightByDeviceCount enforces deterministic USPS service/weight rules', () => {
  for (const expected of cases) {
    const result = resolveUspsServiceAndWeightByDeviceCount(expected.deviceCount);

    assert.equal(result.deviceCount, expected.deviceCount);
    assert.equal(result.serviceCode, expected.serviceCode);
    assert.equal(result.chosenService, expected.chosenService);
    assert.equal(result.weightOz, expected.weightOz);
    assert.equal(result.blocks, expected.blocks);
    assert.deepEqual(result.weight, { unit: 'ounce', value: expected.weightOz });

    if (expected.deviceCount <= 4) {
      assert.ok(result.weightOz <= 15.999);
    }
  }
});
