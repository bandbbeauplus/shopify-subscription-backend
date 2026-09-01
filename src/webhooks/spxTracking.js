const express = require('express');
const pool = require('../db');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

function cleanText(value, maximum = 250) {
  return String(value || '').trim().slice(0, maximum);
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mappedShipmentStatus(status, statusCode) {
  const value = `${status || ''} ${statusCode || ''}`.toLowerCase();
  if (/deliver(ed|y complete)/.test(value)) return 'delivered';
  if (/cancel/.test(value)) return 'cancelled';
  if (/pickup fail|delivery fail|lost|damag|dispose|return(ed| complete)/.test(value)) return 'failed';
  if (/in transit|picked up|pickup success|departed|arrived|sorting|out for delivery|^.*\b[23][0-9]{3}\b/.test(value)) return 'shipped';
  if (/pending pickup|created|^.*\b1001\b/.test(value)) return 'ready_to_ship';
  return null;
}

function nextShipmentStatus(current, incoming) {
  if (!incoming) return current;
  const rank = { pending: 0, ready_to_ship: 1, failed: 1, cancelled: 2, shipped: 3, delivered: 4 };
  if (current === 'delivered') return current;
  if (current === 'shipped' && !new Set(['delivered']).has(incoming)) return current;
  return (rank[incoming] ?? -1) >= (rank[current] ?? -1) ? incoming : current;
}

function validPayload(body) {
  const eventId = cleanText(body?.id, 100);
  const trackingNo = cleanText(body?.tracking_no, 50);
  const orderId = cleanText(body?.order_id, 50);
  const timestamp = Number(body?.timestamp);
  if (!eventId || (!trackingNo && !orderId) || !Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  return { eventId, trackingNo, orderId, timestamp };
}

router.post('/tracking', asyncHandler(async (req, res) => {
  const valid = validPayload(req.body);
  if (!valid) return res.status(400).send('Invalid payload');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO spx_tracking_events
        (event_id, tracking_no, order_id, status_code, status, event_timestamp)
       VALUES ($1,$2,$3,$4,$5,TO_TIMESTAMP($6))
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [
        valid.eventId,
        valid.trackingNo || null,
        valid.orderId || null,
        cleanText(req.body.status_code, 30) || null,
        cleanText(req.body.status, 100) || null,
        valid.timestamp,
      ]
    );
    if (!inserted.rows[0]) {
      await client.query('COMMIT');
      return res.status(200).send('OK');
    }

    const shipmentResult = await client.query(
      `SELECT * FROM shipments
       WHERE ($1 <> '' AND spx_tracking_number = $1)
          OR ($2 <> '' AND (spx_order_id = $2 OR ('BB-' || id::text) = $2))
       ORDER BY CASE WHEN spx_tracking_number = $1 THEN 0 ELSE 1 END, id ASC
       LIMIT 1
       FOR UPDATE`,
      [valid.trackingNo, valid.orderId]
    );
    const shipment = shipmentResult.rows[0];
    if (shipment) {
      const incoming = mappedShipmentStatus(req.body.status, req.body.status_code);
      const shipmentStatus = nextShipmentStatus(shipment.shipment_status, incoming);
      await client.query(
        `UPDATE shipments
         SET spx_tracking_number = COALESCE(NULLIF($1, ''), spx_tracking_number),
             spx_tracking_status = $2,
             spx_tracking_status_code = $3,
             spx_tracking_message = $4,
             spx_tracking_link = $5,
             spx_tracking_updated_at = TO_TIMESTAMP($6),
             spx_actual_shipping_fee = $7,
             spx_latest_actual_weight = $8,
             shipment_status = $9,
             actual_ship_date = CASE
               WHEN $9 IN ('shipped','delivered') THEN COALESCE(actual_ship_date, CURRENT_DATE)
               ELSE actual_ship_date
             END,
             updated_at = NOW()
         WHERE id = $10`,
        [
          valid.trackingNo,
          cleanText(req.body.status, 100) || null,
          cleanText(req.body.status_code, 30) || null,
          cleanText(req.body.message, 500) || null,
          cleanText(req.body.tracking_link, 500) || null,
          valid.timestamp,
          optionalNumber(req.body.actual_shipping_fee),
          optionalNumber(req.body.latest_actual_weight),
          shipmentStatus,
          shipment.id,
        ]
      );
      await client.query(
        `UPDATE spx_tracking_events SET shipment_id = $1 WHERE event_id = $2`,
        [shipment.id, valid.eventId]
      );
    }

    await client.query('COMMIT');
    if (!shipment) console.warn(`SPX tracking event ${valid.eventId} did not match an internal shipment`);
    return res.status(200).send('OK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

module.exports = { mappedShipmentStatus, nextShipmentStatus, optionalNumber, router, validPayload };
