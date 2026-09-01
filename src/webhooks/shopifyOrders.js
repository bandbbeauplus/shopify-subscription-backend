const express = require('express');
const pool = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { getPlanMonths } = require('../utils/subscriptionPlan');
const { summarizeItems } = require('../utils/parcelProfile');

const router = express.Router();
const ALLOWED_PLAN_MONTHS = new Set([1, 3, 6, 12]);

function addMonths(date, months) {
  const result = new Date(date);
  const originalDay = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(originalDay, lastDay));
  return result;
}

function orderTags(order) {
  return Array.isArray(order.tags)
    ? order.tags.map((tag) => String(tag).trim())
    : String(order.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
}

function orderParties(order) {
  const shippingAddress = order.shipping_address || {};
  return {
    shippingAddress,
    customerName: `${shippingAddress.first_name || ''} ${shippingAddress.last_name || ''}`.trim(),
    customerEmail: order.customer?.email || order.email || null,
    customerPhone: order.customer?.phone || shippingAddress.phone || null,
    customerId: order.customer?.id ? String(order.customer.id) : null,
  };
}

function validOrderBasics(order) {
  const orderDate = new Date(order.created_at);
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  if (!order.id || Number.isNaN(orderDate.getTime()) || !lineItems.length) return null;
  return { orderDate, lineItems };
}

async function createOrdinaryShipment(client, order, basics) {
  const parties = orderParties(order);
  const summary = summarizeItems(basics.lineItems);
  const singleItem = summary.items.length === 1 ? summary.items[0] : null;
  const result = await client.query(
    `INSERT INTO shipments
      (shipment_kind, subscription_id, order_id, order_name, customer_id,
       customer_name, customer_email, customer_phone, shipping_address,
       product_name, variant_title, product_sku, product_variant_id,
       product_quantity, line_items, order_total_price, physical_box_count,
       parcel_weight_kg, shipment_number, total_shipments, scheduled_ship_date,
       shipment_status, shopify_delivery_order_id, shopify_delivery_order_name,
       shopify_delivery_created_at, oms_order_id, oms_order_reference,
       warehouse_status, oms_submitted_at, oms_last_synced_at)
     VALUES
      ('ordinary', NULL, $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16,
       1, 1, $17, 'pending', $1, $2, NOW(), $1, $2, 'submitted', NOW(), NOW())
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      String(order.id),
      order.name || null,
      parties.customerId,
      parties.customerName,
      parties.customerEmail,
      parties.customerPhone,
      JSON.stringify(parties.shippingAddress),
      summary.productName,
      singleItem?.variant_title || null,
      summary.productSku,
      singleItem?.variant_id || null,
      summary.productQuantity,
      JSON.stringify(summary.items),
      order.total_price || null,
      summary.physicalBoxCount,
      summary.parcelWeightKg,
      basics.orderDate.toISOString().slice(0, 10),
    ]
  );
  return result.rows[0]?.id || null;
}

async function createSubscription(client, order, basics, recurringItem) {
  const planMonths = getPlanMonths(recurringItem);
  if (!ALLOWED_PLAN_MONTHS.has(planMonths)) return null;

  const parties = orderParties(order);
  const variantTitle = recurringItem.variant_title || recurringItem.title || '';
  const subscriptionEndDate = addMonths(basics.orderDate, planMonths);
  const subResult = await client.query(
    `INSERT INTO subscriptions
      (order_id, order_name, customer_id, customer_email, customer_phone,
       shipping_address, product_name, variant_title, total_price_paid,
       plan_months, payment_date, subscription_start_date, subscription_end_date,
       subscription_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active')
     ON CONFLICT (order_id) DO NOTHING
     RETURNING id`,
    [
      String(order.id),
      order.name || null,
      parties.customerId,
      parties.customerEmail,
      parties.customerPhone,
      JSON.stringify(parties.shippingAddress),
      recurringItem.title || null,
      variantTitle,
      order.total_price || null,
      planMonths,
      basics.orderDate,
      basics.orderDate,
      subscriptionEndDate,
    ]
  );
  if (!subResult.rows[0]) return null;

  const subscriptionId = subResult.rows[0].id;
  for (let index = 0; index < planMonths; index += 1) {
    const isCheckoutShipment = index === 0;
    const shipmentItems = isCheckoutShipment ? basics.lineItems : [recurringItem];
    const summary = summarizeItems(shipmentItems);
    const shipDate = addMonths(basics.orderDate, index);

    await client.query(
      `INSERT INTO shipments
        (shipment_kind, subscription_id, order_id, order_name, customer_id,
         customer_name, customer_email, customer_phone, shipping_address,
         product_name, variant_title, product_sku, product_variant_id,
         product_quantity, line_items, order_total_price, physical_box_count,
         parcel_weight_kg, shipment_number, total_shipments, scheduled_ship_date,
         shipment_status, shopify_delivery_order_id, shopify_delivery_order_name,
         shopify_delivery_created_at, oms_order_id, oms_order_reference,
         warehouse_status, oms_submitted_at, oms_last_synced_at)
       VALUES
        ('subscription',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,
         $15,$16,$17,$18,$19,$20,'pending',$21,$22,$23,$21,$22,$24,$23,$23)`,
      [
        subscriptionId,
        String(order.id),
        order.name || null,
        parties.customerId,
        parties.customerName,
        parties.customerEmail,
        parties.customerPhone,
        JSON.stringify(parties.shippingAddress),
        summary.productName,
        variantTitle,
        summary.productSku,
        recurringItem.variant_id ? String(recurringItem.variant_id) : null,
        summary.productQuantity,
        JSON.stringify(summary.items),
        order.total_price || null,
        summary.physicalBoxCount,
        summary.parcelWeightKg,
        index + 1,
        planMonths,
        shipDate.toISOString().slice(0, 10),
        isCheckoutShipment ? String(order.id) : null,
        isCheckoutShipment ? (order.name || null) : null,
        isCheckoutShipment ? new Date() : null,
        isCheckoutShipment ? 'submitted' : 'not_sent',
      ]
    );
  }
  return { subscriptionId, planMonths };
}

router.post('/orders/create', asyncHandler(async (req, res) => {
  const order = req.body;
  if (orderTags(order).includes('bb_subscription_delivery')) {
    return res.status(200).send('Generated delivery order ignored');
  }

  const basics = validOrderBasics(order);
  if (!basics) return res.status(400).send('Invalid order payload');
  const recurringItem = basics.lineItems.find((item) => getPlanMonths(item));
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    if (!recurringItem) {
      const shipmentId = await createOrdinaryShipment(client, order, basics);
      await client.query('COMMIT');
      if (!shipmentId) return res.status(200).send('Already processed');
      console.log(`Shopify order ${order.id} created ordinary shipment #${shipmentId}`);
      return res.status(200).send('OK');
    }

    const created = await createSubscription(client, order, basics, recurringItem);
    if (!created) {
      await client.query('ROLLBACK');
      return res.status(200).send('Already processed');
    }
    await client.query('COMMIT');
    console.log(
      `Shopify order ${order.id} created subscription #${created.subscriptionId} with ${created.planMonths} shipments`
    );
    return res.status(200).send('OK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

router.post('/orders/cancelled', asyncHandler(async (req, res) => {
  const orderId = req.body?.id ? String(req.body.id) : '';
  if (!/^\d+$/.test(orderId)) return res.status(400).send('Invalid order payload');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE subscriptions
       SET subscription_status = 'cancelled', updated_at = NOW()
       WHERE order_id = $1 AND subscription_status NOT IN ('cancelled', 'completed')`,
      [orderId]
    );
    const result = await client.query(
      `UPDATE shipments
       SET shipment_status = 'cancelled',
           warehouse_status = CASE
             WHEN warehouse_status IN ('not_sent', 'submitted', 'picking', 'failed')
             THEN 'failed'
             ELSE warehouse_status
           END,
           notes = CASE
             WHEN notes IS NULL OR notes = '' THEN 'Cancelled in Shopify'
             ELSE notes || E'\\nCancelled in Shopify'
           END,
           updated_at = NOW()
       WHERE (order_id = $1 OR shopify_delivery_order_id = $1)
         AND shipment_status NOT IN ('shipped', 'delivered', 'cancelled')`,
      [orderId]
    );
    await client.query('COMMIT');
    console.log(`Shopify order ${orderId} cancelled ${result.rowCount} internal shipment(s)`);
    return res.status(200).send('OK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

module.exports = router;
