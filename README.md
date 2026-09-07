# Subscription Backend (b&b BEAU+)

Tracks ordinary Shopify orders and prepaid subscriptions (1/3/6/12-month
plans), generates a calendar-month shipment schedule for prepaid plans, and provides APIs for the Shopify
admin dashboard, SellerCraft/Anchanto preparation, and SPX handoff.

## Current status

This backend is an internal MVP. Shopify order HMAC verification,
duplicate-order protection, transactional schedule creation, dashboard
authentication, managed SellerCraft/Anchanto handoff, and signed SPX OpenAPI
UAT booking are implemented.

SPX account creation, account verification, API 1.4 order creation, API 1.5
tracking retrieval, and API 1.6 AWB generation have all completed successfully
against `https://test-stable.spx.ph`. UAT requests replace real customer
addresses with SPX's approved test profile. Excel export and manual tracking
confirmation remain available as fallbacks.

The signed SPX tracking callback is implemented at
`POST /spx/webhooks/tracking`. It verifies the raw body using SPX's
`check-sign`, rejects stale/replayed requests, stores event IDs for idempotency,
and updates matching shipments without allowing delayed events to downgrade a
shipped or delivered parcel.

The signed evidence callback at `POST /spx/webhooks/evidence` stores SPX's
permanent pickup, delivery, return, and other-handling proof URLs. Files are not
copied to Drive, so this adds only small PostgreSQL metadata records. Proof
links remain visible only through the authenticated Shopify admin dashboard.

SellerCraft successfully synchronized a paid Shopify test order to Anchanto,
and a Shopify cancellation synchronized back to the warehouse order. The
expected out-of-stock problem state confirmed that SKU and inventory mapping
remain warehouse prerequisites.

Google Drive archival and Google Sheet upsert code is implemented but has not
been live-tested because the backend does not yet have the client's Google
service-account, folder, and spreadsheet configuration. Production SPX
activation still requires confirmation of the SPX address hierarchy for Ninja
Van's Cabuyao warehouse. For pickup orders, the backend calls SPX API 1.1
immediately before API 1.4 and uses the earliest returned timeslot. The three
`SPX_PICKUP_*` values are optional operational overrides only. Customer SMS is
disabled because Shopify owns customer notifications.

The API currently assumes a single Shopify store. Records are not scoped by shop, and the dashboard uses one shared API key.

## How it fits together

```
Shopify order created
      ↓
Webhook → POST /webhooks/orders/create   (verified via HMAC)
      ↓
Recurring variant titles beginning with 1/3/6/12-Month Plan create a plan
Ordinary sachet variants create a one-time fulfillment shipment
bb_subscription_delivery child orders are ignored
      ↓
Recurring: inserts 1 subscription and N monthly shipment rows
Ordinary: inserts 1 one-time shipment row
      ↓
Your dashboard calls GET /api/shipments/due-today
      ↓
For shipment 1, dashboard links the original Shopify checkout order
For shipment 2+, dashboard creates a tagged zero-value Shopify delivery order
      ↓
SellerCraft imports the Shopify order and sends it to Anchanto WMS
      ↓
Ninja Van confirms that Anchanto has packed the parcel
      ↓
POST /api/shipments/:id/create-spx returns an SPX batch number
      ↓
POST /api/shipments/:id/sync-spx retrieves tracking and the AWB PDF
      ↓
The backend archives the PDF in Drive and upserts the Google monitoring sheet
      ↓
Operator notifies Ninja Van and later confirms the AWB was shared
      ↓
Row updated: tracking saved, status = ready_to_ship; Shopify handles customer notices
```

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
# then fill in DATABASE_URL, SHOPIFY_WEBHOOK_SECRET, SPX credentials, etc.
```

### 3. Create the database
Spin up a free Postgres instance on Railway, Render, or Supabase, then run:
```bash
psql $DATABASE_URL -f schema.sql
```

### 4. Run locally
```bash
npm run dev
```
Server runs on `http://localhost:3000`. Test it's alive:
```bash
curl http://localhost:3000/health
```

### 5. Expose it for Shopify to reach (local testing only)
Shopify webhooks can't hit `localhost`. Use ngrok while developing:
```bash
npx ngrok http 3000
# gives you something like https://abc123.ngrok.io
```

### 6. Register the webhook in Shopify
Shopify Admin → **Settings → Notifications** → scroll to the bottom →
**Webhooks** section → **Create webhook**:
- Event: `Order creation`
- Format: `JSON`
- URL: `https://your-domain.com/webhooks/orders/create`
  (or your ngrok URL while testing)

Create a second JSON webhook for `Order cancellation` at:
`https://your-domain.com/webhooks/orders/cancelled`.

Shopify will show you a **signing secret** when you save — copy that into
`SHOPIFY_WEBHOOK_SECRET` in your `.env`.

### 7. Deploy for real
Push this to Railway or Render (both auto-detect Node + let you attach a
Postgres addon in a couple clicks). Set the same env vars there, then point
the Shopify webhook at your live URL instead of ngrok.

