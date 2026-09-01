const test = require('node:test');
const assert = require('node:assert/strict');
const {
  boxesPerUnit,
  shipmentParcelProfile,
  summarizeItems,
} = require('./parcelProfile');

test('maps ordinary sachet bundles to their physical box counts', () => {
  assert.equal(boxesPerUnit({ variant_title: '7 Sachets', sku: 'BBBRF1-7P' }), 1);
  assert.equal(boxesPerUnit({ variant_title: '14 Sachets', sku: 'BBBRF1-14P' }), 2);
  assert.equal(boxesPerUnit({ variant_title: '28 Sachets', sku: 'BBBRF1-28P' }), 4);
});

test('maps every prepaid monthly plan delivery to four physical boxes', () => {
  assert.equal(boxesPerUnit({ variant_title: '1-Month Plan', sku: 'BBBGE-SP1M' }), 4);
  assert.equal(boxesPerUnit({ variant_title: '12-Month Plan - Get Monthly Shipments', sku: 'BBBGE-SP12M' }), 4);
});

test('calculates parcel weight from 188 grams per physical box', () => {
  const summary = summarizeItems([
    { title: 'B&B subscription', variant_title: '3-Month Plan - Get Monthly Shipments', quantity: 1 },
  ]);
  assert.equal(summary.physicalBoxCount, 4);
  assert.equal(summary.parcelWeightKg, 0.752);
});

test('combines multiple ordinary line items into one Shopify-order parcel', () => {
  const summary = summarizeItems([
    { title: 'Reset + Focus', variant_title: '7 Sachets', sku: 'BBBRF1-7P', quantity: 2 },
    { title: 'Gut + Energy', variant_title: '14 Sachets', sku: 'BBBGE1-14P', quantity: 1 },
  ]);
  assert.equal(summary.physicalBoxCount, 4);
  assert.equal(summary.parcelWeightKg, 0.752);
  assert.equal(summary.productQuantity, 3);
  assert.equal(summary.productSku, 'BBBRF1-7P, BBBGE1-14P');
});

test('uses stored parcel metrics when a shipment already has them', () => {
  assert.deepEqual(shipmentParcelProfile({
    physical_box_count: 4,
    parcel_weight_kg: '0.752',
  }), {
    physicalBoxCount: 4,
    parcelWeightKg: 0.752,
  });
});

test('backfills legacy subscription shipments as four boxes per plan unit', () => {
  assert.deepEqual(
    shipmentParcelProfile({ subscription_id: 9, product_quantity: 1, line_items: [] }),
    { physicalBoxCount: 4, parcelWeightKg: 0.752 }
  );
});
