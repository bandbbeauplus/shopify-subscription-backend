const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { HEADERS, buildSpxWorkbook } = require('./spxWorkbook');

const shipment = {
  id: 42, order_id: '1234567890', shipment_number: 1, customer_name: 'Test Customer', customer_phone: '+63 912 345 6789',
  shipping_address: { address1: '123 Test Street', address2: 'Barangay Test', city: 'Quezon City', province: 'Metro Manila', zip: '1100' },
  product_name: 'B&B BEAU+', total_price_paid: '3600.00', plan_months: 6,
};

test('creates one-sheet SPX workbook with the requested headers', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildSpxWorkbook([shipment]));
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Order Sheet']);
  assert.deepEqual(workbook.getWorksheet('Order Sheet').getRow(1).values.slice(1), HEADERS);
  assert.equal(workbook.getWorksheet('Order Sheet').getCell('B2').value, '9123456789');
  assert.equal(workbook.getWorksheet('Order Sheet').getCell('I2').value, 0.2);
  assert.equal(workbook.getWorksheet('Order Sheet').getCell('Q2').value, 'Sender Pay');
  assert.equal(workbook.getWorksheet('Order Sheet').getCell('S2').value, 'N');
  assert.equal(workbook.getWorksheet('Order Sheet').getCell('U2').value, 600);
});

test('rejects phone numbers that SPX will not accept', async () => {
  await assert.rejects(() => buildSpxWorkbook([{ ...shipment, customer_phone: '1234' }]), /10 digits starting with 9/);
});
