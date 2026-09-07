const crypto = require('node:crypto');
const axios = require('axios');
const httpError = require('../utils/httpError');
const { shipmentParcelProfile } = require('../utils/parcelProfile');

const SPX_MODE = process.env.SPX_MODE || 'disabled';
const SPX_ENVIRONMENT = process.env.SPX_ENVIRONMENT || 'uat';

const UAT_ADDRESS_PROFILE = Object.freeze({
  sender: {
    state: 'North Luzon',
    city: 'Pampanga',
    district: 'Angeles City',
    street: 'Amsic',
  },
  receiver: {
    state: 'Visayas',
    city: 'Eastern Samar',
    district: 'Oras',
    street: 'Agsam',
  },
});

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value || /^(replace_|your_)/i.test(value)) {
    throw httpError(503, `SPX API configuration is missing ${name}`);
  }
  return value;
}

function optionalEnv(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function positiveNumber(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(optionalEnv(name, fallback));
  if (!Number.isFinite(value) || value < min || value > max) {
    throw httpError(503, `${name} must be between ${min} and ${max}`);
  }
  return value;
}

function compactText(value, maxLength, field) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) throw httpError(422, `SPX requires ${field}`);
  return text.slice(0, maxLength);
}

function normalizePhone(value, field) {
  const phone = String(value || '').replace(/\D/g, '');
  if (!/^(0\d{10}|63\d{10})$/.test(phone)) {
    throw httpError(422, `${field} must be an 11-digit PH number beginning with 0 or a 12-digit number beginning with 63`);
  }
  return phone;
}

function generateRandomNum(timestamp) {
  const maximum = Number(timestamp);
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new Error('SPX timestamp must be a positive Unix timestamp');
  }
  return crypto.randomInt(0, maximum + 1).toString();
}

function generateCheckSign({ appId, appSecret, timestamp, randomNum, body }) {
  return crypto
    .createHmac('sha256', appSecret)
    .update([appId, timestamp, randomNum, body].join('_'), 'utf8')
    .digest('hex');
}

function serializeWithUserId(payload, userId) {
  if (!/^\d+$/.test(userId)) throw httpError(503, 'SPX_USER_ID must be an unsigned integer');
  const rawIntegers = [];
  const body = JSON.stringify({ user_id: userId, ...payload }, (key, value) => {
    if (new Set(['user_id', 'batch_no']).has(key) && /^\d+$/.test(String(value))) {
      const marker = `__SPX_INT64_${rawIntegers.length}__`;
      rawIntegers.push({ marker, value: String(value) });
      return marker;
    }
    return value;
  });
  return rawIntegers.reduce(
    (serialized, item) => serialized.replace(JSON.stringify(item.marker), item.value),
    body
  );
}

function parseSpxResponse(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '');
  const preserved = text.replace(
    /("(?:batch_no|user_id)"\s*:\s*)(\d+)/g,
    '$1"$2"'
  );
  return JSON.parse(preserved);
}

function isSpxConfigured() {
  if (SPX_MODE !== 'api') return false;
  const names = [
    'SPX_API_BASE_URL',
    'SPX_APP_ID',
    'SPX_APP_SECRET',
    'SPX_USER_ID',
    'SPX_USER_SECRET',
  ];
  if (SPX_ENVIRONMENT === 'uat') {
    names.push(
      'SPX_UAT_SENDER_PHONE',
      'SPX_UAT_SENDER_POST_CODE',
      'SPX_UAT_RECEIVER_PHONE',
      'SPX_UAT_RECEIVER_POST_CODE'
    );
  } else {
    names.push(
      'SPX_SENDER_PHONE',
      'SPX_SENDER_POST_CODE',
      'SPX_SENDER_STATE',
      'SPX_SENDER_CITY',
      'SPX_SENDER_DISTRICT',
      'SPX_SENDER_STREET',
      'SPX_SENDER_DETAIL_ADDRESS'
    );
  }
  return names.every((name) => {
    const value = String(process.env[name] || '').trim();
    return value && !/^(replace_|your_)/i.test(value);
  });
}

