#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { runAutomaticInboundTrackingRefresh } = require('../functions/index.js');

(async () => {
  try {
    console.log('[refresh-orders] starting inbound tracking refresh for label_generated and phone_on_the_way orders');
    await runAutomaticInboundTrackingRefresh();
    console.log('[refresh-orders] completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('[refresh-orders] failed:', error?.message || error);
    if (error?.stack) console.error(error.stack);
    process.exit(1);
  }
})();
