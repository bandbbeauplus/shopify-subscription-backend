const express = require('express');
const router = express.Router();
const pool = require('../db');
const { sendSMS } = require('../utils/sms');
const { buildSpxWorkbook } = require('../utils/spxWorkbook');
const asyncHandler = require('../middleware/asyncHandler');
const httpError = require('../utils/httpError');
const {
  OMS_MODE,
  createFulfillmentOrder,
  getFulfillmentStatus,
  sendAwb,
} = require('../services/omsClient');
const {
  SPX_ENVIRONMENT,
  SPX_MODE,
  createOrder: createSpxOrder,
  getAwb: getSpxAwb,
  getOrderCreateResult: getSpxOrderCreateResult,
  isSpxConfigured,
  spxOrderId,
} = require('../services/spxClient');
const {
  GOOGLE_AWB_MODE,
  isGoogleAwbConfigured,
  syncAwbToGoogle,
} = require('../services/googleAwbClient');

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

function normalizeAwbUrl(value) {
  const url = String(value || '').trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Not HTTPS');
  } catch {
    throw httpError(400, 'AWB PDF URL must be a valid HTTPS URL');
  }
  return url;
}

async function shipmentById(id) {
  const result = await pool.query(
    `SELECT sh.*, s.total_price_paid, s.plan_months,
            sh.scheduled_ship_date <= CURRENT_DATE AS is_due
     FROM shipments sh
     JOIN subscriptions s ON s.id = sh.subscription_id
     WHERE sh.id = $1`,
    [id]
  );
  const shipment = result.rows[0];
  if (!shipment) throw httpError(404, 'Shipment not found');
  return shipment;
}

async function syncShipmentAwbToGoogle(shipment) {
  if (!isGoogleAwbConfigured()) {
    return { success: false, skipped: true, shipment };
  }
  if (shipment.google_awb_sync_status === 'synced' && shipment.google_awb_url) {
    return { success: true, already_exists: true, shipment };
  }

  const claimed = await pool.query(
    `UPDATE shipments
     SET google_awb_sync_status = 'syncing',
         google_awb_error = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND (
         COALESCE(google_awb_sync_status, 'not_synced') <> 'syncing'
         OR updated_at < NOW() - INTERVAL '5 minutes'
       )
     RETURNING *`,
    [shipment.id]
  );
  if (!claimed.rows[0]) {
    return { success: true, already_processing: true, shipment: await shipmentById(shipment.id) };
  }

  try {
    const googleResult = await syncAwbToGoogle(claimed.rows[0]);
    const saved = await pool.query(
      `UPDATE shipments
       SET google_drive_file_id = $1,
           google_awb_url = $2,
           google_sheet_row_number = $3,
           google_awb_sync_status = 'synced',
           google_awb_synced_at = NOW(),
           google_awb_error = NULL,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [
        googleResult.driveFileId,
        googleResult.driveUrl,
        googleResult.sheetRow,
        shipment.id,
      ]
    );
    return { success: true, shipment: saved.rows[0] };
  } catch (error) {
    const failed = await pool.query(
      `UPDATE shipments
       SET google_awb_sync_status = 'failed',
           google_awb_error = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [String(error.message || 'Google AWB sync failed').slice(0, 500), shipment.id]
    );
    return { success: false, shipment: failed.rows[0] };
  }
}

router.get('/integration-config', (req, res) => {
  res.json({
    oms_mode: OMS_MODE,
    spx_mode: SPX_MODE,
    spx_environment: SPX_ENVIRONMENT,
    spx_configured: isSpxConfigured(),
    google_awb_mode: GOOGLE_AWB_MODE,
    google_awb_configured: isGoogleAwbConfigured(),
  });
});

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
       AND sh.warehouse_status = 'packed'
       AND sh.spx_tracking_number IS NULL
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
       WHERE sh.id = $1
       AND sh.shipment_status = 'pending'
       AND sh.warehouse_status = 'packed'
       AND sh.spx_tracking_number IS NULL`,
      [req.params.id]
    );
    const shipment = result.rows[0];
    if (!shipment) throw httpError(404, 'A packed shipment without an SPX booking was not found');

    const workbook = await buildSpxWorkbook([shipment]);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="spx-shipment-${shipment.id}.xlsx"`,
    });
    res.send(workbook);
}));

