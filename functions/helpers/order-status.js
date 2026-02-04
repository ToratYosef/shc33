const POST_RECEIVED_STATUS_HINTS = new Set([
  'received',
  'device_received',
  'received_device',
  'imei_checked',
  'imei checked',
  'balance_email_sent',
  'balanced_email_sent',
  'balance email sent',
  'balanced email sent',
  'password_email_sent',
  'password email sent',
  'fmi_email_sent',
  'fmi email sent',
  'lost_stolen',
  'lost stolen',
  'completed',
  'complete',
  're-offered-pending',
  're-offered-accepted',
  're-offered-declined',
  're-offered-auto-accepted',
  're_offered_pending',
  're_offered_accepted',
  're_offered_declined',
  're_offered_auto_accepted',
  'reoffer pending',
  'reoffer accepted',
  'reoffer declined',
  'reoffer auto accepted',
  'reoffer_pending',
  'reoffer_accepted',
  'reoffer_declined',
  'reoffer_auto_accepted',
  'return-label-generated',
  'return_label_generated',
  'return label generated',
  'return-label-sent',
  'return_label_sent',
  'return label sent',
  'return-label-requested',
  'return_label_requested',
  'return label requested',
  'emailed',
  'cancelled',
  'canceled',
]);

const BALANCE_EMAIL_STATUS_ALIASES = new Set([
  'emailed',
  'balance_email_sent',
  'balanced_email_sent',
  'balance email sent',
  'balanced email sent',
]);

function hasBalanceEmailFlag(input = {}) {
  if (!input || typeof input !== 'object') {
    return false;
  }
  const reason = (input.lastConditionEmailReason || input.conditionEmailReason || '')
    .toString()
    .toLowerCase();
  if (reason === 'outstanding_balance') {
    return true;
  }
  if (input.balanceEmailSentAt) {
    return true;
  }
  return false;
}

function normalizeStatusString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

function statusMatchesHints(value) {
  if (!value) {
    return false;
  }
  if (POST_RECEIVED_STATUS_HINTS.has(value)) {
    return true;
  }
  const underscored = value.replace(/[\s-]+/g, '_');
  if (POST_RECEIVED_STATUS_HINTS.has(underscored)) {
    return true;
  }
  const hyphenated = value.replace(/[\s_]+/g, '-');
  if (POST_RECEIVED_STATUS_HINTS.has(hyphenated)) {
    return true;
  }
  return false;
}

function extractStatusCandidate(input) {
  if (!input) {
    return '';
  }
  if (typeof input === 'string') {
    return input;
  }
  const candidates = [
    input.status,
    input.currentStatus,
    input.statusValue,
    input.status_value,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return '';
}

function isStatusPastReceived(input) {
  const raw = normalizeStatusString(extractStatusCandidate(input));
  if (!raw) {
    return false;
  }
  if (raw === 'emailed') {
    return true;
  }
  if (statusMatchesHints(raw)) {
    return true;
  }
  if (
    raw.includes('reoffer') ||
    raw.includes('re-offer') ||
    raw.includes('re_offer')
  ) {
    return true;
  }
  if (
    raw.includes('return label') ||
    raw.includes('return-label') ||
    raw.includes('return_label') ||
    raw.includes('returnlabel')
  ) {
    return true;
  }
  if (
    raw.includes('received') &&
    !raw.includes('not_received') &&
    !raw.includes('kit')
  ) {
    return true;
  }
  if (raw.includes('completed')) {
    return true;
  }
  return false;
}

function isBalanceEmailStatus(input = {}) {
  if (!input || typeof input !== 'object') {
    return false;
  }
  const normalized = normalizeStatusString(extractStatusCandidate(input));
  if (BALANCE_EMAIL_STATUS_ALIASES.has(normalized)) {
    if (normalized !== 'emailed') {
      return true;
    }
  } else {
    return false;
  }
  return hasBalanceEmailFlag(input);
}

module.exports = {
  POST_RECEIVED_STATUS_HINTS,
  isStatusPastReceived,
  isBalanceEmailStatus,
};
