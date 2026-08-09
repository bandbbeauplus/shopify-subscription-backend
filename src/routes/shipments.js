const express = require('express');
const router = express.Router();
const axios = require('axios');
const pool = require('../db');
const { sendSMS } = require('../utils/sms');
const { buildSpxWorkbook } = require('../utils/spxWorkbook');
const asyncHandler = require('../middleware/asyncHandler');
const httpError = require('../utils/httpError');

const SHIPMENT_STATUSES = new Set(['pending', 'ready_to_ship', 'shipped', 'delivered', 'failed', 'cancelled']);

function normalizeTrackingNumber(value) {
  const trackingNumber = String(value || '').trim();
  if (!/^[A-Za-z0-9-]{4,50}$/.test(trackingNumber)) {
    throw httpError(400, 'SPX tracking number must be 4-50 letters, numbers, or hyphens');
  }
  return trackingNumber;
}

function requireValidDate(value, field) {
  if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw httpError(400, `${field} must use YYYY-MM-DD format`);
  }
}

// GET /api/shipments?status=pending&from=2026-08-01&to=2026-08-31
router.get('/', asyncHandler(async (req, res) => {
    const { status, from, to, customer_email } = req.query;
    if (status && !SHIPMENT_STATUSES.has(status)) throw httpError(400, 'Invalid shipment status');
    requireValidDate(from, 'from');
    requireValidDate(to, 'to');
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
}));

// GET /api/shipments/spx-xlsx
// Populates SPX's official mass-order workbook with shipments due today.
router.get('/spx-xlsx', asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT sh.*, s.total_price_paid, s.plan_months
       FROM shipments sh
       JOIN subscriptions s ON s.id = sh.subscription_id
       WHERE sh.scheduled_ship_date <= CURRENT_DATE
       AND sh.shipment_status = 'pending'
       ORDER BY sh.scheduled_ship_date ASC, sh.id ASC`
    );

    const workbook = await buildSpxWorkbook(result.rows);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="spx-shipments-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    });
    res.send(workbook);
}));

// GET /api/shipments/due-today  (the main dashboard view)
router.get('/due-today', asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT * FROM shipments
       WHERE scheduled_ship_date <= CURRENT_DATE
       AND shipment_status = 'pending'
       ORDER BY scheduled_ship_date ASC`
    );
    res.json(result.rows);
}));

// GET /api/shipments/subscriptions/:id  (all shipments for one subscription)
router.get('/subscriptions/:id', asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT * FROM shipments WHERE subscription_id = $1 ORDER BY shipment_number ASC`,
      [req.params.id]
    );
    res.json(result.rows);
}));

// GET /api/shipments/:id/spx-xlsx
// Populates SPX's official workbook with one pending shipment.
router.get('/:id/spx-xlsx', asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT sh.*, s.total_price_paid, s.plan_months
       FROM shipments sh
       JOIN subscriptions s ON s.id = sh.subscription_id
       WHERE sh.id = $1 AND sh.shipment_status = 'pending'`,
      [req.params.id]
    );
    const shipment = result.rows[0];
    if (!shipment) throw httpError(404, 'Pending shipment not found');

    const workbook = await buildSpxWorkbook([shipment]);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="spx-shipment-${shipment.id}.xlsx"`,
    });
    res.send(workbook);
}));

// POST /api/shipments/:id/confirm-spx
// Records the tracking number returned by SPX after a manual Excel import.
// Creating a label means ready_to_ship; the caller can explicitly mark it
// shipped after handoff or after creating the matching Shopify fulfillment.
router.post('/:id/confirm-spx', asyncHandler(async (req, res) => {
    const trackingNumber = normalizeTrackingNumber(req.body.tracking_number);
    const requestedStatus = req.body.status || 'ready_to_ship';
    if (!new Set(['ready_to_ship', 'shipped']).has(requestedStatus)) {
      throw httpError(400, 'Confirmed SPX shipments must be ready_to_ship or shipped');
    }

    const existingResult = await pool.query('SELECT * FROM shipments WHERE id = $1', [req.params.id]);
    const existing = existingResult.rows[0];
    if (!existing) throw httpError(404, 'Shipment not found');
    if (existing.spx_tracking_number && existing.spx_tracking_number !== trackingNumber) {
      throw httpError(409, 'This shipment already has a different SPX tracking number');
    }

    const result = await pool.query(
      `UPDATE shipments
       SET spx_tracking_number = $1,
           spx_entry_created = true,
           spx_entry_date = COALESCE(spx_entry_date, NOW()),
           shipment_status = $2,
           actual_ship_date = CASE WHEN $2 = 'shipped' THEN COALESCE(actual_ship_date, CURRENT_DATE) ELSE actual_ship_date END,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [trackingNumber, requestedStatus, req.params.id]
    );

    if (!existing.spx_tracking_number && existing.customer_phone) {
      await sendSMS(
        existing.customer_phone,
        `Hi! SPX tracking for b&b BEAU+ shipment ${existing.shipment_number}/${existing.total_shipments}: ${trackingNumber}. Track at https://spx.ph/track`
      );
    }

    res.json({ success: true, shipment: result.rows[0] });
}));

