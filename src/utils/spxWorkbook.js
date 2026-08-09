const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const httpError = require('./httpError');

const TEMPLATE_PATH = path.resolve(
  __dirname,
  '../../assets/mass_order_creation_template_ph_V2.xlsx'
);
const TEMPLATE_BUFFER = fs.readFileSync(TEMPLATE_PATH);
const ITEM_TYPES = new Set([
  'Food and beverage',
  'Clothing',
  'Electronics',
  'Medical',
  'Groceries',
  'General merchandise',
  'Fragile',
]);
const PAYMENT_METHODS = new Set(['Sender Pay', 'Receiver Pay']);
const TEXT_COLUMNS = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M', 'N', 'P', 'Q', 'R', 'S']);
const COLUMNS = 'ABCDEFGHIJKLMNOPQRSTUV'.split('');

function numericSetting(name, fallback) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw httpError(500, `${name} must be a positive number`);
  }
  return value;
}

function choiceSetting(name, fallback, allowed) {
  const value = process.env[name] || fallback;
  if (!allowed.has(value)) {
    throw httpError(500, `${name} has an unsupported value`);
  }
  return value;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function normalizePhone(value, shipmentId) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('63') && digits.length === 12) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
  if (!/^9\d{9}$/.test(digits)) {
    throw httpError(422, `Shipment ${shipmentId} needs a Philippine phone number with 10 digits starting with 9`);
  }
  return digits;
}

function requiredText(value, field, shipmentId) {
  const text = String(value || '').trim();
  if (!text) throw httpError(422, `Shipment ${shipmentId} is missing ${field}`);
  return text;
}

function shipmentValues(shipment) {
  const address = shipment.shipping_address || {};
  const recipientName = requiredText(shipment.customer_name, 'recipient name', shipment.id).slice(0, 250);
  const phone = normalizePhone(shipment.customer_phone, shipment.id);
  const detailedAddress = [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.zip,
  ].filter(Boolean).join(', ').slice(0, 250);
  if (!detailedAddress) throw httpError(422, `Shipment ${shipment.id} is missing a delivery address`);

  const planMonths = Number(shipment.plan_months);
  const totalPaid = Number(shipment.total_price_paid);
  if (!Number.isFinite(planMonths) || planMonths <= 0 || !Number.isFinite(totalPaid) || totalPaid <= 0) {
    throw httpError(422, `Shipment ${shipment.id} is missing a valid parcel value`);
  }

  const itemType = choiceSetting('SPX_ITEM_TYPE', 'General merchandise', ITEM_TYPES);
  const paymentMethod = choiceSetting('SPX_PAYMENT_METHOD', 'Sender Pay', PAYMENT_METHODS);
  const reference = `BB-${shipment.order_id}-${shipment.shipment_number}`.slice(0, 32);

  return {
    A: recipientName,
    B: phone,
    C: detailedAddress,
    D: '',
    E: String(address.province || '').trim(),
    F: String(address.city || '').trim(),
    G: '',
    H: String(address.zip || '0000').trim(),
    I: numericSetting('SPX_PARCEL_WEIGHT_KG', 0.2),
    J: numericSetting('SPX_PARCEL_LENGTH_CM', 20),
    K: numericSetting('SPX_PARCEL_WIDTH_CM', 15),
    L: numericSetting('SPX_PARCEL_HEIGHT_CM', 10),
    M: itemType,
    N: requiredText(shipment.product_name, 'item name', shipment.id).slice(0, 250),
    O: 1,
    P: reference,
    Q: paymentMethod,
    R: String(process.env.SPX_DELIVERY_INSTRUCTION || '').slice(0, 256),
    S: 'N',
    T: '',
    U: Math.min(50000, Math.round((totalPaid / planMonths) * 100) / 100),
    V: '',
  };
}

function existingStyles(rowXml) {
  const styles = new Map();
  for (const match of rowXml.matchAll(/<c\s+([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g)) {
    const attributes = match[1];
    const reference = attributes.match(/\br="([A-Z]+)\d+"/i)?.[1];
    const style = attributes.match(/\bs="(\d+)"/i)?.[1];
    if (reference) styles.set(reference.toUpperCase(), style || '13');
  }
  return styles;
}

function cellXml(column, rowNumber, value, style) {
  const reference = `${column}${rowNumber}`;
  if (value === '' || value === null || value === undefined) {
    return `<c r="${reference}" s="${style}"/>`;
  }
  if (TEXT_COLUMNS.has(column)) {
    return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  }
  return `<c r="${reference}" s="${style}"><v>${escapeXml(value)}</v></c>`;
}

function populateOrderSheet(sheetXml, shipments) {
  const rows = new Map(shipments.map((shipment, index) => [index + 2, shipmentValues(shipment)]));
  return sheetXml.replace(/<row r="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g, (full, rawRow, attributes, body) => {
    const rowNumber = Number(rawRow);
    const values = rows.get(rowNumber);
    if (!values) return full;

    const styles = existingStyles(body);
    const cells = COLUMNS.map((column) => {
      const fallbackStyle = column === 'T' ? '20' : '13';
      return cellXml(column, rowNumber, values[column], styles.get(column) || fallbackStyle);
    }).join('');
    return `<row r="${rowNumber}"${attributes}>${cells}</row>`;
  });
}

function buildSpxWorkbook(shipments) {
  if (!shipments.length) throw httpError(404, 'No pending shipments are available for export');
  if (shipments.length > 998) throw httpError(413, 'SPX exports are limited to 998 shipments per file');

  const zip = new AdmZip(TEMPLATE_BUFFER);
  const sheetEntry = zip.getEntry('xl/worksheets/sheet1.xml');
  if (!sheetEntry) throw httpError(500, 'SPX workbook template is invalid');

  const populated = populateOrderSheet(sheetEntry.getData().toString('utf8'), shipments);
  zip.updateFile('xl/worksheets/sheet1.xml', Buffer.from(populated, 'utf8'));
  return zip.toBuffer();
}

module.exports = { buildSpxWorkbook };
