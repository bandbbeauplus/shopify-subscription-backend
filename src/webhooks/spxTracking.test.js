const test = require('node:test');
const assert = require('node:assert/strict');
const { mappedShipmentStatus, nextShipmentStatus, optionalNumber, validPayload } = require('./spxTracking');

test('maps common SPX tracking events to internal shipment states', () => {
  assert.equal(mappedShipmentStatus('Pending Pickup', '1001'), 'ready_to_ship');
  assert.equal(mappedShipmentStatus('In Transit', '2001'), 'shipped');
  assert.equal(mappedShipmentStatus('Delivered', '4001'), 'delivered');
  assert.equal(mappedShipmentStatus('Pickup Failed', '5001'), 'failed');
});

test('does not turn missing SPX fee and weight fields into zero values', () => {
  assert.equal(optionalNumber(undefined), null);
  assert.equal(optionalNumber(''), null);
  assert.equal(optionalNumber('20.50'), 20.5);
});

test('does not let delayed SPX events downgrade shipped or delivered parcels', () => {
  assert.equal(nextShipmentStatus('shipped', 'ready_to_ship'), 'shipped');
  assert.equal(nextShipmentStatus('delivered', 'shipped'), 'delivered');
  assert.equal(nextShipmentStatus('shipped', 'delivered'), 'delivered');
});

test('requires an id, timestamp, and tracking or partner order reference', () => {
  assert.deepEqual(validPayload({ id: 'evt-1', tracking_no: 'SPEPH123', timestamp: 1788220800 }), {
    eventId: 'evt-1', trackingNo: 'SPEPH123', orderId: '', timestamp: 1788220800,
  });
  assert.equal(validPayload({ id: 'evt-1', timestamp: 1788220800 }), null);
});
