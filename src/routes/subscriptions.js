const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET /api/subscriptions?status=active&email=customer@gmail.com
router.get('/', async (req, res) => {
  try {
    const { status, email } = req.query;
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/subscriptions/:id/cancel
// Cancels the subscription AND any not-yet-shipped shipments.
router.patch('/:id/cancel', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE subscriptions SET subscription_status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    await client.query(
      `UPDATE shipments SET shipment_status = 'cancelled', updated_at = NOW()
       WHERE subscription_id = $1 AND shipment_status = 'pending'`,
      [req.params.id]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
