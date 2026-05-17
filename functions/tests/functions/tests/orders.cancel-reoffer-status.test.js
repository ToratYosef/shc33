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
      for (const [key, value] of Object.entries(payload)) {
        if (value === '__DELETE__') {
          delete merged[key];
        }
      }
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

test('DELETE /orders/:id/re-offer clears re-offer fields and resets statuses', async () => {
  const { deps, updateCalls } = createRouterDeps({
    orders: [
      {
        id: 'SHC-20001',
        status: 're-offered-pending',
        reOffer: { newPrice: 100 },
        reofferByDevice: { 'SHC-20001::0': { newPrice: 100 } },
        reOfferHistory: [{ newPrice: 100 }],
        reOfferEvents: [{ type: 'sent' }],
        reOfferUpdatedAt: 'old',
        requoteAmount: 100,
        updatedQuote: 100,
        acceptedAt: 'old-accepted',
        declinedAt: 'old-declined',
        reOfferToken: 'token',
        reOfferExpiresAt: 'expires',
        deviceStatusByKey: {
          'SHC-20001::0': 're-offered-pending',
          'SHC-20001::1': 'processing',
        },
      },
    ],
  });
  const router = createOrdersRouter(deps);
  const app = express();
  app.use(express.json());
  app.use(router);

  const response = await request(app, {
    method: 'DELETE',
    path: '/orders/SHC-20001/re-offer',
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.order.status, 'received');
  assert.deepEqual(response.body.order.deviceStatusByKey, {
    'SHC-20001::0': 'received',
    'SHC-20001::1': 'processing',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(response.body.order, 'reOffer'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response.body.order, 'reofferByDevice'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response.body.order, 'reOfferHistory'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response.body.order, 'reOfferEvents'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response.body.order, 'requoteAmount'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response.body.order, 'acceptedAt'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response.body.order, 'declinedAt'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(response.body.order, 'reOfferToken'), false);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].payload.reOffer, '__DELETE__');
  assert.equal(updateCalls[0].payload.reofferByDevice, '__DELETE__');
  assert.equal(updateCalls[0].payload.reOfferToken, '__DELETE__');
  assert.deepEqual(updateCalls[0].payload.deviceStatusByKey, {
    'SHC-20001::0': 'received',
    'SHC-20001::1': 'processing',
  });
  assert.equal(updateCalls[0].options.logEntries[0].type, 'reoffer');
  assert.equal(updateCalls[0].options.logEntries[0].message, 'Admin cancelled and cleared re-offer data');
});

test('DELETE /orders/:id/re-offer restores emailed status when unresolved issue context exists', async () => {
  const { deps } = createRouterDeps({
    orders: [
      {
        id: 'SHC-20002',
        status: 're_offered_declined',
        reOfferByDevice: { 'SHC-20002::0': { newPrice: 75 } },
        qcIssuesByDevice: {
          'SHC-20002::0': {
            password_locked: { resolved: false },
          },
        },
        deviceStatusByKey: {
          'SHC-20002::0': 're_offered_declined',
        },
      },
    ],
  });
  const router = createOrdersRouter(deps);
  const app = express();
  app.use(express.json());
  app.use(router);

  const response = await request(app, {
    method: 'DELETE',
    path: '/orders/SHC-20002/re-offer',
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.order.status, 'emailed');
  assert.equal(response.body.order.deviceStatusByKey['SHC-20002::0'], 'emailed');
  assert.equal(Object.prototype.hasOwnProperty.call(response.body.order, 'reOfferByDevice'), false);
});

test('DELETE /orders/:id/re-offer requires admin auth and existing order', async () => {
  const unauthorized = createRouterDeps({
    orders: [{ id: 'SHC-20003', status: 're-offered-pending' }],
    authenticateAdminRequest: async () => ({
      ok: false,
      status: 401,
      error: 'Authentication required',
      code: 'AUTH_MISSING',
    }),
  });
  const unauthorizedApp = express();
  unauthorizedApp.use(express.json());
  unauthorizedApp.use(createOrdersRouter(unauthorized.deps));

  const unauthorizedResponse = await request(unauthorizedApp, {
    method: 'DELETE',
    path: '/orders/SHC-20003/re-offer',
  });

  assert.equal(unauthorizedResponse.status, 401);
  assert.equal(unauthorizedResponse.body.code, 'AUTH_MISSING');
  assert.equal(unauthorized.updateCalls.length, 0);

  const notFound = createRouterDeps();
  const notFoundApp = express();
  notFoundApp.use(express.json());
  notFoundApp.use(createOrdersRouter(notFound.deps));

  const notFoundResponse = await request(notFoundApp, {
    method: 'DELETE',
    path: '/orders/SHC-404/re-offer',
  });

  assert.equal(notFoundResponse.status, 404);
  assert.equal(notFound.updateCalls.length, 0);
});
