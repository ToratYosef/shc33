const test = require('node:test');
const assert = require('node:assert/strict');

const { isStatusPastReceived, isBalanceEmailStatus } = require('../../helpers/order-status');

test('flags received/completed style statuses', () => {
  assert.equal(isStatusPastReceived('received'), true);
  assert.equal(isStatusPastReceived('Completed'), true);
  assert.equal(isStatusPastReceived({ status: 'device_received' }), true);
});

test('flags re-offer and return label variations', () => {
  assert.equal(isStatusPastReceived('re-offered-pending'), true);
  assert.equal(isStatusPastReceived('reoffer_accepted'), true);
  assert.equal(isStatusPastReceived('Return Label Sent'), true);
  assert.equal(isStatusPastReceived('return_label_requested'), true);
});

test('ignores active statuses that still need refreshes', () => {
  assert.equal(isStatusPastReceived('kit_sent'), false);
  assert.equal(isStatusPastReceived('kit_delivered'), false);
  assert.equal(isStatusPastReceived('phone_on_the_way'), false);
  assert.equal(isStatusPastReceived('phone_on_the_way_to_us'), false);
});

test('treats any emailed status as past received', () => {
  assert.equal(
    isStatusPastReceived({ status: 'emailed', balanceEmailSentAt: { seconds: 0, nanoseconds: 0 } }),
    true
  );
  assert.equal(
    isStatusPastReceived({ status: 'emailed', lastConditionEmailReason: 'outstanding_balance' }),
    true
  );
  assert.equal(isStatusPastReceived({ status: 'emailed' }), true);
  assert.equal(isStatusPastReceived('emailed'), true);
});

test('treats balance and follow-up email statuses as post-receiving', () => {
  assert.equal(isStatusPastReceived({ status: 'balance_email_sent' }), true);
  assert.equal(isStatusPastReceived({ status: 'balanced email sent' }), true);
  assert.equal(isStatusPastReceived({ status: 'password_email_sent' }), true);
  assert.equal(isStatusPastReceived({ status: 'fmi_email_sent' }), true);
  assert.equal(isStatusPastReceived({ status: 'lost_stolen' }), true);
});

test('detects balance email aliases without extra flags', () => {
  assert.equal(isBalanceEmailStatus({ status: 'balance_email_sent' }), true);
  assert.equal(isBalanceEmailStatus({ status: 'balanced email sent' }), true);
  assert.equal(isBalanceEmailStatus({ status: 'emailed', lastConditionEmailReason: 'outstanding_balance' }), true);
  assert.equal(isBalanceEmailStatus({ status: 'emailed' }), false);
});
