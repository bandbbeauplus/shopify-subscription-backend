const { Readable } = require('node:stream');
const axios = require('axios');
const { google } = require('googleapis');
const httpError = require('../utils/httpError');

const GOOGLE_AWB_MODE = process.env.GOOGLE_AWB_MODE || 'disabled';
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
];
const SHEET_HEADERS = [
  'Shipment ID',
  'Shopify Order',
  'SKU',
  'SPX Tracking Number',
  'AWB PDF',
  'Generated At',
  'Print Status',
  'Environment',
];

let cachedClients;

function optionalEnv(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function configuredValue(name) {
  const value = optionalEnv(name);
  return Boolean(value && !/^(replace_|your_)/i.test(value));
}

function isGoogleAwbConfigured() {
  if (GOOGLE_AWB_MODE !== 'api') return false;
  const hasCredentials = configuredValue('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64')
    || (
      configuredValue('GOOGLE_SERVICE_ACCOUNT_EMAIL')
      && configuredValue('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')
    );
  return hasCredentials
    && configuredValue('GOOGLE_DRIVE_FOLDER_ID')
    && configuredValue('GOOGLE_SHEET_ID');
}

function requiredEnv(name) {
  if (!configuredValue(name)) {
    throw httpError(503, `Google AWB configuration is missing ${name}`);
  }
  return optionalEnv(name);
}

function serviceAccountCredentials() {
  const encoded = optionalEnv('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64');
  if (encoded && !/^(replace_|your_)/i.test(encoded)) {
    try {
      const credentials = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (!credentials.client_email || !credentials.private_key) throw new Error('Missing fields');
      return credentials;
    } catch {
      throw httpError(503, 'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not valid service-account JSON');
    }
  }
  return {
    client_email: requiredEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    private_key: requiredEnv('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY').replace(/\\n/g, '\n'),
  };
}

function googleClients() {
  if (cachedClients) return cachedClients;
  if (!isGoogleAwbConfigured()) {
    throw httpError(503, 'Google Drive and Sheets AWB integration is not fully configured');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccountCredentials(),
    scopes: GOOGLE_SCOPES,
  });
  cachedClients = {
    drive: google.drive({ version: 'v3', auth }),
    sheets: google.sheets({ version: 'v4', auth }),
  };
  return cachedClients;
}

function assertSpxAwbUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw httpError(502, 'SPX returned an invalid AWB URL');
  }
  if (
    url.protocol !== 'https:'
    || !(url.hostname === 'spx.ph' || url.hostname.endsWith('.spx.ph'))
  ) {
    throw httpError(502, 'SPX AWB URL must use an approved spx.ph HTTPS host');
  }
  return url.toString();
}

function safeFilePart(value, fallback) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || fallback;
}

function awbFilename(shipment) {
  const order = safeFilePart(
    shipment.shopify_delivery_order_name || shipment.order_id,
    `shipment-${shipment.id}`
  );
  const tracking = safeFilePart(shipment.spx_tracking_number, 'tracking-pending');
  return `SPX-AWB-${order}-${tracking}.pdf`;
}

function buildSheetRow(
  shipment,
  driveUrl,
  generatedAt = new Date(),
  printStatus = 'Pending'
) {
  return [
    String(shipment.id),
    String(shipment.shopify_delivery_order_name || shipment.order_id || ''),
    String(shipment.product_sku || ''),
    String(shipment.spx_tracking_number || ''),
    String(driveUrl),
    generatedAt.toISOString(),
    String(printStatus || 'Pending'),
    String(process.env.SPX_ENVIRONMENT || 'uat'),
  ];
}

function quoteSheetTitle(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function downloadAwbPdf(awbUrl) {
  const url = assertSpxAwbUrl(awbUrl);
  let response;
  try {
    response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 15 * 1024 * 1024,
      maxBodyLength: 15 * 1024 * 1024,
      validateStatus: () => true,
    });
  } catch {
    throw httpError(502, 'The SPX AWB PDF could not be downloaded');
  }
  if (response.status < 200 || response.status >= 300) {
    throw httpError(502, `SPX AWB download returned HTTP ${response.status}`);
  }
  const pdf = Buffer.from(response.data);
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/pdf') && pdf.subarray(0, 5).toString() !== '%PDF-') {
    throw httpError(502, 'The SPX AWB download was not a PDF');
  }
  return pdf;
}

