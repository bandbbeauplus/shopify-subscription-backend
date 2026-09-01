const axios = require('axios');
const httpError = require('../utils/httpError');

const OMS_MODE = process.env.OMS_MODE || 'manual';

function externalReference(shipment) {
  return `BB-${shipment.order_id}-${shipment.shipment_number}`.slice(0, 64);
}

function buildOrderPayload(shipment) {
  const address = shipment.shipping_address || {};
  const items = Array.isArray(shipment.line_items) && shipment.line_items.length
    ? shipment.line_items.map((item) => ({
      name: item.name || item.title || shipment.product_name,
      sku: item.sku || null,
      quantity: Math.max(1, Number(item.quantity || 1)),
    }))
    : [{
      name: shipment.product_name,
      sku: shipment.product_sku || null,
      quantity: Number(shipment.product_quantity || 1),
    }];
  return {
    external_reference: externalReference(shipment),
    source: 'shopify_fulfillment_app',
    shopify_order_id: String(shipment.order_id),
    scheduled_ship_date: shipment.scheduled_ship_date,
    recipient: {
      name: shipment.customer_name,
      email: shipment.customer_email,
      phone: shipment.customer_phone,
      address1: address.address1 || '',
      address2: address.address2 || '',
      city: address.city || '',
      province: address.province || '',
      postal_code: address.zip || '',
      country: address.country || 'PH',
    },
    items,
    metadata: {
      shipment_kind: shipment.shipment_kind || 'subscription',
      subscription_id: shipment.subscription_id,
      shipment_id: shipment.id,
      shipment_number: shipment.shipment_number,
      total_shipments: shipment.total_shipments,
    },
  };
}

function normalizeWarehouseStatus(value) {
  const status = String(value || '').trim().toLowerCase().replace(/[ -]+/g, '_');
  const mapping = {
    created: 'submitted',
    accepted: 'submitted',
    processing: 'picking',
    pick_in_progress: 'picking',
    picked: 'picking',
    packed: 'packed',
    fulfilled: 'packed',
    ready: 'packed',
    awb_received: 'awb_sent',
    ready_for_pickup: 'ready_for_pickup',
    failed: 'failed',
    cancelled: 'failed',
  };
  return mapping[status] || (new Set(['submitted', 'picking', 'packed', 'awb_sent', 'ready_for_pickup', 'failed']).has(status) ? status : null);
}

function apiClient() {
  const baseURL = process.env.OMS_API_BASE_URL;
  const token = process.env.OMS_API_TOKEN;
  if (!baseURL || !token) throw httpError(503, 'OMS API mode requires OMS_API_BASE_URL and OMS_API_TOKEN');
  return axios.create({
    baseURL,
    timeout: 15000,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

function resolvePath(template, orderId) {
  return template.replace('{order_id}', encodeURIComponent(orderId));
}

async function createFulfillmentOrder(shipment) {
  const reference = externalReference(shipment);
  if (OMS_MODE === 'mock' || OMS_MODE === 'manual') {
    const prefix = OMS_MODE === 'mock' ? 'MOCK' : 'SHOPIFY';
    return { orderId: `${prefix}-${reference}`, reference, status: 'submitted' };
  }

  const response = await apiClient().post(
    process.env.OMS_CREATE_ORDER_PATH || '/orders',
    buildOrderPayload(shipment),
    { headers: { 'Idempotency-Key': reference } }
  );
  const orderId = response.data?.id || response.data?.order_id || response.data?.data?.id;
  if (!orderId) throw httpError(502, 'OMS create-order response did not contain an order ID');
  return {
    orderId: String(orderId),
    reference,
    status: normalizeWarehouseStatus(response.data?.status || response.data?.data?.status) || 'submitted',
  };
}

async function getFulfillmentStatus(shipment) {
  if (OMS_MODE === 'mock') {
    const next = { submitted: 'picking', picking: 'packed', packed: 'packed' };
    return { status: next[shipment.warehouse_status] || shipment.warehouse_status };
  }
  if (OMS_MODE === 'manual') {
    throw httpError(409, 'Ninja Van warehouse status must be confirmed manually because no Anchanto status API is connected');
  }

  const template = process.env.OMS_ORDER_STATUS_PATH || '/orders/{order_id}';
  const response = await apiClient().get(resolvePath(template, shipment.oms_order_id));
  const status = normalizeWarehouseStatus(response.data?.status || response.data?.data?.status);
  if (!status) throw httpError(502, 'OMS returned an unsupported warehouse status');
  return { status };
}

async function sendAwb(shipment) {
  if (!shipment.spx_tracking_number) throw httpError(409, 'Create the SPX booking before sending the AWB');
  const awbUrl = shipment.google_awb_url || shipment.spx_awb_url;
  if (!awbUrl && OMS_MODE !== 'mock') throw httpError(409, 'A PDF AWB URL is required before warehouse handoff');

  if (OMS_MODE === 'mock' || OMS_MODE === 'manual') return { status: 'awb_sent' };

  const template = process.env.OMS_AWB_PATH || '/orders/{order_id}/awb';
  await apiClient().post(resolvePath(template, shipment.oms_order_id), {
    courier: 'SPX Express',
    tracking_number: shipment.spx_tracking_number,
    awb_pdf_url: awbUrl,
  });
  return { status: 'awb_sent' };
}

module.exports = {
  OMS_MODE,
  buildOrderPayload,
  createFulfillmentOrder,
  externalReference,
  getFulfillmentStatus,
  normalizeWarehouseStatus,
  sendAwb,
};