// GET /api/shipments/:id
// Keep this after named GET routes so values such as "spx-xlsx" are not
// interpreted as shipment IDs.
router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await shipmentById(req.params.id));
}));

// POST /api/shipments/:id/release-to-oms
// Uses a deterministic external reference so a future OMS implementation can
// safely enforce idempotency when requests are retried.
router.post('/:id/release-to-oms', asyncHandler(async (req, res) => {
    const shipment = await shipmentById(req.params.id);
    if (!shipment.is_due) throw httpError(409, 'This shipment is not due yet');
    if (shipment.shipment_status !== 'pending') {
      throw httpError(409, `A ${shipment.shipment_status} shipment cannot be released to OMS`);
    }
    if (shipment.oms_order_id) {
      return res.json({ success: true, shipment, already_exists: true });
    }
    if (!new Set(['not_sent', 'failed']).has(shipment.warehouse_status)) {
      throw httpError(409, 'This shipment has already entered the warehouse workflow');
    }

    try {
      const omsOrder = await createFulfillmentOrder(shipment);
      const result = await pool.query(
        `UPDATE shipments
         SET oms_order_id = $1,
             oms_order_reference = $2,
             warehouse_status = $3,
             oms_submitted_at = COALESCE(oms_submitted_at, NOW()),
             oms_last_synced_at = NOW(),
             warehouse_error = NULL,
             updated_at = NOW()
         WHERE id = $4 AND oms_order_id IS NULL
         RETURNING *`,
        [omsOrder.orderId, omsOrder.reference, omsOrder.status, shipment.id]
      );
      if (!result.rows[0]) {
        return res.json({ success: true, shipment: await shipmentById(shipment.id), already_exists: true });
      }
      return res.json({ success: true, shipment: result.rows[0] });
    } catch (error) {
      await pool.query(
        `UPDATE shipments
         SET warehouse_status = 'failed', warehouse_error = $1, updated_at = NOW()
         WHERE id = $2 AND oms_order_id IS NULL`,
        [String(error.message || 'OMS request failed').slice(0, 500), shipment.id]
      );
      throw error;
    }
}));

// POST /api/shipments/:id/link-shopify-delivery-order
// Records the Shopify order that SellerCraft will import. The first shipment
// links the checkout order; later shipments link a zero-value child order.
router.post('/:id/link-shopify-delivery-order', asyncHandler(async (req, res) => {
    const shipment = await shipmentById(req.params.id);
    const orderId = String(req.body.shopify_order_id || '').trim();
    const orderName = String(req.body.shopify_order_name || '').trim();
    const variantId = String(req.body.product_variant_id || '').trim() || null;

    if (!/^\d+$/.test(orderId)) throw httpError(400, 'A valid Shopify order ID is required');
    if (!orderName || orderName.length > 50) throw httpError(400, 'A valid Shopify order name is required');
    if (variantId && !/^\d+$/.test(variantId)) throw httpError(400, 'Invalid Shopify product variant ID');
    if (!shipment.is_due) throw httpError(409, 'This shipment is not due yet');
    if (shipment.shipment_status !== 'pending') {
      throw httpError(409, `A ${shipment.shipment_status} shipment cannot be released to SellerCraft`);
    }
    if (shipment.shopify_delivery_order_id) {
      if (shipment.shopify_delivery_order_id !== orderId) {
        throw httpError(409, 'This shipment is already linked to a different Shopify order');
      }
      return res.json({ success: true, shipment, already_exists: true });
    }
    if (!new Set(['not_sent', 'failed']).has(shipment.warehouse_status)) {
      throw httpError(409, 'This shipment has already entered the warehouse workflow');
    }

    const result = await pool.query(
      `UPDATE shipments
       SET shopify_delivery_order_id = $1,
           shopify_delivery_order_name = $2,
           shopify_delivery_created_at = NOW(),
           product_variant_id = COALESCE(product_variant_id, $3),
           oms_order_id = $1,
           oms_order_reference = $2,
           warehouse_status = 'submitted',
           oms_submitted_at = COALESCE(oms_submitted_at, NOW()),
           oms_last_synced_at = NOW(),
           warehouse_error = NULL,
           updated_at = NOW()
       WHERE id = $4 AND shopify_delivery_order_id IS NULL
       RETURNING *`,
      [orderId, orderName, variantId, shipment.id]
    );

    if (!result.rows[0]) {
      return res.json({ success: true, shipment: await shipmentById(shipment.id), already_exists: true });
    }
    res.json({ success: true, shipment: result.rows[0] });
}));

