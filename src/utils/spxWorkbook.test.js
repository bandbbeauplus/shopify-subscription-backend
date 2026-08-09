const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { buildSpxWorkbook } = require('./spxWorkbook');

const shipment = {
  id: 42,
  order_id: '1234567890',
  shipment_number: 1,
  customer_name: 'Test Customer',
  customer_phone: '+63 912 345 6789',
  shipping_address: {
    address1: '123 Test Street',
    address2: 'Barangay Test',
    city: 'Quezon City',
    province: 'Metro Manila',
    zip: '1100',
  },
  product_name: 'B&B BEAU+',
  total_price_paid: '3600.00',
  plan_months: 6,
};

test('populates the official SPX workbook without removing template sheets', () => {
  const buffer = buildSpxWorkbook([shipment]);
  const zip = new AdmZip(buffer);
  const workbookXml = zip.readAsText('xl/workbook.xml');
  const orderSheetXml = zip.readAsText('xl/worksheets/sheet1.xml');

  assert.match(workbookXml, /name="Order Sheet"/);
  assert.match(workbookXml, /name="region_list"[^>]*state="hidden"/);
  assert.match(orderSheetXml, /<c r="A2"[^>]*>.*Test Customer.*<\/c>/);
  assert.match(orderSheetXml, /<c r="B2"[^>]*>.*9123456789.*<\/c>/);
  assert.match(orderSheetXml, /<c r="I2"[^>]*><v>0\.2<\/v><\/c>/);
  assert.match(orderSheetXml, /<c r="Q2"[^>]*>.*Sender Pay.*<\/c>/);
  assert.match(orderSheetXml, /<c r="S2"[^>]*>.*N.*<\/c>/);
  assert.match(orderSheetXml, /<c r="U2"[^>]*><v>600<\/v><\/c>/);
  assert.match(orderSheetXml, /<dataValidations count="5">/);
});

test('rejects phone numbers that SPX will not accept', () => {
  assert.throws(
    () => buildSpxWorkbook([{ ...shipment, customer_phone: '1234' }]),
    /10 digits starting with 9/
  );
});