// POST /api/shipments/:id/create-spx
// NOTE: This assumes SPX has an API. The dashboard currently uses the
// official Excel-template export above for manual "Import to Mass Edit".
router.post('/:id/create-spx', asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!process.env.SPX_API_BASE_URL || !process.env.SPX_API_KEY) {
      throw httpError(503, 'SPX integration is not configured');
    }
    const shipResult = await pool.query('SELECT * FROM shipments WHERE id = $1', [id]);
    const shipment = shipResult.rows[0];

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }
    if (shipment.spx_entry_created && shipment.spx_tracking_number) {
      return res.json({ success: true, tracking_number: shipment.spx_tracking_number, already_exists: true });
    }

    const address = shipment.shipping_address || {};

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

    const trackingNumber = spxResponse.data?.tracking_number;
    if (!trackingNumber) {
      throw httpError(502, 'SPX did not return a tracking number');
    }

    const updateResult = await pool.query(
      `UPDATE shipments
       SET spx_tracking_number = $1, spx_entry_created = true,
           spx_entry_date = NOW(), shipment_status = 'shipped',
           actual_ship_date = CURRENT_DATE, updated_at = NOW()
       WHERE id = $2`,
      [trackingNumber, id]
    );
    if (updateResult.rowCount === 0) throw httpError(404, 'Shipment not found');

    if (shipment.customer_phone) {
      await sendSMS(
        shipment.customer_phone,
        `Hi! Your b&b BEAU+ shipment ${shipment.shipment_number}/${shipment.total_shipments} is on the way. Track: ${trackingNumber}`
      );
    }

    res.json({ success: true, tracking_number: trackingNumber });
}));

// PATCH /api/shipments/:id  (manual status override, e.g. mark delivered/failed)
router.patch('/:id', asyncHandler(async (req, res) => {
    const { status, notes, tracking_number } = req.body;
    const fields = [];
    const values = [];

    if (status && !SHIPMENT_STATUSES.has(status)) {
      throw httpError(400, 'Invalid shipment status');
    }
    if (status) {
      values.push(status);
      fields.push(`shipment_status = $${values.length}`);
    }
    if (notes !== undefined) {
      values.push(notes);
      fields.push(`notes = $${values.length}`);
    }
    if (tracking_number) {
      values.push(normalizeTrackingNumber(tracking_number));
      fields.push(`spx_tracking_number = $${values.length}`);
      fields.push('spx_entry_created = true');
      fields.push('spx_entry_date = COALESCE(spx_entry_date, NOW())');
    }

    if (status === 'shipped' || status === 'delivered') {
      fields.push('actual_ship_date = COALESCE(actual_ship_date, CURRENT_DATE)');
    }

    if (!fields.length) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    fields.push(`updated_at = NOW()`);
    values.push(req.params.id);

    const result = await pool.query(
      `UPDATE shipments SET ${fields.join(', ')} WHERE id = $${values.length}`,
      values
    );

    if (result.rowCount === 0) throw httpError(404, 'Shipment not found');

    res.json({ success: true });
}));

module.exports = router;
