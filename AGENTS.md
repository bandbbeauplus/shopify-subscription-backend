# B&B BEAU+ subscription backend

This folder contains the Express/PostgreSQL service for Shopify order webhooks,
prepaid delivery schedules, dashboard APIs, OMS/WMS handoff state, and SPX Excel
reconciliation. Read `README.md` before changing the workflow.

## Business rules

- A line item is recurring only when its `variant_title` starts with one of the
  supported plan names: `1-Month Plan`, `3-Month Plan`, `6-Month Plan`, or
  `12-Month Plan`. Use `src/utils/subscriptionPlan.js`; do not infer recurrence
  from product titles, sachet quantities, prices, or temporary SKUs.
- Normal variants such as `7 Sachets`, `14 Sachets`, and `28 Sachets` must not
  create subscription records. They do create one ordinary shipment row so the
  warehouse, SPX, and Google AWB workflow can be managed from this app.
- SKUs may change during SellerCraft/Anchanto testing, so subscription detection
  must not depend on a hard-coded SKU.
- Orders tagged `bb_subscription_delivery` are child delivery orders and must be
  ignored by the subscription-creation webhook.
- The original Shopify checkout represents shipment 1. Future generated Shopify
  delivery orders represent shipment 2 onward; avoid sending shipment 1 twice
  to SellerCraft/Anchanto.
- SellerCraft OMS synchronizes Shopify orders to Anchanto WMS. SPX is the
  last-mile courier and supplies the AWB/tracking number after booking.
- Use `OMS_MODE=manual` for the managed SellerCraft/Anchanto connection. An
  operator may confirm packed only after Ninja Van confirms the physical parcel
  is packed. Use `OMS_MODE=api` only with a confirmed direct API contract.
- SPX UAT account creation, verification, order creation, tracking retrieval,
  and AWB PDF generation are confirmed. Direct booking must use
  `src/services/spxClient.js`: API 1.4 creates a batch, API 1.5 returns the
  tracking number, and API 1.6 returns the AWB link.
- For live pickup orders, API 1.1 must run immediately before API 1.4. Use the
  earliest SPX-returned slot unless all three `SPX_PICKUP_*` override values are
  deliberately configured together.
- SPX tracking callbacks belong at `/spx/webhooks/tracking`, outside Shopify's
  HMAC middleware. Preserve exact raw-body signature verification, timestamp
  freshness, event-ID idempotency, and non-regressing delivery status updates.
- SPX permanent evidence URLs belong at `/spx/webhooks/evidence`. Store only
  validated HTTPS URLs and event metadata, keep them behind dashboard
  authentication, and never log proof links or customer evidence.
- In SPX UAT, use only the approved fixed address profile and never send real
  customer data. In production, require SPX-confirmed hierarchy values for the
  supplied warehouse sender and a valid pickup timeslot before enabling pickup.
- Keep Excel export and manual AWB confirmation as operational fallbacks.
- Calculate parcel weight at 188 g per physical box unless an explicit
  environment override is configured. Ordinary 7/14/28-sachet variants map to
  1/2/4 boxes; each recurring monthly delivery maps to 4 boxes.
- Keep customer SMS disabled by default; Shopify owns customer notifications.
- When Google AWB sync is enabled, archive the temporary SPX PDF in Drive and
  upsert Sheets by shipment ID. Do not place customer PII in the monitoring
  sheet, and do not treat Sheet sync as proof that the warehouse printed it.

## Security and data integrity

- Verify Shopify webhook HMAC against the raw request body before processing.
- Require `X-Dashboard-Key` on dashboard `/api` routes.
- Never log or commit access tokens, app secrets, user secrets, API keys,
  customer addresses, phone numbers, or complete webhook bodies.
- Preserve duplicate-webhook protection and use database transactions when a
  subscription and its shipment schedule must be created together.
- Preserve string handling for external `int64` identifiers; JavaScript numbers
  can lose precision.
- External mutations must be retry-safe. Use deterministic references or
  idempotency keys and do not silently create duplicate OMS or SPX orders.

## Commands and verification

```powershell
npm install
npm test
npm run migrate
npm run dev
```

Run `npm test` after meaningful changes. Add or update Node test-runner coverage
for plan detection, webhook behavior, status transitions, workbook generation,
and external-client mapping as applicable.

## Editing rules

- Keep route handlers small; shared external-service logic belongs under
  `src/services`, and reusable parsing/formatting belongs under `src/utils`.
- Use the existing async middleware and centralized error handling rather than
  introducing unhandled promise rejections.
- Database changes must be backward-compatible and represented in `schema.sql`.
  Do not delete or rewrite production data without explicit user authorization.
- Update `README.md` and `.env.example` whenever environment variables, setup,
  API behavior, or operational limitations change.
- Preserve unrelated user changes. Do not deploy or push unless the user asks.
- Never commit `.env` or real credentials.