function senderInfo() {
  const profile = SPX_ENVIRONMENT === 'uat' ? UAT_ADDRESS_PROFILE.sender : null;
  const isUat = Boolean(profile);
  return {
    sender_state: compactText(profile?.state || requiredEnv('SPX_SENDER_STATE'), 64, 'sender state'),
    sender_city: compactText(profile?.city || requiredEnv('SPX_SENDER_CITY'), 64, 'sender city'),
    sender_district: compactText(profile?.district || requiredEnv('SPX_SENDER_DISTRICT'), 64, 'sender district'),
    sender_street: compactText(profile?.street || requiredEnv('SPX_SENDER_STREET'), 64, 'sender street'),
    sender_post_code: compactText(
      requiredEnv(isUat ? 'SPX_UAT_SENDER_POST_CODE' : 'SPX_SENDER_POST_CODE'),
      16,
      'sender postal code'
    ),
    sender_name: compactText(
      isUat
        ? optionalEnv('SPX_UAT_SENDER_NAME', 'B&B BEAU+ UAT')
        : optionalEnv('SPX_SENDER_NAME', 'Ninjavan Fulfillment Warehouse'),
      64,
      'sender name'
    ),
    sender_phone: normalizePhone(
      requiredEnv(isUat ? 'SPX_UAT_SENDER_PHONE' : 'SPX_SENDER_PHONE'),
      'SPX sender phone'
    ),
    sender_detail_address: compactText(
      isUat
        ? optionalEnv('SPX_UAT_SENDER_DETAIL_ADDRESS', profile.street)
        : requiredEnv('SPX_SENDER_DETAIL_ADDRESS'),
      256,
      'sender detailed address'
    ),
  };
}

function receiverInfo(shipment) {
  const address = shipment.shipping_address || {};
  const profile = SPX_ENVIRONMENT === 'uat' ? UAT_ADDRESS_PROFILE.receiver : null;
  const isUat = Boolean(profile);
  return {
    deliver_country: 'PH',
    deliver_state: compactText(profile?.state || address.province, 64, 'delivery state/province'),
    deliver_city: compactText(profile?.city || address.city, 64, 'delivery city'),
    deliver_district: compactText(profile?.district || address.district || address.address2, 64, 'delivery district/barangay'),
    deliver_street: compactText(profile?.street || address.street || address.address1, 64, 'delivery street'),
    deliver_post_code: compactText(
      isUat ? requiredEnv('SPX_UAT_RECEIVER_POST_CODE') : address.zip,
      16,
      'delivery postal code'
    ),
    deliver_name: compactText(
      isUat ? optionalEnv('SPX_UAT_RECEIVER_NAME', 'SPX UAT Receiver') : shipment.customer_name,
      64,
      'receiver name'
    ),
    deliver_phone: normalizePhone(
      isUat ? requiredEnv('SPX_UAT_RECEIVER_PHONE') : (shipment.customer_phone || address.phone),
      'SPX receiver phone'
    ),
    deliver_detail_address: compactText(
      isUat
        ? optionalEnv('SPX_UAT_RECEIVER_DETAIL_ADDRESS', profile.street)
        : [address.address1, address.address2].filter(Boolean).join(', '),
      256,
      'receiver detailed address'
    ),
    deliver_instruction: optionalEnv('SPX_DELIVERY_INSTRUCTION').slice(0, 256),
  };
}

function parcelInfo(shipment) {
  const totalPaid = Number(shipment.total_price_paid || 0);
  const totalShipments = Math.max(1, Number(shipment.total_shipments || 1));
  const configuredValue = optionalEnv('SPX_PARCEL_INSURED_VALUE');
  const insuredValue = configuredValue
    ? Number(configuredValue)
    : Math.round((totalPaid / totalShipments) * 100) / 100;
  if (!Number.isFinite(insuredValue) || insuredValue < 0 || insuredValue > 50000) {
    throw httpError(422, 'SPX parcel insured value must be between 0 and 50,000 PHP');
  }
  const unitBoxWeightG = positiveNumber('SPX_UNIT_BOX_WEIGHT_G', '188', {
    min: 1,
    max: 50000,
  });
  const profile = shipmentParcelProfile(shipment, unitBoxWeightG);
  const configuredWeight = optionalEnv('SPX_PARCEL_WEIGHT_KG');
  const parcelWeight = configuredWeight
    ? positiveNumber('SPX_PARCEL_WEIGHT_KG', '', { min: 0.001, max: 50 })
    : profile.parcelWeightKg;

  return {
    parcel_weight: parcelWeight,
    parcel_length: positiveNumber('SPX_PARCEL_LENGTH_CM', '20', { min: 0.001, max: 150 }),
    parcel_width: positiveNumber('SPX_PARCEL_WIDTH_CM', '15', { min: 0.001, max: 150 }),
    parcel_height: positiveNumber('SPX_PARCEL_HEIGHT_CM', '10', { min: 0.001, max: 150 }),
    parcel_item_name: compactText(shipment.product_name, 64, 'parcel item name'),
    parcel_item_quantity: profile.physicalBoxCount,
    express_insured_value: insuredValue,
    parcel_item_type: compactText(optionalEnv('SPX_ITEM_TYPE', 'Food and beverage'), 64, 'parcel item type'),
  };
}

