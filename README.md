# Subscription Backend (b&b BEAU+)

Tracks prepaid Shopify subscription orders (1/3/6/12 month plans), generates
a shipment schedule per order, and gives you a dashboard-ready API to manage
fulfillment + SPX handoff.

## Current status

This backend is an internal MVP. Shopify order HMAC verification, duplicate-order protection, transactional schedule creation, dashboard authentication, and manual shipment management are implemented.

The SPX request is currently a placeholder based on an assumed REST API shape. Do not treat `create-spx` as production-ready until SPX confirms the endpoint, authentication, fields, tracking response, retry behavior, and idempotency rules. SMS delivery also uses a provider-specific example and must be verified.

The API currently assumes a single Shopify store. Records are not scoped by shop, and the dashboard uses one shared API key.

## How it fits together

```
Shopify order created
      ↓
Webhook → POST /webhooks/orders/create   (verified via HMAC)
      ↓
Inserts 1 row into `subscriptions`
Inserts N rows into `shipments` (one per month, 30 days apart)
      ↓
Your dashboard calls GET /api/shipments/due-today
      ↓
Backend team clicks "Create SPX Entry" → POST /api/shipments/:id/create-spx
      ↓
Row updated: tracking number saved, status = shipped, customer SMS sent
```

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
# then fill in DATABASE_URL, SHOPIFY_WEBHOOK_SECRET, SPX_API_KEY, etc.
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
| GET | `/api/shipments/due-today` | Main dashboard view |
| GET | `/api/shipments/spx-xlsx` | Download SPX's populated Excel template for shipments due today |
| GET | `/api/shipments/:id/spx-xlsx` | Download SPX's populated Excel template for one shipment |
| GET | `/api/shipments?status=&from=&to=` | Filtered shipment list |
| GET | `/api/shipments/subscriptions/:id` | All shipments for one subscription |
| POST | `/api/shipments/:id/create-spx` | Create SPX entry + notify customer |
| PATCH | `/api/shipments/:id` | Manually update status/notes/tracking |
| GET | `/api/subscriptions?status=&email=` | Look up subscriptions |
| PATCH | `/api/subscriptions/:id/cancel` | Cancel subscription + pending shipments |

## Important: SPX integration is a placeholder

I don't have confirmed SPX API docs — `create-spx` in
`src/routes/shipments.js` is written assuming a typical REST shape. Before
this works for real:

1. Ask SPX support if a merchant API exists (vs. manual Excel upload)
2. If yes: update the request body/auth in `create-spx` to match their docs
3. If no: use the implemented `.xlsx` export, which populates SPX's official
   Philippines mass-order template while preserving its hidden lookup sheets
   and validations.

## Known limitations before production

- Order plans are detected by parsing the line-item or variant title for `1`, `3`, `6`, or `12`. Variant IDs or product metadata would be more reliable.
- The webhook currently does not enforce a paid financial status before creating a subscription.
- The dashboard list endpoints return all matching rows and do not provide pagination.
- Concurrent calls to `POST /api/shipments/:id/create-spx` can create duplicate external shipments because the operation is not locked or idempotency-keyed.
- Manual shipment updates can leave related fields inconsistent, such as `actual_ship_date`, `spx_entry_created`, and `shipment_status`.
- The database schema does not enforce the documented status and plan-month values with check constraints, and `updated_at` is not maintained by a database trigger.
- There are no automated tests yet.
- For a multi-store Shopify app, add a shop identifier to subscriptions, shipments, webhook processing, and dashboard authorization before onboarding additional stores.
- SPX workbook exports default to 0.2 kg and 20 × 15 × 10 cm. Set the `SPX_PARCEL_*` environment variables to the actual packed dimensions before live use.
- The export uses `General merchandise`, `Sender Pay`, and no COD by default. Configure `SPX_ITEM_TYPE` and `SPX_PAYMENT_METHOD` if your account requires different accepted values.

## Next steps once this is running

- Build the actual dashboard UI (React) that calls these endpoints
- Keep the dashboard API key private; `/api` routes require `X-Dashboard-Key`.
- Add a cron job to catch shipments whose date passed without action, and
  alert your team (Slack webhook, email, etc.)
- Keep the dashboard API key private and rotate it if exposed.
- Add pagination and database-side dashboard summary queries.
- Add automated tests for HMAC verification, duplicate webhooks, date scheduling,
  cancellation, status transitions, and SPX retry/idempotency behavior.