## API Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/webhooks/orders/create` | Shopify calls this automatically |
| POST | `/webhooks/orders/cancelled` | Cancel matching pending fulfillment records |
| POST | `/spx/webhooks/tracking` | Receive signed SPX tracking-status callbacks |
| POST | `/spx/webhooks/evidence` | Receive signed permanent SPX evidence-proof URLs |
| GET | `/api/shipments/due-today` | Main dashboard view |
| GET | `/api/shipments/spx-xlsx` | Download SPX's populated Excel template for shipments due today |
| GET | `/api/shipments/:id/spx-xlsx` | Download SPX's populated Excel template for one shipment |
| GET | `/api/shipments?status=&kind=&from=&to=` | Filtered shipment list (`kind=ordinary` or `subscription`) |
| GET | `/api/shipments/subscriptions/:id` | All shipments for one subscription |
| GET | `/api/shipments/integration-config` | Show safe OMS and SPX configuration state |
| GET | `/api/shipments/:id` | Load one shipment for a Shopify delivery release |
| POST | `/api/shipments/:id/link-shopify-delivery-order` | Save the Shopify order SellerCraft will import |
| POST | `/api/shipments/:id/release-to-oms` | Create the warehouse fulfillment order |
| POST | `/api/shipments/:id/sync-oms` | Refresh submitted/picking/packed status |
| POST | `/api/shipments/:id/mark-packed` | Manually confirm Ninja Van packed status |
| POST | `/api/shipments/:id/send-awb-to-oms` | Send SPX tracking and AWB to the warehouse |
| POST | `/api/shipments/:id/confirm-spx` | Save tracking returned by an SPX Excel import |
| POST | `/api/shipments/:id/create-spx` | Submit SPX API 1.4 batch order creation |
| POST | `/api/shipments/:id/sync-spx` | Poll SPX API 1.5 and 1.6 for tracking/AWB |
| POST | `/api/shipments/:id/sync-awb-google` | Retry Drive upload and Google Sheet upsert |
| PATCH | `/api/shipments/:id` | Manually update status/notes/tracking |
| GET | `/api/subscriptions?status=&email=` | Look up subscriptions |
| PATCH | `/api/subscriptions/:id/cancel` | Cancel subscription + pending shipments |

## SPX OpenAPI modes

Set `SPX_MODE=api` only after all required values in `.env.example` are present.
In `SPX_ENVIRONMENT=uat`, the integration uses the approved
North Luzon/Pampanga/Angeles City/Amsic sender and
Visayas/Eastern Samar/Oras/Agsam receiver profile. It never sends a real
customer address or notification. Postal codes and test phone numbers remain
environment variables because they were not included in the supplied UAT file.

In production, the receiver comes from Shopify. The Shopify address must include
an exact barangay/district (currently read from `address2`), and Ninja Van must
provide its warehouse sender name, phone, complete address, and postal code.
Pickup (`SPX_COLLECT_TYPE=1`) also requires a current API 1.1 timeslot. Until
those are confirmed, keep production disabled and use UAT or Excel fallback.

### SPX tracking webhook

Register this public production callback with SPX:

```text
https://shopify-subscription-backend.onrender.com/spx/webhooks/tracking
```

SPX signs the exact JSON bytes using the app ID, request `timestamp`,
`random-num`, and app secret. The callback uses `SPX_WEBHOOK_APP_ID` and
`SPX_WEBHOOK_APP_SECRET` when supplied, otherwise it falls back to
`SPX_APP_ID` and `SPX_APP_SECRET`. Set the new live credentials on the backend
before SPX sends a production test callback.

SPX requires an HTTP 200 response within three seconds. Use an always-on
production backend instance; a sleeping/free service can cold-start too slowly
and SPX may stop pushing after repeated timeouts. Events are matched by tracking
number or the deterministic partner order ID (`BB-{shipment_id}`).

Register the separate evidence callback as:

```text
https://shopify-subscription-backend.onrender.com/spx/webhooks/evidence
```

It accepts SPX `epop_list`, `epod_list`, `epor_list`, and `epooh_list` updates,
validates HTTPS links, deduplicates by callback ID, and stores the permanent
URLs on the matching shipment. Evidence URLs can expose pickup photos or
customer signatures; do not place them in public logs or documents.

## OMS/WMS integration modes

SellerCraft already provides the managed Shopify-to-OMS connection used by
Ninja Van, so the live connection is configured and tested with their team
rather than recreated in this backend. Use `OMS_MODE=manual` for the current
live process: the operator confirms packed only after Ninja Van confirms it and
marks the AWB shared after sending the PDF to the warehouse. `OMS_MODE=mock`
remains available for isolated testing; **Advance mock status** moves
a released shipment from `submitted` to `picking` and then `packed`, allowing
the dashboard workflow to be tested safely.

When API access is available, set `OMS_MODE=api`, configure the API base URL,
token, and endpoint paths, then update `src/services/omsClient.js` if the final
Anchanto request/response fields differ from the isolated placeholder mapping.
The client already sends a deterministic shipment reference as an idempotency
key so retries do not intentionally create a second warehouse order.

