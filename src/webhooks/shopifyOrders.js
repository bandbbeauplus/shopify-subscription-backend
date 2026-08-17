const express = require('express');
const pool = require('../db');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
const ALLOWED_PLAN_MONTHS = new Set([1, 3, 6, 12]);

function getPlanMonths(lineItem) {
  const title = lineItem.variant_title || lineItem.title || '';
  const match = title.match(/(?:^|\D)(1|3|6|12)(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

function addMonths(date, months) {
  const result = new Date(date);
  const originalDay = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(originalDay, lastDay));
  return result;
}

router.post('/orders/create', asyncHandler(async (req, res) => {
  const client = await pool.connect();

  try {
    const order = req.body;
    const tags = Array.isArray(order.tags)
      ? order.tags
      : String(order.tags || '').split(',').map((tag) => tag.trim());

    // Orders generated for later prepaid deliveries contain the same plan
    // variant as the checkout order. Never turn those child orders into a new
    // subscription and another set of scheduled shipments.
    if (tags.includes('bb_subscription_delivery')) {
      return res.status(200).send('Generated delivery order ignored');
    }

    const lineItem = order.line_items?.find((item) => getPlanMonths(item));

    if (!lineItem) {
      console.warn(`Order ${order.id} has no recognized subscription line item - skipping`);
      return res.status(200).send('Ignored');
    }

    const variantTitle = lineItem.variant_title || lineItem.title || '';
    const planMonths = getPlanMonths(lineItem);
    const orderDate = new Date(order.created_at);

    if (!ALLOWED_PLAN_MONTHS.has(planMonths) || !order.id || Number.isNaN(orderDate.getTime())) {
      return res.status(400).send('Invalid order payload');
    }

    const subscriptionEndDate = addMonths(orderDate, planMonths);
    const shippingAddr = order.shipping_address || {};
    const customerName = `${shippingAddr.first_name || ''} ${shippingAddr.last_name || ''}`.trim();
    const customerEmail = order.customer?.email || order.email || null;
    const customerPhone = order.customer?.phone || shippingAddr.phone || null;
    const customerId = order.customer?.id || null;

    await client.query('BEGIN');

    const subResult = await client.query(
      `INSERT INTO subscriptions
        (order_id, order_name, customer_id, customer_email, customer_phone,
         shipping_address, product_name, variant_title, total_price_paid,
         plan_months, payment_date, subscription_start_date, subscription_end_date,
         subscription_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING id`,
      [
        order.id,
        order.name || null,
        customerId,
        customerEmail,
        customerPhone,
        JSON.stringify(shippingAddr),
        lineItem.title || null,
        variantTitle,
        order.total_price || null,
        planMonths,
        orderDate,
        orderDate,
        subscriptionEndDate,
        'active',
      ]
    );

    if (subResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(200).send('Already processed');
    }

    const subscriptionId = subResult.rows[0].id;
    for (let i = 0; i < planMonths; i += 1) {
      const shipDate = addMonths(orderDate, i);
      await client.query(
        `INSERT INTO shipments
          (subscription_id, order_id, customer_id, customer_name, customer_email,
           customer_phone, shipping_address, product_name, product_sku, product_variant_id,
           product_quantity, shipment_number, total_shipments, scheduled_ship_date, shipment_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          subscriptionId,
          order.id,
          customerId,
          customerName,
          customerEmail,
          customerPhone,
          JSON.stringify(shippingAddr),
          lineItem.title || null,
          lineItem.sku || null,
          lineItem.variant_id || null,
          lineItem.quantity || 1,
          i + 1,
          planMonths,
          shipDate.toISOString().split('T')[0],
          'pending',
        ]
      );
    }

    await client.query('COMMIT');
    console.log(`Order ${order.name || order.id} created subscription #${subscriptionId} with ${planMonths} shipments`);
    return res.status(200).send('OK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

module.exports = router;
