const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const createOrdersRouter = require('../../../routes/orders');
const {
  resolveSubmitterIpAddress,
  buildSubmitterMetadata,
  buildIpConflictSummary,
} = createOrdersRouter.__testUtils;

function createRouterDeps(overrides = {}) {
  const orders = overrides.orders || [];
  const writeCalls = [];
  const firestoreFn = () => ({ collection: () => ({ doc: () => ({}) }) });
  firestoreFn.FieldValue = {
    serverTimestamp: () => '__SERVER_TS__',
  };
  firestoreFn.Timestamp = { now: () => ({}) };

  const makeQuery = () => ({
    orderBy() {
      return this;
    },
    limit(limitValue) {
      this._limitValue = limitValue;
      return this;
    },
    async get() {
      const limitValue = Number.isFinite(this._limitValue) ? this._limitValue : orders.length;
      return {
        docs: orders.slice(0, limitValue).map((order) => ({
          id: order.id,
          data: () => ({ ...order }),
        })),
      };
    },
  });

  const deps = {
    axios: {},
    admin: {
      firestore: firestoreFn,
      apps: [],
      storage: () => ({ bucket: () => ({ file: () => ({}) }) }),
    },
    ordersCollection: {
      orderBy: () => makeQuery(),
      doc: () => ({ get: async () => ({ exists: false }) }),
    },
    adminsCollection: {
      async get() {
        return { docs: [] };
      },
    },
    writeOrderBoth: async (orderId, payload) => {
      writeCalls.push({ orderId, payload });
    },
    updateOrderBoth: async () => {},
    generateNextOrderNumber: async () => 'SHC-54321',
    stateAbbreviations: { 'New York': 'NY' },
    templates: {
      ORDER_RECEIVED_EMAIL_HTML: 'Hello **CUSTOMER_NAME** **ORDER_ID** **DEVICE_NAME** **SHIPPING_INSTRUCTION**',
      ORDER_PLACED_ADMIN_EMAIL_HTML: '**CUSTOMER_NAME** **CUSTOMER_EMAIL** **CUSTOMER_PHONE** **ORDER_ID** **DEVICE_NAME** **STORAGE** **CARRIER** **ESTIMATED_QUOTE** **PAYMENT_METHOD** **PAYMENT_INFO** **SHIPPING_ADDRESS** **COSMETIC_GRADE**',
      SHIPPING_KIT_EMAIL_HTML: '',
      SHIPPING_LABEL_EMAIL_HTML: '',
    },
    notifications: {
      sendAdminPushNotification: async () => {},
      addAdminFirestoreNotification: async () => {},
    },
    pdf: {
      generateCustomLabelPdf: async () => Buffer.alloc(0),
      generateBagLabelPdf: async () => Buffer.alloc(0),
      mergePdfBuffers: async () => Buffer.alloc(0),
    },
    shipEngine: {
      cloneShipEngineLabelMap: () => ({}),
      buildLabelIdList: () => [],
      isLabelPendingVoid: () => false,
      handleLabelVoid: async () => {},
      sendVoidNotificationEmail: async () => {},
    },
    createShipEngineLabel: async () => ({}),
    getShipEngineApiKey: () => null,
    transporter: {
      sendMail: async () => ({}),
    },
    deviceHelpers: {
      buildOrderDeviceKey: () => 'SHC-54321::0',
      collectOrderDeviceKeys: () => ['SHC-54321::0'],
      deriveOrderStatusFromDevices: () => null,
    },
    authenticateAdminRequest: async () => ({ ok: true, uid: 'admin-user' }),
    ...overrides,
  };

  return { deps, writeCalls };
}

async function request(app, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (error) {
      json = text;
    }

    return { status: response.status, body: json };
  } finally {
    server.close();
  }
}

test('resolveSubmitterIpAddress obeys header precedence', () => {
  const req = {
    headers: {
      'x-forwarded-for': '198.51.100.3, 203.0.113.8',
      'cf-connecting-ip': '198.51.100.7',
      'x-real-ip': '198.51.100.9',
    },
    ip: '198.51.100.11',
    socket: { remoteAddress: '198.51.100.12' },
  };

  assert.equal(resolveSubmitterIpAddress(req), '198.51.100.3');
  assert.equal(resolveSubmitterIpAddress({ headers: { 'cf-connecting-ip': '198.51.100.7' } }), '198.51.100.7');
  assert.equal(resolveSubmitterIpAddress({ headers: { 'x-real-ip': '198.51.100.9' } }), '198.51.100.9');
  assert.equal(resolveSubmitterIpAddress({ headers: {}, ip: '::ffff:198.51.100.11' }), '198.51.100.11');
});