The production start command runs `schema.sql` automatically. Its
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements add the OMS/WMS and
Shopify delivery-order fields without deleting existing shipment data.

## Google Drive and Sheets AWB monitoring

See [`GOOGLE_AWB_SETUP.md`](GOOGLE_AWB_SETUP.md) for the exact Google Cloud,
Drive, Sheet, sharing, ID, and base64-key steps.

Set `GOOGLE_AWB_MODE=api` to archive each completed SPX AWB in Google Drive
and add or update its monitoring row in Google Sheets. The automatic sync runs
after API 1.6 returns the AWB. Google failures are stored separately and can be
retried from the dashboard without creating another SPX order.

1. In the client's Google Cloud project, enable the Google Drive API and Google
   Sheets API.
2. Create a service account and download its JSON key.
3. Create an `AWB Monitoring` tab with columns A-K available, plus a private
   Google Shared Drive folder for the PDFs. The backend creates the header row
   when the tab is empty.
4. Add the service-account email to the Shared Drive/folder and share the
   spreadsheet with it. Share the final folder and sheet with Ninja Van using
   their approved accounts.
5. Base64-encode the complete JSON key and save it only in the backend as
   `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`. Alternatively configure the email
   and private key separately.
6. Configure `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_SHEET_ID`, and optionally
   `GOOGLE_SHEET_TAB`, then set `GOOGLE_AWB_MODE=api`.

The sheet stores order type, shipment/order references, SKU, physical box
count, parcel weight, tracking number, Drive URL, generation time, print
status, and environment. It intentionally excludes
customer names, phone numbers, and addresses. The SPX signed download URL is
temporary, so the warehouse-facing link always points to the archived Drive
copy. Shipment ID is the upsert key, preventing repeated polling from adding a
second monitoring row.

This integration is implemented but remains disabled until the Google
service-account and destination IDs are configured and one live UAT upload is
verified.

## Known limitations before production

- Order plans are detected only from a `variant_title` beginning with
  `1-Month Plan`, `3-Month Plan`, `6-Month Plan`, or `12-Month Plan`.
  Ordinary sachet variants are ignored. Variant IDs or product metadata would
  still be more reliable long-term.
- The webhook currently creates one subscription from the first matching plan
  line. Mixed carts containing multiple prepaid plan lines require additional
  modeling before production use.
- Ordinary products now create one-time shipment rows and use the same packed →
  SPX → AWB → Google workflow without creating subscription records. A mixed
  cart's first shipment contains all checkout items; later shipments contain
  only the recurring plan item.
- The webhook currently does not enforce a paid financial status before creating a subscription.
- Shopify cancellation is consumed when the `Order cancellation` webhook is
  registered. It cancels pending internal shipments but cannot reverse parcels
  already shipped or delivered.
- The dashboard list endpoints return all matching rows and do not provide pagination.
- SPX retries use a deterministic partner order ID and an atomic local claim,
  but recovery from a network timeout after SPX accepts an order still needs a
  track-by-partner-order reconciliation path.
- Manual status changes remain operator-controlled; only `shipped` and `delivered` automatically set `actual_ship_date`.
- The database schema does not enforce the documented status and plan-month values with check constraints, and `updated_at` is not maintained by a database trigger.
- Automated coverage includes plan detection, workbook generation, OMS mapping,
  SPX signing, int64 serialization, UAT address isolation, and asynchronous SPX
  response normalization; route, webhook, and status-transition coverage is
  still needed.
- For a multi-store Shopify app, add a shop identifier to subscriptions, shipments, webhook processing, and dashboard authorization before onboarding additional stores.
- Parcel weight is calculated at 188 g per physical box: 7/14/28-sachet
  ordinary variants map to 1/2/4 boxes and each monthly prepaid delivery maps
  to 4 boxes (0.752 kg). The 20 × 15 × 10 cm dimensions are temporary; replace
  them with measured packed-parcel dimensions before live use.
- SPX API orders are sender-pay and non-COD because Shopify has already collected
  payment. Confirm the production parcel category and insured value policy.

## Next steps

- Obtain the production SPX base URL, App ID/secret, account activation, and
  production user credentials from SPX.
- Confirm SPX's exact state/city/district/street hierarchy for the supplied
  Ninja Van Cabuyao warehouse and the final pickup/drop-off process.
- Create the client's Google service account, Shared Drive folder, and
  monitoring Sheet; configure the backend and run one end-to-end UAT upload.
- Confirm the pre-order/stock-hold procedure with Ninja Van before enabling
  pre-orders while inventory is unavailable.
- Move the Render backend to an always-on production instance before enabling
  SPX tracking callbacks.
- Add a cron job to catch shipments whose date passed without action, and
  alert your team (Slack webhook, email, etc.)
- Keep the dashboard API key private and rotate it if exposed.
- Add pagination and database-side dashboard summary queries.
- Add automated tests for HMAC verification, duplicate webhooks, date scheduling,
  cancellation, status transitions, and SPX retry/idempotency behavior.