async function findDriveFile(drive, folderId, name) {
  const response = await drive.files.list({
    q: `'${escapeDriveQuery(folderId)}' in parents and name = '${escapeDriveQuery(name)}' and trashed = false`,
    spaces: 'drive',
    fields: 'files(id,name,webViewLink)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: 1,
  });
  return response.data.files?.[0] || null;
}

async function uploadAwbPdf(drive, shipment, awbUrl) {
  const folderId = requiredEnv('GOOGLE_DRIVE_FOLDER_ID');
  const name = awbFilename(shipment);
  const existing = await findDriveFile(drive, folderId, name);
  if (existing?.id) {
    return {
      id: existing.id,
      url: existing.webViewLink || `https://drive.google.com/file/d/${existing.id}/view`,
    };
  }

  const pdf = await downloadAwbPdf(awbUrl);
  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/pdf',
      parents: [folderId],
    },
    media: {
      mimeType: 'application/pdf',
      body: Readable.from(pdf),
    },
    fields: 'id,name,webViewLink',
    supportsAllDrives: true,
  });
  if (!response.data.id) throw httpError(502, 'Google Drive did not return an AWB file ID');
  return {
    id: response.data.id,
    url: response.data.webViewLink
      || `https://drive.google.com/file/d/${response.data.id}/view`,
  };
}

function rowNumberFromRange(value) {
  const match = String(value || '').match(/![A-Z]+(\d+)(?::[A-Z]+\d+)?$/i);
  return match ? Number(match[1]) : null;
}

async function upsertSheetRow(sheets, shipment, driveUrl) {
  const spreadsheetId = requiredEnv('GOOGLE_SHEET_ID');
  const tab = optionalEnv('GOOGLE_SHEET_TAB', 'AWB Monitoring');
  const quotedTab = quoteSheetTitle(tab);
  const range = `${quotedTab}!A:H`;
  const current = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = current.data.values || [];

  if (!rows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${quotedTab}!A1:H1`,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS] },
    });
    rows.push(SHEET_HEADERS);
  }

  const existingIndex = rows.findIndex(
    (row, index) => index > 0 && String(row[0]) === String(shipment.id)
  );
  if (existingIndex >= 0) {
    const rowNumber = existingIndex + 1;
    const values = buildSheetRow(
      shipment,
      driveUrl,
      new Date(),
      rows[existingIndex][6] || 'Pending'
    );
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${quotedTab}!A${rowNumber}:H${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [values] },
    });
    return rowNumber;
  }

  const values = buildSheetRow(shipment, driveUrl);
  const appended = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
  return rowNumberFromRange(appended.data.updates?.updatedRange);
}

async function syncAwbToGoogle(shipment) {
  if (!shipment.spx_tracking_number) {
    throw httpError(409, 'SPX tracking must be ready before Google AWB sync');
  }
  if (!shipment.spx_awb_url && !shipment.google_drive_file_id) {
    throw httpError(409, 'SPX AWB must be ready before Google AWB sync');
  }
  const { drive, sheets } = googleClients();
  let driveFile;
  if (shipment.google_drive_file_id) {
    driveFile = {
      id: shipment.google_drive_file_id,
      url: shipment.google_awb_url
        || `https://drive.google.com/file/d/${shipment.google_drive_file_id}/view`,
    };
  } else {
    driveFile = await uploadAwbPdf(drive, shipment, shipment.spx_awb_url);
  }
  const sheetRow = await upsertSheetRow(sheets, shipment, driveFile.url);
  return {
    driveFileId: driveFile.id,
    driveUrl: driveFile.url,
    sheetRow,
  };
}

module.exports = {
  GOOGLE_AWB_MODE,
  SHEET_HEADERS,
  assertSpxAwbUrl,
  awbFilename,
  buildSheetRow,
  isGoogleAwbConfigured,
  quoteSheetTitle,
  rowNumberFromRange,
  syncAwbToGoogle,
};
