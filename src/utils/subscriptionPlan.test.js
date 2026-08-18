const test = require('node:test');
const assert = require('node:assert/strict');
const { getPlanMonths } = require('./subscriptionPlan');

test('recognizes the configured recurring variant names', () => {
  const cases = [
    ['1-Month Plan', 1],
    ['3-Month Plan - Get Monthly Shipments', 3],
    ['6-Month Plan - Get Monthly Shipment', 6],
    ['12-Month Plan - Get Monthly Shipments', 12],
  ];

  for (const [variantTitle, expectedMonths] of cases) {
    assert.equal(getPlanMonths({ variant_title: variantTitle }), expectedMonths);
  }
});

test('ignores non-recurring sachet variants and unrelated numbered names', () => {
  const variantTitles = [
    '7 Sachets',
    '14 Sachets',
    '28 Sachets',
    '12 Sachets',
    '3 Pack',
    'Default Title',
    '',
  ];

  for (const variantTitle of variantTitles) {
    assert.equal(getPlanMonths({ variant_title: variantTitle }), null);
  }
});

test('does not use the product title as a subscription fallback', () => {
  assert.equal(
    getPlanMonths({ title: '12-Month Plan', variant_title: 'Default Title' }),
    null,
  );
});
