const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateCustomLabelPdf,
  generateBagLabelPdf,
} = require('../../helpers/pdf');

const sampleOrder = {
  id: 'ORDER-12345',
  shippingInfo: {
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    phone: '3475550199',
    city: 'Brooklyn',
    state: 'NY',
  },
  brand: 'Apple',
  device: 'iPhone 13',
  storage: '128GB',
  carrier: 'Unlocked',
  condition_power_on: 'yes',
  condition_functional: 'yes',
  condition_cracks: 'no',
  condition_cosmetic: 'good',
  estimatedQuote: 125,
};

test('generateCustomLabelPdf returns a non-empty PDF payload', async () => {
  const pdf = await generateCustomLabelPdf(sampleOrder);

  assert.ok(pdf);
  assert.ok(pdf.length > 1000);
  assert.equal(Buffer.from(pdf).subarray(0, 4).toString(), '%PDF');
});

test('generateBagLabelPdf returns a non-empty PDF payload', async () => {
  const pdf = await generateBagLabelPdf(sampleOrder);

  assert.ok(pdf);
  assert.ok(pdf.length > 500);
  assert.equal(Buffer.from(pdf).subarray(0, 4).toString(), '%PDF');
});
