const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOrderPayload, externalReference, normalizeWarehouseStatus } = require('./omsClient');

const shipment = {
  id: 9,
  subscription_id: 4,
  order_id: '12345',
  shipment_number: 2,
  total_shipments: 6,
  scheduled_ship_date: '2026-09-01',
  customer_name: 'Test Customer',
  customer_email: 'test@example.com',
  customer_phone: '09171234567',
  shipping_address: { address1: '123 Test St', city: 'Makati', province: 'Metro Manila', zip: '1200' },
  product_name: 'B&B Product',
  product_sku: 'BB-6M',
  product_quantity: 1,
  shipment_kind: 'subscription',
};

test('builds a deterministic unique OMS reference for a scheduled shipment', () => {
  assert.equal(externalReference(shipment), 'BB-12345-2');
  assert.equal(buildOrderPayload(shipment).external_reference, 'BB-12345-2');
  assert.equal(buildOrderPayload(shipment).items[0].sku, 'BB-6M');
});

test('preserves every Shopify line item for an ordinary warehouse order', () => {
  const payload = buildOrderPayload({
    ...shipment,
    shipment_kind: 'ordinary',
    line_items: [
      { name: 'Reset + Focus', sku: 'BBBRF1-7P', quantity: 2 },
      { name: 'Gut + Energy', sku: 'BBBGE1-14P', quantity: 1 },
    ],
  });
  assert.equal(payload.source, 'shopify_fulfillment_app');
  assert.equal(payload.metadata.shipment_kind, 'ordinary');
  assert.deepEqual(payload.items.map((item) => item.sku), ['BBBRF1-7P', 'BBBGE1-14P']);
});

test('normalizes common OMS/WMS statuses', () => {
  assert.equal(normalizeWarehouseStatus('Pick In Progress'), 'picking');
  assert.equal(normalizeWarehouseStatus('fulfilled'), 'packed');
  assert.equal(normalizeWarehouseStatus('unknown status'), null);
});