// POST /api/shipments/:id/sync-oms
// In mock mode each click advances submitted -> picking -> packed.
router.post('/:id/sync-oms', asyncHandler(async (req, res) => {
    const shipment = await shipmentById(req.params.id);
    if (!shipment.oms_order_id) throw httpError(409, 'Release this shipment to OMS first');
    if (new Set(['awb_sent', 'ready_for_pickup']).has(shipment.warehouse_status)) {
      return res.json({ success: true, shipment, already_final: true });
    }

    const omsResult = await getFulfillmentStatus(shipment);
    const result = await pool.query(
      `UPDATE shipments
       SET warehouse_status = $1,
           oms_last_synced_at = NOW(),
           oms_packed_at = CASE WHEN $1 = 'packed' THEN COALESCE(oms_packed_at, NOW()) ELSE oms_packed_at END,
           warehouse_error = NULL,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [omsResult.status, shipment.id]
    );
    res.json({ success: true, shipment: result.rows[0] });
}));

// POST /api/shipments/:id/mark-packed
// SellerCraft/Anchanto is a managed Shopify integration and currently does not
// expose a status API to this app. In manual mode an operator uses this only
// after Ninja Van confirms the parcel has actually been packed.
router.post('/:id/mark-packed', asyncHandler(async (req, res) => {
    if (OMS_MODE !== 'manual') throw httpError(409, 'Manual packed confirmation requires OMS_MODE=manual');
    const shipment = await shipmentById(req.params.id);
    if (!shipment.oms_order_id) throw httpError(409, 'Link the Shopify order before confirming packed');
    if (!new Set(['submitted', 'picking', 'packed']).has(shipment.warehouse_status)) {
      throw httpError(409, `A ${shipment.warehouse_status} warehouse order cannot be marked packed`);
    }
    const result = await pool.query(
      `UPDATE shipments
       SET warehouse_status = 'packed',
           oms_packed_at = COALESCE(oms_packed_at, NOW()),
           oms_last_synced_at = NOW(),
           warehouse_error = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [shipment.id]
    );
    res.json({ success: true, shipment: result.rows[0] });
}));

