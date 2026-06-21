#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { runAutomaticInboundTrackingRefresh } = require('../functions/index.js');

function formatStatus(status) {
  return String(status || 'unknown')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function printStatusCounts(title, counts = {}) {
  console.log(`\n[refresh-orders] ${title}`);
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) {
    console.log('  none');
    return;
  }
  for (const [status, count] of entries) {
    console.log(`  ${formatStatus(status)}: ${count}`);
  }
}

(async () => {
  try {
    console.log('[refresh-orders] starting inbound tracking refresh for label_generated and phone_on_the_way orders');
    const summary = await runAutomaticInboundTrackingRefresh({
      onProgress: ({ orderId, beforeStatus, afterStatus, failed, error }) => {
        const before = formatStatus(beforeStatus);
        const after = formatStatus(afterStatus);
        if (failed) {
          console.log(`${orderId}- ${before} -> ERROR: ${error}`);
          return;
        }
        if (before === after) {
          console.log(`${orderId}- ${before}`);
          return;
        }
        console.log(`${orderId}- ${before} -> ${after}`);
      },
    });

    console.log(`\n[refresh-orders] orders scanned: ${summary?.scannedCount || 0}`);
    console.log(`[refresh-orders] orders changed: ${summary?.changedCount || 0}`);
    console.log(`[refresh-orders] orders refreshed: ${summary?.refreshedCount || 0}`);
    console.log(`[refresh-orders] orders skipped: ${summary?.skippedCount || 0}`);
    console.log(`[refresh-orders] orders failed: ${summary?.failedCount || 0}`);
    printStatusCounts('status counts before', summary?.beforeStatusCounts);
    printStatusCounts('status counts after', summary?.afterStatusCounts);

    if (summary?.failedCount > 0) {
      console.error(`\n[refresh-orders] completed with ${summary.failedCount} failed order(s)`);
      process.exit(1);
    }

    console.log('\n[refresh-orders] completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('[refresh-orders] failed:', error?.message || error);
    if (error?.stack) console.error(error.stack);
    process.exit(1);
  }
})();
