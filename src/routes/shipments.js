const express = require('express');
const router = express.Router();
const axios = require('axios');
const pool = require('../db');
const { sendSMS } = require('../utils/sms');
const asyncHandler = require('../middleware/asyncHandler');
const httpError = require('../utils/httpError');

const SHIPMENT_STATUSES = new Set(['pending', 'ready_to_ship', 'shipped', 'delivered', 'failed', 'cancelled']);

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function shipmentCsvRow(shipment) {
  const address = shipment.shipping_address || {};
  return [
    shipment.order_id,
    `BB-${shipment.order_id}-${shipment.shipment_number}`,
    shipment.customer_name,
    shipment.customer_phone,
    shipment.customer_email,
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.zip,
    address.country || 'PH',
    shipment.product_name,
    1,
    200,
    '',
    shipment.scheduled_ship_date,
    shipment.id,
  ].map(csvCell).join(',');
}

function shipmentsToCsv(shipments) {
  const header = [
    'order_reference',
    'spx_reference',
    'customer_name',
    'customer_phone',
    'customer_email',
    'address1',
    'address2',
    'city',
    'province',
    'postal_code',
    'country',
    'product_description',
    'quantity',
    'weight_grams',
    'cod_amount',
    'scheduled_ship_date',
    'internal_shipment_id',
  ].map(csvCell).join(',');
  return `${header}\r\n${shipments.map(shipmentCsvRow).join('\r\n')}\r\n`;
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

// GET /api/shipments/spx-csv
// Generates a bulk-import file for shipments currently due for fulfillment.
// Column names must be matched against SPX's current template before upload.
router.get('/spx-csv', asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT * FROM shipments
       WHERE scheduled_ship_date <= CURRENT_DATE
       AND shipment_status = 'pending'
       ORDER BY scheduled_ship_date ASC, id ASC`
    );

    if (result.rows.length === 0) {
      throw httpError(404, 'No pending shipments are due for export');
    }

    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="spx-shipments-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    res.send(`\uFEFF${shipmentsToCsv(result.rows)}`);
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

// GET /api/shipments/:id/spx-csv
// Downloads one pending shipment in the same import format as the bulk export.
router.get('/:id/spx-csv', asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT * FROM shipments WHERE id = $1 AND shipment_status = 'pending'`,
      [req.params.id]
    );
    const shipment = result.rows[0];
    if (!shipment) throw httpError(404, 'Pending shipment not found');

    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="spx-shipment-${shipment.id}.csv"`,
    });
    res.send(`\uFEFF${shipmentsToCsv([shipment])}`);
}));

// POST /api/shipments/:id/create-spx
// NOTE: This assumes SPX has an API. If they don't (many PH couriers only
// offer manual CSV upload / dashboard entry), replace this with logic that
// generates a CSV row per shipment for "Import to Mass Edit" instead —
// see the SPX screenshot you shared, it has that exact button.
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
      values.push(tracking_number);
      fields.push(`spx_tracking_number = $${values.length}`);
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