// POST /api/shipments/:id/send-awb-to-oms
router.post('/:id/send-awb-to-oms', asyncHandler(async (req, res) => {
    const shipment = await shipmentById(req.params.id);
    if (!shipment.oms_order_id) throw httpError(409, 'Release this shipment to OMS first');
    if (shipment.warehouse_status === 'awb_sent') {
      return res.json({ success: true, shipment, already_exists: true });
    }
    if (shipment.warehouse_status !== 'packed') {
      throw httpError(409, 'The warehouse must confirm packed before receiving the AWB');
    }

    const omsResult = await sendAwb(shipment);
    const result = await pool.query(
      `UPDATE shipments
       SET warehouse_status = $1,
           spx_awb_sent_at = COALESCE(spx_awb_sent_at, NOW()),
           oms_last_synced_at = NOW(),
           warehouse_error = NULL,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [omsResult.status, shipment.id]
    );
    res.json({ success: true, shipment: result.rows[0] });
}));

// POST /api/shipments/:id/sync-awb-google
// Retries the automatic Drive upload and monitoring-sheet upsert without
// creating another SPX order or AWB.
router.post('/:id/sync-awb-google', asyncHandler(async (req, res) => {
    if (!isGoogleAwbConfigured()) {
      throw httpError(503, 'Google Drive and Sheets AWB integration is not fully configured');
    }
    const shipment = await shipmentById(req.params.id);
    if (!shipment.spx_awb_url && !shipment.google_drive_file_id) {
      throw httpError(409, 'Generate the SPX AWB before syncing it to Google');
    }
    const result = await syncShipmentAwbToGoogle(shipment);
    res.json(result);
}));

// POST /api/shipments/:id/confirm-spx
// Records the tracking number returned by SPX after a manual Excel import.
// Creating a label means ready_to_ship; the caller can explicitly mark it
// shipped after handoff or after creating the matching Shopify fulfillment.
router.post('/:id/confirm-spx', asyncHandler(async (req, res) => {
    const trackingNumber = normalizeTrackingNumber(req.body.tracking_number);
    const awbUrl = normalizeAwbUrl(req.body.awb_url);
    const requestedStatus = req.body.status || 'ready_to_ship';
    if (!new Set(['ready_to_ship', 'shipped']).has(requestedStatus)) {
      throw httpError(400, 'Confirmed SPX shipments must be ready_to_ship or shipped');
    }

    const existingResult = await pool.query('SELECT * FROM shipments WHERE id = $1', [req.params.id]);
    const existing = existingResult.rows[0];
    if (!existing) throw httpError(404, 'Shipment not found');
    if (existing.warehouse_status !== 'packed') {
      throw httpError(409, 'SPX can only be booked after the warehouse confirms packed');
    }
    if (existing.spx_tracking_number && existing.spx_tracking_number !== trackingNumber) {
      throw httpError(409, 'This shipment already has a different SPX tracking number');
    }

    const result = await pool.query(
      `UPDATE shipments
       SET spx_tracking_number = $1,
           spx_awb_url = COALESCE($2, spx_awb_url),
           spx_booking_status = CASE WHEN COALESCE($2, spx_awb_url) IS NULL THEN 'created' ELSE 'ready' END,
           spx_last_synced_at = NOW(),
           spx_error = NULL,
           spx_entry_created = true,
           spx_entry_date = COALESCE(spx_entry_date, NOW()),
           shipment_status = $3::varchar,
           actual_ship_date = CASE WHEN $3::varchar = 'shipped' THEN COALESCE(actual_ship_date, CURRENT_DATE) ELSE actual_ship_date END,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [trackingNumber, awbUrl, requestedStatus, req.params.id]
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
// API 1.4 is asynchronous: this stores the returned batch number. The caller
// then uses sync-spx to retrieve the tracking number and AWB.
router.post('/:id/create-spx', asyncHandler(async (req, res) => {
    if (!isSpxConfigured()) throw httpError(503, 'Direct SPX API integration is not fully configured');
    const shipment = await shipmentById(req.params.id);
    if (shipment.warehouse_status !== 'packed') {
      throw httpError(409, 'SPX can only be booked after the warehouse confirms packed');
    }
    if (shipment.shipment_status !== 'pending') {
      throw httpError(409, `A ${shipment.shipment_status} shipment cannot create an SPX booking`);
    }
    if (shipment.spx_batch_no) {
      return res.json({ success: true, shipment, already_exists: true });
    }

    const claimed = await pool.query(
      `UPDATE shipments
       SET spx_booking_status = 'creating', spx_error = NULL, spx_last_synced_at = NOW(), updated_at = NOW()
       WHERE id = $1
         AND spx_batch_no IS NULL
         AND COALESCE(spx_booking_status, 'not_created') <> 'creating'
       RETURNING id`,
      [shipment.id]
    );
    if (!claimed.rows[0]) {
      return res.json({ success: true, shipment: await shipmentById(shipment.id), already_processing: true });
    }

    try {
      const created = await createSpxOrder(shipment);
      const result = await pool.query(
        `UPDATE shipments
         SET spx_batch_no = $1,
             spx_order_id = $2,
             spx_booking_status = 'submitted',
             spx_last_synced_at = NOW(),
             spx_error = NULL,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [created.batchNo, created.orderId, shipment.id]
      );
      return res.json({ success: true, shipment: result.rows[0] });
    } catch (error) {
      await pool.query(
        `UPDATE shipments
         SET spx_booking_status = 'failed', spx_error = $1, spx_last_synced_at = NOW(), updated_at = NOW()
         WHERE id = $2 AND spx_batch_no IS NULL`,
        [String(error.message || 'SPX order creation failed').slice(0, 500), shipment.id]
      );
      throw error;
    }
}));

// POST /api/shipments/:id/sync-spx
// Polls API 1.5 until order creation is done, then API 1.6 until the AWB link
// is ready. Each click performs one bounded poll; no request sleeps or blocks.
router.post('/:id/sync-spx', asyncHandler(async (req, res) => {
    if (!isSpxConfigured()) throw httpError(503, 'Direct SPX API integration is not fully configured');
    let shipment = await shipmentById(req.params.id);
    if (!shipment.spx_batch_no) throw httpError(409, 'Create the SPX order before checking its result');
    const hadTracking = Boolean(shipment.spx_tracking_number);

    try {
      if (!shipment.spx_tracking_number) {
        const orderResult = await getSpxOrderCreateResult(
          shipment.spx_batch_no,
          shipment.spx_order_id || spxOrderId(shipment)
        );
        if (orderResult.state === 'failed') {
          const failed = await pool.query(
            `UPDATE shipments
             SET spx_booking_status = 'failed', spx_error = $1,
                 spx_last_synced_at = NOW(), updated_at = NOW()
             WHERE id = $2 RETURNING *`,
            [orderResult.error.slice(0, 500), shipment.id]
          );
          return res.json({ success: false, shipment: failed.rows[0] });
        }
        if (orderResult.state === 'processing') {
          const processing = await pool.query(
            `UPDATE shipments
             SET spx_booking_status = 'processing', spx_error = NULL,
                 spx_last_synced_at = NOW(), updated_at = NOW()
             WHERE id = $1 RETURNING *`,
            [shipment.id]
          );
          return res.json({ success: true, shipment: processing.rows[0] });
        }

        const trackingNumber = normalizeTrackingNumber(orderResult.trackingNumber);
        const tracked = await pool.query(
          `UPDATE shipments
           SET spx_tracking_number = $1,
               spx_entry_created = true,
               spx_entry_date = COALESCE(spx_entry_date, NOW()),
               spx_booking_status = 'created',
               shipment_status = 'ready_to_ship',
               spx_error = NULL,
               spx_last_synced_at = NOW(),
               updated_at = NOW()
           WHERE id = $2 RETURNING *`,
          [trackingNumber, shipment.id]
        );
        shipment = tracked.rows[0];
      }

      if (!shipment.spx_awb_url) {
        const awbResult = await getSpxAwb(shipment.spx_batch_no);
        if (awbResult.state === 'failed') {
          const failed = await pool.query(
            `UPDATE shipments
             SET spx_booking_status = 'failed', spx_error = $1,
                 spx_last_synced_at = NOW(), updated_at = NOW()
             WHERE id = $2 RETURNING *`,
            [awbResult.error.slice(0, 500), shipment.id]
          );
          return res.json({ success: false, shipment: failed.rows[0] });
        }
        if (awbResult.state === 'processing') {
          const processing = await pool.query(
            `UPDATE shipments
             SET spx_booking_status = 'awb_processing', spx_error = NULL,
                 spx_last_synced_at = NOW(), updated_at = NOW()
             WHERE id = $1 RETURNING *`,
            [shipment.id]
          );
          shipment = processing.rows[0];
        } else {
          const awbUrl = normalizeAwbUrl(awbResult.awbUrl);
          const ready = await pool.query(
            `UPDATE shipments
             SET spx_awb_url = $1, spx_booking_status = 'ready', spx_error = NULL,
                 spx_last_synced_at = NOW(), updated_at = NOW()
             WHERE id = $2 RETURNING *`,
            [awbUrl, shipment.id]
          );
          shipment = ready.rows[0];
        }
      }

      if (shipment.spx_awb_url && isGoogleAwbConfigured()) {
        const googleResult = await syncShipmentAwbToGoogle(shipment);
        shipment = googleResult.shipment;
      }

      if (!hadTracking && shipment.spx_tracking_number && shipment.customer_phone && SPX_ENVIRONMENT !== 'uat') {
        await sendSMS(
          shipment.customer_phone,
          `Hi! SPX tracking for b&b BEAU+ shipment ${shipment.shipment_number}/${shipment.total_shipments}: ${shipment.spx_tracking_number}. Track at https://spx.ph/track`
        );
      }
      return res.json({ success: true, shipment });
    } catch (error) {
      await pool.query(
        `UPDATE shipments
         SET spx_error = $1, spx_last_synced_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [String(error.message || 'SPX status check failed').slice(0, 500), shipment.id]
      );
      throw error;
    }
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
