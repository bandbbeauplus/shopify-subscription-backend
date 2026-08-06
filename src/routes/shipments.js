const express = require('express');
const router = express.Router();
const axios = require('axios');
const pool = require('../db');
const { sendSMS } = require('../utils/sms');

// GET /api/shipments?status=pending&from=2026-08-01&to=2026-08-31
router.get('/', async (req, res) => {
  try {
    const { status, from, to, customer_email } = req.query;
    const conditions = [];
    const values = [];

    if (status) {
      values.push(status);
      conditions.push(`shipment_status = $${values.length}`);
    }
    if (from) {
      values.push(from);
      conditions.push(`scheduled_ship_date >= $${values.length}`);
    }
    if (to) {
      values.push(to);
      conditions.push(`scheduled_ship_date <= $${values.length}`);
    }
    if (customer_email) {
      values.push(`%${customer_email}%`);
      conditions.push(`customer_email ILIKE $${values.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM shipments ${whereClause} ORDER BY scheduled_ship_date ASC`,
      values
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shipments/due-today  (the main dashboard view)
router.get('/due-today', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM shipments
       WHERE scheduled_ship_date <= CURRENT_DATE
       AND shipment_status = 'pending'
       ORDER BY scheduled_ship_date ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shipments/subscriptions/:id  (all shipments for one subscription)
router.get('/subscriptions/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM shipments WHERE subscription_id = $1 ORDER BY shipment_number ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shipments/:id/create-spx
// NOTE: This assumes SPX has an API. If they don't (many PH couriers only
// offer manual CSV upload / dashboard entry), replace this with logic that
// generates a CSV row per shipment for "Import to Mass Edit" instead —
// see the SPX screenshot you shared, it has that exact button.
router.post('/:id/create-spx', async (req, res) => {
  try {
    const { id } = req.params;
    const shipResult = await pool.query('SELECT * FROM shipments WHERE id = $1', [id]);
    const shipment = shipResult.rows[0];

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    const address = shipment.shipping_address;

    // --- Placeholder SPX API call. Confirm actual endpoint/fields with SPX. ---
    const spxResponse = await axios.post(
      `${process.env.SPX_API_BASE_URL}/shipments`,
      {
        sender: {
          name: 'b&b BEAU+',
          phone: process.env.WAREHOUSE_PHONE || '',
          address: process.env.WAREHOUSE_ADDRESS || ''
        },
        receiver: {
          name: shipment.customer_name,
          phone: shipment.customer_phone,
          address: `${address.address1 || ''}, ${address.city || ''}, ${address.province || ''}`
        },
        parcel: {
          weight_grams: 200,
          description: shipment.product_name
        }
      },
      { headers: { Authorization: `Bearer ${process.env.SPX_API_KEY}` } }
    );

    const trackingNumber = spxResponse.data.tracking_number;

    await pool.query(
      `UPDATE shipments
       SET spx_tracking_number = $1, spx_entry_created = true,
           spx_entry_date = NOW(), shipment_status = 'shipped',
           actual_ship_date = CURRENT_DATE, updated_at = NOW()
       WHERE id = $2`,
      [trackingNumber, id]
    );

    if (shipment.customer_phone) {
      await sendSMS(
        shipment.customer_phone,
        `Hi! Your b&b BEAU+ shipment ${shipment.shipment_number}/${shipment.total_shipments} is on the way. Track: ${trackingNumber}`
      );
    }

    res.json({ success: true, tracking_number: trackingNumber });
  } catch (err) {
    console.error('SPX creation failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'SPX entry failed', details: err.message });
  }
});

// PATCH /api/shipments/:id  (manual status override, e.g. mark delivered/failed)
router.patch('/:id', async (req, res) => {
  try {
    const { status, notes, tracking_number } = req.body;
    const fields = [];
    const values = [];

    if (status) {
      values.push(status);
      fields.push(`shipment_status = $${values.length}`);
    }
    if (notes !== undefined) {
      values.push(notes);
      fields.push(`notes = $${values.length}`);
    }
    if (tracking_number) {
      values.push(tracking_number);
      fields.push(`spx_tracking_number = $${values.length}`);
    }

    if (!fields.length) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    fields.push(`updated_at = NOW()`);
    values.push(req.params.id);

    await pool.query(
      `UPDATE shipments SET ${fields.join(', ')} WHERE id = $${values.length}`,
      values
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