test('submit-order persists merged submitter metadata fields', async () => {
  const { deps, writeCalls } = createRouterDeps();
  const router = createOrdersRouter(deps);
  const app = express();
  app.use(express.json());
  app.use(router);

  const res = await request(app, {
    method: 'POST',
    path: '/submit-order',
    headers: {
      'x-forwarded-for': '203.0.113.45, 198.51.100.10',
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    },
    body: {
      estimatedQuote: 120,
      shippingInfo: {
        fullName: 'Test Buyer',
        email: 'buyer@example.com',
        state: 'New York',
      },
      submitterContext: {
        deviceId: 'iPhone 16',
      },
    },
  });

  assert.equal(res.status, 201);
  assert.equal(writeCalls.length, 1);
  const saved = writeCalls[0].payload;

  assert.equal(saved.submitterIpAddress, '203.0.113.45');
  assert.equal(saved.submitterDeviceId, 'iPhone 16');
  assert.equal(saved.submitterBrowser, 'Safari');
  assert.equal(saved.submitterOs, 'iOS');
  assert.equal(saved.submitterDeviceType, 'mobile');
  assert.equal(saved.submitterContext.deviceId, 'iPhone 16');
  assert.equal(saved.submitterContext.browser, 'Safari');
  assert.equal(saved.submitterContext.os, 'iOS');
  assert.equal(saved.submitterContext.deviceType, 'mobile');
  assert.ok(saved.submitterContext.userAgent.includes('Mozilla/5.0 (iPhone'));
});

test('buildIpConflictSummary only returns multi-name conflicts', () => {
  const summary = buildIpConflictSummary([
    {
      id: 'SHC-1',
      submitterIpAddress: '198.51.100.1',
      shippingInfo: { fullName: 'Alice Doe', email: 'alice@example.com' },
      device: 'iPhone 15',
    },
    {
      id: 'SHC-2',
      submitterIpAddress: '198.51.100.1',
      shippingInfo: { fullName: '  alice doe ', email: 'alice2@example.com' },
      device: 'iPhone 14',
    },
    {
      id: 'SHC-3',
      submitterIpAddress: '198.51.100.1',
      shippingInfo: { fullName: 'Bob Smith', email: 'bob@example.com' },
      device: 'Galaxy S24',
      submitterContext: { browser: 'Chrome', os: 'Android', deviceType: 'mobile' },
    },
    {
      id: 'SHC-4',
      submitterIpAddress: '203.0.113.9',
      shippingInfo: { fullName: 'Solo User', email: 'solo@example.com' },
    },
  ]);

  assert.equal(summary.scannedOrders, 4);
  assert.equal(summary.conflictCount, 1);
  assert.equal(summary.conflicts[0].ipAddress, '198.51.100.1');
  assert.equal(summary.conflicts[0].uniqueNameCount, 2);
  assert.equal(summary.conflicts[0].orderCount, 3);
  assert.deepEqual(summary.conflicts[0].names.sort(), ['Alice Doe', 'Bob Smith']);
});

test('ip-conflicts endpoint returns 401 for missing auth', async () => {
  const { deps } = createRouterDeps({
    authenticateAdminRequest: async () => ({
      ok: false,
      status: 401,
      error: 'Authentication required',
      code: 'AUTH_MISSING',
      reason: 'missing token',
    }),
  });

  const router = createOrdersRouter(deps);
  const app = express();
  app.use(express.json());
  app.use(router);

  const unauthorized = await request(app, { path: '/orders/ip-conflicts' });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.code, 'AUTH_MISSING');
});

test('ip-conflicts endpoint returns 403 for non-admin user', async () => {
  const { deps } = createRouterDeps({
    authenticateAdminRequest: async () => ({
      ok: false,
      status: 403,
      error: 'Admin access required',
      code: 'AUTH_FORBIDDEN',
      reason: 'not admin',
      uid: 'user-123',
    }),
  });

  const router = createOrdersRouter(deps);
  const app = express();
  app.use(express.json());
  app.use(router);

  const forbidden = await request(app, { path: '/orders/ip-conflicts' });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, 'AUTH_FORBIDDEN');
});

test('ip-conflicts endpoint returns conflict data for authorized admin', async () => {
  const { deps } = createRouterDeps({
    authenticateAdminRequest: async () => ({ ok: true, uid: 'admin-1' }),
    orders: [
      {
        id: 'SHC-10',
        submitterIpAddress: '198.51.100.2',
        shippingInfo: { fullName: 'Jane Doe', email: 'jane@example.com' },
      },
      {
        id: 'SHC-11',
        submitterIpAddress: '198.51.100.2',
        shippingInfo: { fullName: 'John Doe', email: 'john@example.com' },
      },
    ],
  });

  const router = createOrdersRouter(deps);
  const app = express();
  app.use(express.json());
  app.use(router);

  const authorized = await request(app, {
    path: '/orders/ip-conflicts?limit=50',
  });

  assert.equal(authorized.status, 200);
  assert.equal(authorized.body.scannedOrders, 2);
  assert.equal(authorized.body.conflictCount, 1);
});

test('ip-conflicts endpoint validates bad limit query param', async () => {
  const { deps } = createRouterDeps({
    authenticateAdminRequest: async () => ({ ok: true, uid: 'admin-2' }),
  });
  const router = createOrdersRouter(deps);
  const app = express();
  app.use(express.json());
  app.use(router);

  const result = await request(app, { path: '/orders/ip-conflicts?limit=abc' });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'BAD_LIMIT');
});

test('buildSubmitterMetadata fills missing browser/os/deviceType from user-agent', () => {
  const result = buildSubmitterMetadata(
    {
      headers: {
        'x-forwarded-for': '198.51.100.44',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      },
    },
    { deviceId: 'Desktop' }
  );

  assert.equal(result.submitterIpAddress, '198.51.100.44');
  assert.equal(result.submitterBrowser, 'Chrome');
  assert.equal(result.submitterOs, 'Windows');
  assert.equal(result.submitterDeviceType, 'desktop');
});
