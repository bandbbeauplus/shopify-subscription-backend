const express = require('express');
const router = express.Router();
const pool = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const httpError = require('../utils/httpError');

const SUBSCRIPTION_STATUSES = new Set(['active', 'paused', 'cancelled', 'completed']);

// GET /api/subscriptions?status=active&email=customer@gmail.com
router.get('/', asyncHandler(async (req, res) => {
    const { status, email } = req.query;
    if (status && !SUBSCRIPTION_STATUSES.has(status)) throw httpError(400, 'Invalid subscription status');
    const conditions = [];
    const values = [];

    if (status) {
      values.push(status);
      conditions.push(`subscription_status = $${values.length}`);
    }
    if (email) {
      values.push(`%${email}%`);
      conditions.push(`customer_email ILIKE $${values.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM subscriptions ${whereClause} ORDER BY created_at DESC`,
      values
    );
    res.json(result.rows);
}));

// PATCH /api/subscriptions/:id/cancel
// Cancels the subscription AND any not-yet-shipped shipments.
router.patch('/:id/cancel', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE subscriptions SET subscription_status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    if (result.rowCount === 0) throw httpError(404, 'Subscription not found');

    await client.query(
      `UPDATE shipments SET shipment_status = 'cancelled', updated_at = NOW()
       WHERE subscription_id = $1 AND shipment_status = 'pending'`,
      [req.params.id]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
