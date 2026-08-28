const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertSpxAwbUrl,
  awbFilename,
  buildSheetRow,
  quoteSheetTitle,
  rowNumberFromRange,
} = require('./googleAwbClient');

const shipment = {
  id: 42,
  order_id: '567890123',
  shopify_delivery_order_name: '#1005',
  product_sku: 'TEST-BBBGE-SP1M',
  spx_tracking_number: 'SPEPH061801306218',
};

test('accepts only HTTPS SPX AWB hosts', () => {
  assert.equal(
    assertSpxAwbUrl('https://test-stable.spx.ph/downloads/awb.pdf?token=test'),
    'https://test-stable.spx.ph/downloads/awb.pdf?token=test'
  );
  assert.throws(() => assertSpxAwbUrl('http://test-stable.spx.ph/awb.pdf'));
  assert.throws(() => assertSpxAwbUrl('https://example.com/awb.pdf'));
});

test('creates a deterministic safe AWB filename', () => {
  assert.equal(
    awbFilename(shipment),
    'SPX-AWB-1005-SPEPH061801306218.pdf'
  );
});

test('builds a monitoring row without customer personal information', () => {
  const row = buildSheetRow(
    shipment,
    'https://drive.google.com/file/d/test/view',
    new Date('2026-08-28T01:02:03.000Z')
  );
  assert.deepEqual(row.slice(0, 7), [
    '42',
    '#1005',
    'TEST-BBBGE-SP1M',
    'SPEPH061801306218',
    'https://drive.google.com/file/d/test/view',
    '2026-08-28T01:02:03.000Z',
    'Pending',
  ]);
});

test('escapes Google Sheet tab names and parses updated row numbers', () => {
  assert.equal(quoteSheetTitle("Ninja Van's AWBs"), "'Ninja Van''s AWBs'");
  assert.equal(rowNumberFromRange("'AWB Monitoring'!A12:H12"), 12);
  assert.equal(rowNumberFromRange(''), null);
});
