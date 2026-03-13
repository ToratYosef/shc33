const test = require('node:test');
const assert = require('node:assert/strict');

const { runBulkKitRefresh } = require('../../../index.js');

test('runBulkKitRefresh returns summary for successful kit refreshes', async () => {
  const calls = [];
  const summary = await runBulkKitRefresh({
    orderIds: ['order-1', 'order-2', 'order-3'],
    force: false,
    concurrency: 2,
    refreshFn: async (body) => {
      calls.push(body);
      return { status: 'kit_delivered' };
    },
  });

  assert.equal(summary.processed, 3);
  assert.equal(summary.succeeded, 3);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.results, [
    { orderId: 'order-1', ok: true, status: 'kit_delivered' },
    { orderId: 'order-2', ok: true, status: 'kit_delivered' },
    { orderId: 'order-3', ok: true, status: 'kit_delivered' },
  ]);
  assert.deepEqual(calls, [
    { orderId: 'order-1', type: 'kit', force: false },
    { orderId: 'order-2', type: 'kit', force: false },
    { orderId: 'order-3', type: 'kit', force: false },
  ]);
});

test('runBulkKitRefresh captures partial failures', async () => {
  const summary = await runBulkKitRefresh({
    orderIds: ['ok-1', 'bad-1', 'ok-2'],
    force: true,
    concurrency: 3,
    refreshFn: async ({ orderId }) => {
      if (orderId === 'bad-1') {
        throw new Error('shipengine_timeout');
      }
      return { status: 'kit_delivered' };
    },
  });

  assert.equal(summary.processed, 3);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.results, [
    { orderId: 'ok-1', ok: true, status: 'kit_delivered' },
    { orderId: 'bad-1', ok: false, error: 'shipengine_timeout' },
    { orderId: 'ok-2', ok: true, status: 'kit_delivered' },
  ]);
});

test('runBulkKitRefresh rejects invalid payload when orderIds are missing or empty', async () => {
  await assert.rejects(
    () => runBulkKitRefresh({ force: false, refreshFn: async () => ({ status: 'kit_delivered' }) }),
    (error) => error?.statusCode === 400 && /orderIds must be a non-empty array\./.test(error.message)
  );

  await assert.rejects(
    () => runBulkKitRefresh({ orderIds: [], force: false, refreshFn: async () => ({ status: 'kit_delivered' }) }),
    (error) => error?.statusCode === 400 && /orderIds must be a non-empty array\./.test(error.message)
  );

  await assert.rejects(
    () => runBulkKitRefresh({ orderIds: ['   '], force: false, refreshFn: async () => ({ status: 'kit_delivered' }) }),
    (error) => error?.statusCode === 400 && /orderIds must be a non-empty array\./.test(error.message)
  );
});
