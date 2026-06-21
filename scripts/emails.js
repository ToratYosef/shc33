#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  runAutomaticInboundTrackingRefresh,
  runAutomaticLabelReminderSweep,
} = require('../functions/index.js');

function formatStatus(status) {
  return String(status || 'unknown')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function dayLabel(dayCount) {
  const days = Number(dayCount) || 0;
  return `${days} day`;
}

(async () => {
  try {
    console.log('[emails] refreshing label/tracking statuses first...');
    const refreshSummary = await runAutomaticInboundTrackingRefresh({
      onProgress: ({ orderId, beforeStatus, afterStatus, failed, error }) => {
        const before = formatStatus(beforeStatus);
        const after = formatStatus(afterStatus);
        if (failed) {
          console.log(`${orderId} - refresh error: ${error}`);
        } else if (before === after) {
          console.log(`${orderId} - ${before}`);
        } else {
          console.log(`${orderId} - ${before} -> ${after}`);
        }
      },
    });
    console.log(`[emails] refresh complete: scanned=${refreshSummary?.scannedCount || 0} changed=${refreshSummary?.changedCount || 0} failed=${refreshSummary?.failedCount || 0}`);

    console.log('[emails] sending due label reminder emails...');
    const emailSummary = await runAutomaticLabelReminderSweep({
      onProgress: ({ orderId, dayCount, sent, skipped, failed, error }) => {
        if (sent) {
          console.log(`${orderId} - sent ${dayLabel(dayCount)} reminder email`);
          return;
        }
        if (failed) {
          console.log(`${orderId} - email error: ${error}`);
          return;
        }
        if (skipped === 'already_sent' || skipped === 'recent_email') {
          console.log(`${orderId} - already sent an email`);
          return;
        }
        if (skipped === 'not_due') {
          console.log(`${orderId} - no email due (${dayLabel(dayCount)})`);
          return;
        }
        console.log(`${orderId} - skipped email (${skipped || 'unknown'})`);
      },
    });

    console.log(`[emails] email summary: scanned=${emailSummary?.scannedCount || 0} sent=${emailSummary?.sentCount || 0} skipped=${emailSummary?.skippedCount || 0}`);
    console.log('[emails] completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('[emails] failed:', error?.message || error);
    if (error?.stack) console.error(error.stack);
    process.exit(1);
  }
})();
