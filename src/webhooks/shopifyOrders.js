const express = require('express');
const router = express.Router();
const pool = require('../db');

router.post('/orders/create', async (req, res) => {
  // Always ack fast so Shopify doesn't retry/duplicate the webhook.
  // We do the real work after responding.
  res.status(200).send('OK');

  const client = await pool.connect();

  try {
    const order = req.body;

    // ---- 1. Find your subscription line item ----
    // Assumes the subscription product is the relevant line item.
    // If customers can buy other non-subscription products too,
    // you'll want to loop line_items and only process ones matching
    // your subscription product ID(s).
    const lineItem = order.line_items?.[0];
    if (!lineItem) {
      console.warn(`Order ${order.id} has no line items — skipping`);
      return;
    }

    const variantTitle = lineItem.variant_title || lineItem.title || '';
    const monthsMatch = variantTitle.match(/(\d+)/);

    if (!monthsMatch) {
      console.warn(`Could not parse plan length from variant title: "${variantTitle}" — skipping order ${order.id}`);
      return;
    }

    const planMonths = parseInt(monthsMatch[1], 10);
    const orderDate = new Date(order.created_at);
    const endDate = new Date(orderDate);
    endDate.setMonth(endDate.getMonth() + planMonths);

    const shippingAddr = order.shipping_address || {};
    const customerName = `${shippingAddr.first_name || ''} ${shippingAddr.last_name || ''}`.trim();

    await client.query('BEGIN');

    // ---- 2. Insert subscription record ----
    // ON CONFLICT guards against Shopify sending the same webhook twice
    // (it happens - Shopify's "at least once" delivery guarantee)
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
        order.name,
        order.customer?.id || null,
        order.customer?.email || order.email,
        order.customer?.phone || shippingAddr.phone || null,
        JSON.stringify(shippingAddr),
        lineItem.title,
        variantTitle,
        order.total_price,
        planMonths,
        orderDate,
        orderDate,
        endDate,
        'active'
      ]
    );

    if (subResult.rows.length === 0) {
      console.log(`Order ${order.id} already processed — skipping duplicate webhook`);
      await client.query('ROLLBACK');
      return;
    }

    const subscriptionId = subResult.rows[0].id;

    // ---- 3. Generate one shipment row per month ----
    for (let i = 0; i < planMonths; i++) {
      const shipDate = new Date(orderDate);
      shipDate.setDate(shipDate.getDate() + 30 * i);

      await client.query(
        `INSERT INTO shipments
          (subscription_id, order_id, customer_id, customer_name, customer_email,
           customer_phone, shipping_address, product_name, shipment_number,
           total_shipments, scheduled_ship_date, shipment_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          subscriptionId,
          order.id,
          order.customer?.id || null,
          customerName,
          order.customer?.email || order.email,
          order.customer?.phone || shippingAddr.phone || null,
          JSON.stringify(shippingAddr),
          lineItem.title,
          i + 1,
          planMonths,
          shipDate.toISOString().split('T')[0], // DATE only, no time
          'pending'
        ]
      );
    }

    await client.query('COMMIT');
    console.log(`✅ Order ${order.name} (${order.id}): created subscription #${subscriptionId} with ${planMonths} shipments`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error processing order webhook:', err);
  } finally {
    client.release();
  }
});

module.exports = router;
