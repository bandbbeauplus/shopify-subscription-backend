const express = require('express');
const pool = require('../db');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
const EVIDENCE_FIELDS = Object.freeze({
  epod_list: 'spx_epod_urls',
  epop_list: 'spx_epop_urls',
  epor_list: 'spx_epor_urls',
  epooh_list: 'spx_epooh_urls',
});

function cleanText(value, maximum = 250) {
  return String(value || '').trim().slice(0, maximum);
}

function normalizeEvidenceUrls(value) {
  if (!Array.isArray(value)) return null;
  const unique = [];
  for (const candidate of value.slice(0, 25)) {
    try {
      const url = new URL(String(candidate || '').trim());
      if (url.protocol !== 'https:' || url.toString().length > 2000) continue;
      if (!unique.includes(url.toString())) unique.push(url.toString());
    } catch {
      // Ignore malformed proof URLs while preserving the rest of the event.
    }
  }
  if (value.length > 0 && unique.length === 0) return null;
  return unique;
}

function validEvidencePayload(body) {
  const eventId = cleanText(body?.id, 100);
  const trackingNo = cleanText(body?.tracking_no, 50);
  const customerOrderId = cleanText(body?.customer_order_id, 50);
  const evidence = Object.fromEntries(
    Object.keys(EVIDENCE_FIELDS).map((field) => [field, normalizeEvidenceUrls(body?.[field])])
  );
  const hasEvidenceField = Object.values(evidence).some((value) => value !== null);
  if (!eventId || (!trackingNo && !customerOrderId) || !hasEvidenceField) return null;
  return { eventId, trackingNo, customerOrderId, evidence };
}

router.post('/evidence', asyncHandler(async (req, res) => {
  const valid = validEvidencePayload(req.body);
  if (!valid) return res.status(400).send('Invalid payload');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO spx_evidence_events
        (event_id, tracking_no, customer_order_id, tracking_code_name, status, status_code_name)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [
        valid.eventId,
        valid.trackingNo || null,
        valid.customerOrderId || null,
        cleanText(req.body.tracking_code_name, 100) || null,
        cleanText(req.body.status, 100) || null,
        cleanText(req.body.status_code_name, 100) || null,
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
      [valid.trackingNo, valid.customerOrderId]
    );
    const shipment = shipmentResult.rows[0];
    if (shipment) {
      const values = Object.keys(EVIDENCE_FIELDS).map((field) => valid.evidence[field]);
      await client.query(
        `UPDATE shipments
         SET spx_tracking_number = COALESCE(NULLIF($1, ''), spx_tracking_number),
             spx_epod_urls = CASE WHEN $2::boolean THEN $3::jsonb ELSE spx_epod_urls END,
             spx_epop_urls = CASE WHEN $4::boolean THEN $5::jsonb ELSE spx_epop_urls END,
             spx_epor_urls = CASE WHEN $6::boolean THEN $7::jsonb ELSE spx_epor_urls END,
             spx_epooh_urls = CASE WHEN $8::boolean THEN $9::jsonb ELSE spx_epooh_urls END,
             spx_evidence_status = $10,
             spx_evidence_status_code_name = $11,
             spx_evidence_updated_at = NOW(),
             updated_at = NOW()
         WHERE id = $12`,
        [
          valid.trackingNo,
          values[0] !== null, JSON.stringify(values[0] || []),
          values[1] !== null, JSON.stringify(values[1] || []),
          values[2] !== null, JSON.stringify(values[2] || []),
          values[3] !== null, JSON.stringify(values[3] || []),
          cleanText(req.body.status || req.body.tracking_code_name, 100) || null,
          cleanText(req.body.status_code_name, 100) || null,
          shipment.id,
        ]
      );
      await client.query(
        `UPDATE spx_evidence_events SET shipment_id = $1 WHERE event_id = $2`,
        [shipment.id, valid.eventId]
      );
    }

    await client.query('COMMIT');
    if (!shipment) console.warn(`SPX evidence event ${valid.eventId} did not match an internal shipment`);
    return res.status(200).send('OK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

module.exports = { EVIDENCE_FIELDS, normalizeEvidenceUrls, router, validEvidencePayload };