function spxOrderId(shipment) {
  return `BB-${shipment.id}`.slice(0, 32);
}

function pickupSlotOverride() {
  const pickupTime = optionalEnv('SPX_PICKUP_TIME');
  const rangeId = optionalEnv('SPX_PICKUP_TIME_RANGE_ID');
  const range = optionalEnv('SPX_PICKUP_TIME_RANGE');
  const configuredCount = [pickupTime, rangeId, range].filter(Boolean).length;
  if (configuredCount === 0) return null;
  if (configuredCount !== 3) {
    throw httpError(503, 'SPX pickup override requires SPX_PICKUP_TIME, SPX_PICKUP_TIME_RANGE_ID, and SPX_PICKUP_TIME_RANGE together');
  }
  return {
    pickup_time: positiveNumber('SPX_PICKUP_TIME', '', { min: 1 }),
    pickup_time_range_id: positiveNumber('SPX_PICKUP_TIME_RANGE_ID', '', { min: 1 }),
    pickup_time_range: range,
  };
}

function normalizePickupTimeslots(data) {
  const dates = Array.isArray(data) ? data : [];
  return dates.flatMap((date) => {
    const pickupTime = Number(date?.pickup_time);
    if (!Number.isFinite(pickupTime) || pickupTime <= 0) return [];
    const slots = Array.isArray(date?.slots) ? date.slots : [];
    return slots.flatMap((slot) => {
      const rangeId = Number(slot?.pickup_time_range_id);
      const range = String(slot?.pickup_time_range || '').trim();
      if (!Number.isFinite(rangeId) || rangeId < 1 || !range) return [];
      return [{
        pickup_time: pickupTime,
        pickup_time_range_id: rangeId,
        pickup_time_range: range,
      }];
    });
  });
}

async function resolvePickupSlot() {
  const override = pickupSlotOverride();
  if (override) return override;
  const data = await callSpx('/open/api/v1/order/get_pickup_time', {
    user_secret: requiredEnv('SPX_USER_SECRET'),
    service_type: 1,
  });
  const slots = normalizePickupTimeslots(data);
  if (!slots.length) throw httpError(502, 'SPX returned no available pickup timeslots');
  return slots[0];
}

function buildCreateOrderPayload(shipment, { pickupSlot = null } = {}) {
  const collectType = Number(optionalEnv('SPX_COLLECT_TYPE', SPX_ENVIRONMENT === 'uat' ? '2' : '1'));
  if (![1, 2].includes(collectType)) throw httpError(503, 'SPX_COLLECT_TYPE must be 1 (pickup) or 2 (drop off)');

  const fulfillmentInfo = {
    payment_role: 1,
    cod_collection: 0,
    collect_type: collectType,
  };
  if (collectType === 1) {
    const selectedSlot = pickupSlot || pickupSlotOverride();
    if (!selectedSlot) {
      throw httpError(503, 'SPX pickup timeslot must be resolved before creating a pickup order');
    }
    fulfillmentInfo.pickup_time = Number(selectedSlot.pickup_time);
    fulfillmentInfo.pickup_time_range_id = Number(selectedSlot.pickup_time_range_id);
    fulfillmentInfo.pickup_time_range = String(selectedSlot.pickup_time_range || '').trim();
  }

  return {
    user_secret: requiredEnv('SPX_USER_SECRET'),
    orders: [{
      order_id: spxOrderId(shipment),
      base_info: { service_type: 1 },
      sender_info: senderInfo(),
      fulfillment_info: fulfillmentInfo,
      deliver_info: receiverInfo(shipment),
      parcel_info: parcelInfo(shipment),
    }],
  };
}

