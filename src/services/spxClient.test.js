const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SPX_MODE = 'api';
process.env.SPX_ENVIRONMENT = 'uat';
process.env.SPX_USER_SECRET = 'test-user-secret';
process.env.SPX_UAT_SENDER_POST_CODE = '2009';
process.env.SPX_UAT_SENDER_PHONE = '09171234567';
process.env.SPX_UAT_RECEIVER_POST_CODE = '6818';
process.env.SPX_UAT_RECEIVER_PHONE = '09179876543';

const {
  buildCreateOrderPayload,
  generateCheckSign,
  normalizeAwbResult,
  normalizeOrderResult,
  normalizePickupTimeslots,
  parseSpxResponse,
  serializeWithUserId,
} = require('./spxClient');

const shipment = {
  id: 42,
  customer_name: 'Real Customer',
  customer_phone: '09170000000',
  shipping_address: {
    address1: 'A real customer address',
    city: 'Makati',
    province: 'Metro Manila',
    zip: '1200',
  },
  product_name: 'B&B BEAU+ Gut + Energy',
  product_quantity: 1,
  total_shipments: 3,
  total_price_paid: '13197.00',
  physical_box_count: 4,
  parcel_weight_kg: '0.752',
};

test('matches the official SPX signing vector', () => {
  const body = '{"user_id":239404781503925,"user_secret":"85f0d570-a265-4d9d-857e-b30aa57c4fbe","service_type":1}';
  assert.equal(generateCheckSign({
    appId: 100000,
    appSecret: 'H25HY53GO4BA2GQ',
    timestamp: 1677918414,
    randomNum: 926611981,
    body,
  }), '97e21b23940e4ddc96fb4d2474f02425353d2b0e23aee384f3f94c3d0b9ba17d');
});

test('serializes an int64 user id as an unquoted JSON integer', () => {
  assert.equal(
    serializeWithUserId({ user_secret: 'secret', batch_no: 12 }, '9223372036854775807'),
    '{"user_id":9223372036854775807,"user_secret":"secret","batch_no":12}'
  );
  assert.equal(
    serializeWithUserId({ user_secret: 'secret', batch_no: '9223372036854775806' }, '9223372036854775807'),
    '{"user_id":9223372036854775807,"user_secret":"secret","batch_no":9223372036854775806}'
  );
  assert.equal(
    parseSpxResponse('{"ret_code":0,"data":{"batch_no":9223372036854775806}}').data.batch_no,
    '9223372036854775806'
  );
});

test('uses only the SPX-approved UAT address profile in UAT mode', () => {
  const payload = buildCreateOrderPayload(shipment);
  const order = payload.orders[0];
  assert.equal(order.order_id, 'BB-42');
  assert.equal(order.sender_info.sender_state, 'North Luzon');
  assert.equal(order.sender_info.sender_street, 'Amsic');
  assert.equal(order.deliver_info.deliver_state, 'Visayas');
  assert.equal(order.deliver_info.deliver_street, 'Agsam');
  assert.doesNotMatch(order.deliver_info.deliver_detail_address, /real customer/i);
  assert.equal(order.fulfillment_info.collect_type, 2);
  assert.equal(order.fulfillment_info.cod_collection, 0);
  assert.equal(order.parcel_info.express_insured_value, 4399);
  assert.equal(order.parcel_info.parcel_weight, 0.752);
  assert.equal(order.parcel_info.parcel_item_quantity, 4);
});

test('normalizes asynchronous order creation results', () => {
  assert.deepEqual(normalizeOrderResult({ task_status: 2, description: 'Waiting' }, 'BB-42'), {
    state: 'processing', taskStatus: 2, description: 'Waiting',
  });
  assert.equal(normalizeOrderResult({
    task_status: 4,
    orders: [{ order_id: 'BB-42', tracking_no: 'SPXPH123', tracking_no_link: 'https://example.test/track' }],
  }, 'BB-42').trackingNumber, 'SPXPH123');
  assert.equal(normalizeOrderResult({
    task_status: 4,
    fail_list: [{ order_id: 'BB-42', debug_msg: 'Address rejected' }],
  }, 'BB-42').error, 'SPX order creation failed');
});

test('normalizes asynchronous AWB results', () => {
  assert.equal(normalizeAwbResult({ task_status: 3, description: 'Running' }).state, 'processing');
  assert.deepEqual(normalizeAwbResult({ task_status: 4, awb_link: 'https://example.test/awb.pdf' }), {
    state: 'ready', taskStatus: 4, awbUrl: 'https://example.test/awb.pdf',
  });
});

test('normalizes pickup timeslots in the order returned by SPX', () => {
  assert.deepEqual(normalizePickupTimeslots([{
    date: '07-09-2026',
    pickup_time: 1788768000,
    slots: [
      { pickup_time_range_id: 1, pickup_time_range: '08:00-12:00' },
      { pickup_time_range_id: 2, pickup_time_range: '12:01-19:00' },
    ],
  }]), [
    { pickup_time: 1788768000, pickup_time_range_id: 1, pickup_time_range: '08:00-12:00' },
    { pickup_time: 1788768000, pickup_time_range_id: 2, pickup_time_range: '12:01-19:00' },
  ]);
});
