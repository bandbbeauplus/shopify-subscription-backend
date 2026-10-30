const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SPX_MODE = 'api';
process.env.SPX_ENVIRONMENT = 'production';
process.env.SPX_USER_SECRET = 'test-user-secret';
process.env.SPX_SENDER_STATE = 'South Luzon';
process.env.SPX_SENDER_CITY = 'Laguna';
process.env.SPX_SENDER_DISTRICT = 'Cabuyao';
process.env.SPX_SENDER_STREET = 'Pulo';
process.env.SPX_SENDER_POST_CODE = '4025';
process.env.SPX_SENDER_NAME = 'Test Warehouse';
process.env.SPX_SENDER_PHONE = '09171234567';
process.env.SPX_SENDER_DETAIL_ADDRESS = 'Warehouse in Pulo';

const { buildCreateOrderPayload, normalizeOrderResult } = require('./spxClient');

const pickupSlot = {
  pickup_time: 1788768000,
  pickup_time_range_id: 1,
  pickup_time_range: '08:00-12:00',
};

function shipment(address) {
  return {
    id: 42,
    customer_name: 'Example Customer',
    customer_phone: '09170000000',
    shipping_address: {
      address1: 'Unit 6A, Example Building, 24th Street',
      zip: '1634',
      ...address,
    },
    product_name: 'Example parcel',
    product_quantity: 1,
    total_shipments: 1,
    total_price_paid: '100.00',
    physical_box_count: 1,
    parcel_weight_kg: '0.188',
  };
}

test('maps Taguig/Fort Bonifacio to SPX exact four-layer delivery address', () => {
  const order = buildCreateOrderPayload(shipment({
    province: 'Metro Manila', city: 'Taguig', address2: 'Fort Bonifacio',
  }), { pickupSlot }).orders[0];
  assert.deepEqual([
    order.deliver_info.deliver_state,
    order.deliver_info.deliver_city,
    order.deliver_info.deliver_district,
    order.deliver_info.deliver_street,
  ], ['Metro Manila', 'Metro Manila', 'Taguig City', 'Fort Bonifacio']);
  assert.match(order.deliver_info.deliver_detail_address, /Unit 6A, Example Building/);
});

test('maps Quezon City/East Kamias using the same production lookup', () => {
  const order = buildCreateOrderPayload(shipment({
    province: 'Metro Manila', city: 'Quezon City', address2: 'East Kamias', zip: '1102',
  }), { pickupSlot }).orders[0];
  assert.deepEqual([
    order.deliver_info.deliver_state,
    order.deliver_info.deliver_city,
    order.deliver_info.deliver_district,
    order.deliver_info.deliver_street,
  ], ['Metro Manila', 'Metro Manila', 'Quezon City', 'East Kamias']);
});

test('blocks unrecognized barangay before submitting an SPX order', () => {
  assert.throws(() => buildCreateOrderPayload(shipment({
    province: 'Metro Manila', city: 'Taguig', address2: 'Unit 6A',
  }), { pickupSlot }), { statusCode: 422 });
});

test('blocks a detailed customer address that SPX would truncate', () => {
  assert.throws(() => buildCreateOrderPayload(shipment({
    province: 'Metro Manila', city: 'Taguig', address2: 'Fort Bonifacio',
    address1: 'Example Building '.repeat(20),
  }), { pickupSlot }), { statusCode: 422 });
});

test('blocks a warehouse address that is absent from SPX pickup locations', () => {
  const previous = process.env.SPX_SENDER_STREET;
  process.env.SPX_SENDER_STREET = 'Unknown Barangay';
  try {
    assert.throws(() => buildCreateOrderPayload(shipment({
      province: 'Metro Manila', city: 'Taguig', address2: 'Fort Bonifacio',
    }), { pickupSlot }), { statusCode: 503 });
  } finally {
    process.env.SPX_SENDER_STREET = previous;
  }
});

test('sends canonical SPX pickup names even when env casing differs', () => {
  const previous = process.env.SPX_SENDER_DISTRICT;
  process.env.SPX_SENDER_DISTRICT = 'cabuyao';
  try {
    const order = buildCreateOrderPayload(shipment({
      province: 'Metro Manila', city: 'Taguig', address2: 'Fort Bonifacio',
    }), { pickupSlot }).orders[0];
    assert.equal(order.sender_info.sender_district, 'Cabuyao');
  } finally {
    process.env.SPX_SENDER_DISTRICT = previous;
  }
});

test('shows SPX failure code instead of its request debug dump', () => {
  assert.equal(normalizeOrderResult({
    task_status: 4,
    fail_list: [{
      order_id: 'BB-42',
      message: 'NotSupportDeliverAddressErrorCode',
      debug_msg: 'order {"private":"request dump"}',
    }],
  }, 'BB-42').error, 'NotSupportDeliverAddressErrorCode');
});

test('does not expose raw SPX debug text when no message is supplied', () => {
  assert.equal(normalizeOrderResult({
    task_status: 4,
    fail_list: [{ order_id: 'BB-42', debug_msg: 'failed order: sensitive customer payload' }],
  }, 'BB-42').error, 'SPX order creation failed');
});