async function callSpx(endpoint, payload) {
  if (SPX_MODE !== 'api') throw httpError(503, 'SPX_MODE must be api before using direct SPX booking');
  const baseUrl = requiredEnv('SPX_API_BASE_URL').replace(/\/$/, '');
  if (SPX_ENVIRONMENT === 'uat' && baseUrl !== 'https://test-stable.spx.ph') {
    throw httpError(503, 'SPX UAT requests must use https://test-stable.spx.ph');
  }
  if (SPX_ENVIRONMENT !== 'uat' && baseUrl === 'https://test-stable.spx.ph') {
    throw httpError(503, 'SPX production requests cannot use the UAT base URL');
  }
  const appId = requiredEnv('SPX_APP_ID');
  const appSecret = requiredEnv('SPX_APP_SECRET');
  const userId = requiredEnv('SPX_USER_ID');
  const body = serializeWithUserId(payload, userId);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const randomNum = generateRandomNum(timestamp);
  const checkSign = generateCheckSign({ appId, appSecret, timestamp, randomNum, body });

  let response;
  try {
    response = await axios.post(`${baseUrl}${endpoint}`, body, {
      timeout: positiveNumber('SPX_API_TIMEOUT_MS', '20000', { min: 1000, max: 60000 }),
      transformRequest: [(value) => value],
      transformResponse: [(value) => parseSpxResponse(value)],
      validateStatus: () => true,
      headers: {
        'Content-Type': 'application/json',
        'app-id': appId,
        timestamp,
        'random-num': randomNum,
        'check-sign': checkSign,
      },
    });
  } catch (error) {
    const code = error?.code ? ` (${error.code})` : '';
    throw httpError(502, `SPX request could not be completed${code}`);
  }

  const data = response.data;
  if (response.status < 200 || response.status >= 300) {
    throw httpError(502, `SPX returned HTTP ${response.status}`);
  }
  if (!data || typeof data !== 'object') throw httpError(502, 'SPX returned a non-JSON response');
  if (Number(data.ret_code) !== 0) {
    throw httpError(502, `SPX rejected the request (${data.ret_code}): ${String(data.message || 'Unknown error').trim()}`);
  }
  return data.data || {};
}

async function createOrder(shipment) {
  const collectType = Number(optionalEnv('SPX_COLLECT_TYPE', SPX_ENVIRONMENT === 'uat' ? '2' : '1'));
  const pickupSlot = collectType === 1 ? await resolvePickupSlot() : null;
  const data = await callSpx(
    '/open/api/v2/order/batch_create_order',
    buildCreateOrderPayload(shipment, { pickupSlot })
  );
  const batchNo = String(data.batch_no || '').trim();
  if (!/^\d+$/.test(batchNo)) throw httpError(502, 'SPX create-order response did not contain a valid batch number');
  return { batchNo, orderId: spxOrderId(shipment) };
}

async function getOrderCreateResult(batchNo, expectedOrderId) {
  const data = await callSpx('/open/api/v2/order/get_order_create_result', {
    user_secret: requiredEnv('SPX_USER_SECRET'),
    batch_no: String(batchNo),
  });
  return normalizeOrderResult(data, expectedOrderId);
}

function normalizeOrderResult(data, expectedOrderId) {
  const taskStatus = Number(data.task_status);
  if ([1, 2, 3].includes(taskStatus)) {
    return { state: 'processing', taskStatus, description: String(data.description || 'Processing') };
  }
  const orders = Array.isArray(data.orders) ? data.orders : [];
  const order = orders.find((item) => String(item.order_id) === String(expectedOrderId)) || orders[0];
  if (taskStatus === 4 && order?.tracking_no) {
    return {
      state: 'created',
      taskStatus,
      trackingNumber: String(order.tracking_no),
      trackingUrl: String(order.tracking_link || order.tracking_no_link || ''),
    };
  }
  const failures = Array.isArray(data.fail_list) ? data.fail_list : [];
  const failure = failures.find((item) => String(item.order_id) === String(expectedOrderId)) || failures[0];
  return {
    state: 'failed',
    taskStatus,
    error: String(failure?.debug_msg || failure?.message || data.description || 'SPX order creation failed'),
  };
}

async function getAwb(batchNo) {
  const data = await callSpx('/open/api/v2/order/batch_get_shipping_label', {
    user_secret: requiredEnv('SPX_USER_SECRET'),
    batch_no: String(batchNo),
  });
  return normalizeAwbResult(data);
}

function normalizeAwbResult(data) {
  const taskStatus = Number(data.task_status);
  if ([1, 2, 3].includes(taskStatus)) {
    return { state: 'processing', taskStatus, description: String(data.description || 'Generating AWB') };
  }
  if (taskStatus === 4 && data.awb_link) {
    return { state: 'ready', taskStatus, awbUrl: String(data.awb_link) };
  }
  return {
    state: 'failed',
    taskStatus,
    error: String(data.description || 'SPX AWB generation failed'),
  };
}

module.exports = {
  SPX_ENVIRONMENT,
  SPX_MODE,
  UAT_ADDRESS_PROFILE,
  buildCreateOrderPayload,
  createOrder,
  generateCheckSign,
  getAwb,
  getOrderCreateResult,
  isSpxConfigured,
  normalizeAwbResult,
  normalizeOrderResult,
  normalizePickupTimeslots,
  parseSpxResponse,
  resolvePickupSlot,
  serializeWithUserId,
  spxOrderId,
};
