const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const createOrdersRouter = require('../../../routes/orders');

function createRouterDeps(overrides = {}) {
  const ordersById = new Map(
    (overrides.orders || []).map((order) => [order.id, { ...order }])
  );
  const updateCalls = [];

  const firestoreFn = () => ({ collection: () => ({ doc: () => ({}) }) });
  firestoreFn.FieldValue = {
    serverTimestamp: () => '__SERVER_TS__',
    delete: () => '__DELETE__',
  };
  firestoreFn.Timestamp = { now: () => ({}) };

  const deps = {
    axios: {},
    admin: {
      firestore: firestoreFn,
      apps: [],
      storage: () => ({ bucket: () => ({ file: () => ({}) }) }),
    },
    ordersCollection: {
      doc(id) {
        return {
          async get() {
            const order = ordersById.get(id);
            return {
              exists: Boolean(order),
              data: () => (order ? { ...order } : {}),
            };
          },
        };
      },
      orderBy: () => ({
        limit: () => ({
          get: async () => ({ docs: [] }),
        }),
      }),
    },
    adminsCollection: {
      doc: () => ({ get: async () => ({ exists: true }) }),
      async get() {
        return { docs: [] };
      },
    },
    writeOrderBoth: async () => {},
    updateOrderBoth: async (orderId, payload, options = {}) => {
      updateCalls.push({ orderId, payload, options });
      const existing = ordersById.get(orderId) || { id: orderId };
      const merged = { ...existing, ...payload, id: orderId };
      delete merged.reOffer;
      delete merged.reoffer;
      delete merged.qcCompletedAt;
      delete merged.qcDeviceMatch;
      delete merged.qcDeviceName;
      delete merged.qcStorage;
      delete merged.qcColor;
      delete merged.qcHistory;
      delete merged.qcResults;
      ordersById.set(orderId, merged);
      return { order: merged };
    },
    generateNextOrderNumber: async () => 'SHC-54321',
    stateAbbreviations: { 'New York': 'NY' },
    templates: {
      ORDER_RECEIVED_EMAIL_HTML: '',
      ORDER_PLACED_ADMIN_EMAIL_HTML: '',
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
    issuePageHelpers: {
      buildIssueList: () => [],
      ISSUE_COPY: {},
      toTitleCase: (value) => value,
    },
    authenticateAdminRequest: async () => ({
      ok: true,
      uid: 'admin-user',
    }),
    ...overrides,
  };

  return { deps, updateCalls };
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

test('cancel re-offer status reset succeeds for re-offered-pending orders', async () => {
  const { deps, updateCalls } = createRouterDeps({
    orders: [
      {
        id: 'SHC-10001',
        status: 're-offered-pending',
        reOffer: { newPrice: 100 },
        qcHistory: [{ pass: false }],
      },
    ],
  });
  const router = createOrdersRouter(deps);
  const app = express();
  app.use(express.json());
  app.use(router);

  const response = await request(app, {
    method: 'PUT',
    path: '/orders/SHC-10001/status',
    body: {
      status: 'received',
      reOffer: null,
      reoffer: null,
      qcCompletedAt: null,
      qcDeviceMatch: null,
      qcDeviceName: null,
      qcStorage: null,
      qcColor: null,
      qcHistory: [],
      qcResults: null,
      unrelated: 'ignored',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.order.status, 'received');
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].payload.reOffer, '__DELETE__');
  assert.equal(updateCalls[0].payload.qcHistory, '__DELETE__');
  assert.equal(updateCalls[0].options.autoLogStatus, false);
  assert.equal(updateCalls[0].options.logEntries[0].metadata.reason, 'admin_cancel_reoffer');
});

test('cancel re-offer status reset requires admin auth', async () => {
  const { deps, updateCalls } = createRouterDeps({
    orders: [{ id: 'SHC-10002', status: 're-offered-pending' }],
    authenticateAdminRequest: async () => ({
      ok: false,
      status: 403,
      error: 'Admin access required',
      code: 'AUTH_FORBIDDEN',
    }),
  });
  const router = createOrdersRouter(deps);
  const app = express();
  app.use(express.json());
  app.use(router);

  const response = await request(app, {
    method: 'PUT',
    path: '/orders/SHC-10002/status',
    body: {
      status: 'received',
      reOffer: null,
      qcHistory: [],
    },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'AUTH_FORBIDDEN');
  assert.equal(updateCalls.length, 0);
});

test('cancel re-offer status reset rejects invalid transition and remains explicit on retry', async () => {
  const { deps, updateCalls } = createRouterDeps({
    orders: [{ id: 'SHC-10003', status: 'received' }],
  });
  const router = createOrdersRouter(deps);
  const app = express();
  app.use(express.json());
  app.use(router);

  const firstResponse = await request(app, {
    method: 'PUT',
    path: '/orders/SHC-10003/status',
    body: {
      status: 'received',
      reOffer: null,
      qcHistory: [],
    },
  });
  const secondResponse = await request(app, {
    method: 'PUT',
    path: '/orders/SHC-10003/status',
    body: {
      status: 'received',
      reOffer: null,
      qcHistory: [],
    },
  });

  assert.equal(firstResponse.status, 409);
  assert.equal(firstResponse.body.code, 'INVALID_STATUS_TRANSITION');
  assert.equal(secondResponse.status, 409);
  assert.equal(secondResponse.body.code, 'INVALID_STATUS_TRANSITION');
  assert.equal(updateCalls.length, 0);
});
