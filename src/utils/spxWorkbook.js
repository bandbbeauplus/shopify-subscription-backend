const ExcelJS = require('exceljs');
const httpError = require('./httpError');

const HEADERS = [
  '*Recipient Name', '*Recipient Phone', '*Detail Address', 'Region', 'Province',
  'Town/City', 'Barangay', 'Postal Code', '*Parcel Weight (KG)', '*Parcel Length (CM)',
  '*Parcel Width (CM)', '*Parcel Height (CM)', '*Item Type', '*Item Name', 'Item Quantity',
  'Customer Reference No.', '*Payment Method', 'Delivery Instruction', '*COD Collection (Y/N)',
  'COD Amount', '*Parcel Value (PHP)',
];
const ITEM_TYPES = new Set(['Food and beverage', 'Clothing', 'Electronics', 'Medical', 'Groceries', 'General merchandise', 'Fragile']);
const PAYMENT_METHODS = new Set(['Sender Pay', 'Receiver Pay']);
const WIDTHS = [24, 18, 42, 16, 20, 20, 20, 14, 18, 19, 18, 19, 22, 28, 14, 25, 18, 28, 22, 16, 20];

function numericSetting(name, fallback) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw httpError(500, `${name} must be a positive number`);
  return value;
}

function choiceSetting(name, fallback, allowed) {
  const value = process.env[name] || fallback;
  if (!allowed.has(value)) throw httpError(500, `${name} has an unsupported value`);
  return value;
}

function normalizePhone(value, shipmentId) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('63') && digits.length === 12) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
  if (!/^9\d{9}$/.test(digits)) throw httpError(422, `Shipment ${shipmentId} needs a Philippine phone number with 10 digits starting with 9`);
  return digits;
}

function requiredText(value, field, shipmentId, limit) {
  const text = String(value || '').trim();
  if (!text) throw httpError(422, `Shipment ${shipmentId} is missing ${field}`);
  return text.slice(0, limit);
}

function valuesForShipment(shipment) {
  const address = shipment.shipping_address || {};
  const region = String(address.region || address.region_name || '').trim();
  const province = String(address.province || '').trim();
  const town = String(address.city || address.town || '').trim();
  const barangay = String(address.barangay || address.barangay_name || '').trim();
  const detailAddress = [region, province, town, barangay, address.address1, address.address2].filter(Boolean).join(', ');
  const planMonths = Number(shipment.plan_months);
  const totalPaid = Number(shipment.total_price_paid);
  if (!Number.isFinite(planMonths) || planMonths <= 0 || !Number.isFinite(totalPaid) || totalPaid <= 0) {
    throw httpError(422, `Shipment ${shipment.id} is missing a valid parcel value`);
  }

  return [
    requiredText(shipment.customer_name, 'recipient name', shipment.id, 250),
    normalizePhone(shipment.customer_phone, shipment.id),
    requiredText(detailAddress, 'detail address', shipment.id, 250),
    region, province, town, barangay, String(address.zip || '0000').trim(),
    numericSetting('SPX_PARCEL_WEIGHT_KG', 0.2),
    numericSetting('SPX_PARCEL_LENGTH_CM', 20),
    numericSetting('SPX_PARCEL_WIDTH_CM', 15),
    numericSetting('SPX_PARCEL_HEIGHT_CM', 10),
    choiceSetting('SPX_ITEM_TYPE', 'General merchandise', ITEM_TYPES),
    requiredText(shipment.product_name, 'item name', shipment.id, 250),
    1, `BB-${shipment.order_id}-${shipment.shipment_number}`.slice(0, 32),
    choiceSetting('SPX_PAYMENT_METHOD', 'Sender Pay', PAYMENT_METHODS),
    String(process.env.SPX_DELIVERY_INSTRUCTION || '').slice(0, 256),
    'N', 0, Math.min(50000, Math.round((totalPaid / planMonths) * 100) / 100),
  ];
}

async function buildSpxWorkbook(shipments) {
  if (!shipments.length) throw httpError(404, 'No pending shipments are available for export');
  if (shipments.length > 998) throw httpError(413, 'SPX exports are limited to 998 shipments per file');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'B&B BEAU+ Subscription Admin';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Order Sheet');
  sheet.columns = HEADERS.map((header, index) => ({ header, key: `column_${index + 1}`, width: WIDTHS[index] }));
  const headerRow = sheet.getRow(1);
  headerRow.values = HEADERS;
  headerRow.height = 30;
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF214F40' } };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  shipments.forEach((shipment) => sheet.addRow(valuesForShipment(shipment)));
  sheet.getColumn(2).numFmt = '@';
  sheet.getColumn(8).numFmt = '@';
  sheet.getColumn(16).numFmt = '@';
  sheet.getColumn(9).numFmt = '0.00';
  sheet.getColumn(20).numFmt = '0.00';
  sheet.getColumn(21).numFmt = '0.00';
  sheet.autoFilter = { from: 'A1', to: 'U1' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.dataValidations.add('M2:M999', { type: 'list', allowBlank: false, formulae: ['"Food and beverage,Clothing,Electronics,Medical,Groceries,General merchandise,Fragile"'] });
  sheet.dataValidations.add('Q2:Q999', { type: 'list', allowBlank: false, formulae: ['"Sender Pay,Receiver Pay"'] });
  sheet.dataValidations.add('S2:S999', { type: 'list', allowBlank: false, formulae: ['"Y,N"'] });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { HEADERS, buildSpxWorkbook };
