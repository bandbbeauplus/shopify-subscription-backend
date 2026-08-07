# b&b BEAU+ Subscription System Setup Guide

**Date:** August 6, 2026  
**Status:** Webhook connected, backend deployed, Supabase configured  
**Next Step:** Test order creation and build dashboard UI

---

## Project Overview

**Goal:** Replace Recharge with a custom prepaid subscription system for b&b BEAU+.

**Model:** Customers pay upfront for a bundle (1/3/6/12 months). Backend auto-generates one shipment per month, every 30 days.

**Tech Stack:**
- Frontend: Shopify + custom Liquid widget
- Backend: Node.js + Express
- Database: Supabase (Postgres)
- Payment: PayMongo (handled by Shopify)
- Fulfillment: SPX Express PH (integration pending)
- SMS: Semaphore (configured but not yet live)

---

## Architecture Flow

```
Customer Selects Plan
    ↓
Shopify Checkout (PayMongo)
    ↓
Order Created → Shopify webhook fires
    ↓
POST /webhooks/orders/create
    ↓
Backend verifies HMAC signature (security)
    ↓
Parse variant title to extract months (1/3/6/12)
    ↓
Insert into `subscriptions` table (1 row)
Insert into `shipments` table (N rows, one per month)
    ↓
Dashboard queries: "What's due today?"
    ↓
Backend team clicks "Create SPX Entry"
    ↓
SPX label generated, tracking sent to customer via SMS
```

---

## What's Already Done ✅

### 1. Shopify Product Setup ✅
- Created product with 4 variants:
  - "1 Month Subscription"
  - "3 Months (Monthly Deliveries)"
  - "6 Months (Monthly Deliveries)"
  - "12 Months (Monthly Deliveries)"
- Prices set to full prepaid totals:
  - 1 month: ₱4,399.00
  - 3 months: ₱13,095.00
  - 6 months: ₱25,650.00
  - 12 months: ₱48,600.00

### 2. Product Page Widget ✅
- Custom Liquid code displays 4 plan cards
- Card titles static ("1 Month Plan", "3 Months Plan", etc.)
- Clicking a card selects the variant
- "Subscribe Now" button adds to cart → redirects to checkout
- Shows "Starts at" on 1-month, "/month" pricing on others

**File:** `subscription-widget-simplified.liquid`

### 3. Backend Deployed ✅
- Node.js + Express running on Render
- URL: `https://shopify-subscription-backend.onrender.com`
- Health check: `GET /health` returns `{"status":"ok"}`

### 4. Database Configured ✅
- Supabase project created (Singapore region)
- Schema applied (subscriptions + shipments tables)
- SSL enabled for Render → Supabase connection
- Tables ready to receive order data

### 5. Shopify Webhook Registered ✅
- Event: "Order creation"
- URL: `https://shopify-subscription-backend.onrender.com/webhooks/orders/create`
- API Version: 2026-10 (release candidate)
- Signing secret saved to Render env var `SHOPIFY_WEBHOOK_SECRET`

### 6. Environment Variables Set ✅
In Render dashboard:
```
DATABASE_URL=postgresql://postgres:...@db.*.supabase.co:5432/postgres
NODE_ENV=production
PORT=3000
SHOPIFY_WEBHOOK_SECRET=your_webhook_signing_secret
SHOPIFY_STORE_DOMAIN=g892i7-7c-sp.myshopify.com
SPX_API_BASE_URL=https://api.spx.com.ph
SPX_API_KEY=your_spx_api_key (placeholder)
SMS_API_KEY=your_sms_provider_key (placeholder)
SMS_SENDER_NAME=b&bBEAUplus
```

---

## Database Schema

### `subscriptions` table
Stores one row per customer purchase.

| Column | Type | Purpose |
|---|---|---|
| id | INT PK | Unique ID |
| order_id | VARCHAR(50) | Shopify order ID |
| order_name | VARCHAR(50) | Human-readable order name (#1001) |
| customer_id | VARCHAR(50) | Shopify customer ID |
| customer_email | VARCHAR(150) | For receipts/notifications |
| customer_phone | VARCHAR(20) | For SMS shipment alerts |
| shipping_address | JSONB | Full address object |
| product_name | VARCHAR(200) | "b&b BEAU+ Gut + Energy" |
| variant_title | VARCHAR(150) | "6 Months (Monthly Deliveries)" |
| total_price_paid | DECIMAL(10,2) | ₱25,650.00 |
| plan_months | INT | 1, 3, 6, or 12 |
| payment_date | TIMESTAMP | When order was created |
| subscription_start_date | TIMESTAMP | Same as payment_date |
| subscription_end_date | TIMESTAMP | Calculated: start + N months |
| subscription_status | VARCHAR(20) | active, paused, cancelled, completed |
| created_at | TIMESTAMP | Record created time |
| updated_at | TIMESTAMP | Last updated |

### `shipments` table
Stores one row per monthly shipment obligation.

| Column | Type | Purpose |
|---|---|---|
| id | INT PK | Unique ID |
| subscription_id | INT FK | Link to subscriptions |
| order_id | VARCHAR(50) | Shopify order ID (denorm for queries) |
| customer_id | VARCHAR(50) | For filtering |
| customer_name | VARCHAR(150) | Full name |
| customer_email | VARCHAR(150) | For email receipts |
| customer_phone | VARCHAR(20) | For SMS |
| shipping_address | JSONB | Full address |
| product_name | VARCHAR(200) | What we're shipping |
| shipment_number | INT | 1 of 6, 2 of 6, etc. |
| total_shipments | INT | How many total shipments expected |
| scheduled_ship_date | DATE | When to ship (TODAY or future) |
| actual_ship_date | DATE | When it was actually shipped |
| spx_tracking_number | VARCHAR(50) | SPX tracking code |
| shipment_status | VARCHAR(20) | pending, ready_to_ship, shipped, delivered, failed, cancelled |
| spx_entry_created | BOOLEAN | Whether SPX entry exists |
| spx_entry_date | TIMESTAMP | When SPX entry was created |
| notes | TEXT | Manual notes (delivery issues, etc.) |
| created_at | TIMESTAMP | Record created time |
| updated_at | TIMESTAMP | Last updated |

---

## API Endpoints

### Webhooks
**POST** `/webhooks/orders/create`
- Called by Shopify automatically when order created
- Requires HMAC signature verification
- Inserts into subscriptions + generates shipments
- No response needed (fires async)

### Shipments Management

**GET** `/api/shipments/due-today`
- Returns all pending shipments with scheduled_ship_date ≤ TODAY
- **Use:** Main dashboard view
- Response: Array of shipment rows

**GET** `/api/shipments?status=pending&from=2026-08-01&to=2026-08-31`
- Filters by status, date range, customer email
- Response: Array of shipment rows

**GET** `/api/shipments/subscriptions/:id`
- All shipments for one subscription (to see the full schedule)
- Response: Array of shipment rows

**POST** `/api/shipments/:id/create-spx`
- Creates SPX shipping entry, saves tracking number, updates status
- Sends SMS to customer with tracking
- Response: `{"success": true, "tracking_number": "SPX-..."}`

**PATCH** `/api/shipments/:id`
- Manually update shipment status, notes, or tracking number
- Body: `{"status": "delivered", "notes": "Left with security guard"}`
- Response: `{"success": true}`

### Subscriptions Management

**GET** `/api/subscriptions?status=active&email=customer@gmail.com`
- Look up subscriptions by status or customer email
- Response: Array of subscription rows

**PATCH** `/api/subscriptions/:id/cancel`
- Cancels subscription + marks all pending shipments as cancelled
- Response: `{"success": true}`

---

## How the Backend Processes an Order

**Step 1: Shopify fires webhook**
```
POST https://shopify-subscription-backend.onrender.com/webhooks/orders/create
Body: { order object with line_items, customer, shipping_address, etc. }
Header: X-Shopify-Hmac-Sha256: [signature]
```

**Step 2: Backend verifies signature** (`verifyShopifyWebhook.js`)
```javascript
const generatedHash = crypto
  .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
  .update(raw_body)
  .digest('base64');

if (generatedHash !== header_signature) reject; // forged webhook
```

**Step 3: Parse variant title** (`shopifyOrders.js`)
```javascript
const variantTitle = "6 Months (Monthly Deliveries)";
const monthsMatch = variantTitle.match(/(\d+)/);
const planMonths = parseInt(monthsMatch[1]); // → 6
```

**Step 4: Calculate dates**
```javascript
const orderDate = new Date("2026-08-06");
const endDate = new Date(orderDate);
endDate.setMonth(endDate.getMonth() + 6); // → 2027-02-06
```

**Step 5: Insert subscription row**
```sql
INSERT INTO subscriptions
  (order_id, customer_email, variant_title, plan_months, 
   subscription_start_date, subscription_end_date, ...)
VALUES (#1002, user@gmail.com, "6 Months...", 6, 
        2026-08-06, 2027-02-06, ...)
RETURNING id → 42
```

**Step 6: Generate 6 shipment rows** (loop i=0 to 5)
```sql
INSERT INTO shipments
  (subscription_id, shipment_number, total_shipments, scheduled_ship_date, ...)
VALUES (42, 1, 6, 2026-08-06, 'pending'),
       (42, 2, 6, 2026-09-05, 'pending'),
       (42, 3, 6, 2026-10-05, 'pending'),
       (42, 4, 6, 2026-11-04, 'pending'),
       (42, 5, 6, 2026-12-04, 'pending'),
       (42, 6, 6, 2027-01-03, 'pending')
```

**Step 7: Respond to Shopify**
```
200 OK
```

Shopify just needs confirmation the webhook was received. All real work happens after.

---

## Current Issues / Placeholders

### 1. SPX Integration ⚠️ PENDING
We don't have confirmed SPX API documentation. Two possibilities:

**Option A: SPX has a REST API**
- Contact SPX: ask for API docs + merchant credentials
- Update `src/routes/shipments.js` → `create-spx` endpoint with real request/response format
- Currently written as a guess based on typical courier APIs

**Option B: SPX uses CSV imports only**
- Replace the API call with CSV generation
- Backend creates a CSV file matching SPX's "Import to Mass Edit" format
- Your team downloads it daily, uploads to SPX portal manually
- Slightly more work, but many PH couriers only offer this

**Action:** Contact SPX support (they're your payment gateway, they know your account) and ask: "Do you have a merchant API for creating shipments, or is it manual/CSV only?"

### 2. SMS Notifications ⚠️ PLACEHOLDER
Code references `SMS_API_KEY` and `SMS_SENDER_NAME` but doesn't actually send yet.

Currently: `sendSMS()` logs "[SMS SKIPPED]" and returns success.

**To activate:**
1. Sign up for Semaphore (semaphore.co) — popular PH SMS API
2. Get API key
3. Update Render env var: `SMS_API_KEY=your_key`
4. Update `src/utils/sms.js` with real Semaphore API call (already has stub)
5. When backend creates SPX entry, SMS is sent automatically

### 3. Webhook Signature Verification ✅ DONE
Unlike the placeholders above, HMAC verification is **fully implemented and required**. This prevents anyone from faking orders by posting to your webhook URL.

---

## Testing Workflow

### Test 1: Backend is Reachable
```bash
curl https://shopify-subscription-backend.onrender.com/health
```
Expected response:
```json
{"status":"ok","time":"2026-08-06T12:34:56.789Z"}
```

### Test 2: Database Connection Works
Go to **Supabase → SQL Editor → New query**:
```sql
SELECT COUNT(*) as total_subscriptions FROM subscriptions;
```
Should return `0` initially (no orders yet).

### Test 3: Webhook Receives Orders
1. Go to your Shopify store
2. Add a subscription product to cart (pick "3 Months Plan")
3. Checkout with test card
4. Complete order

Expected: Order appears in both tables:
- `subscriptions`: 1 row (the full 3-month purchase)
- `shipments`: 3 rows (one shipment per month)

### Test 4: Dashboard API
Once orders exist, test the API:
```bash
curl https://shopify-subscription-backend.onrender.com/api/shipments/due-today
```
Should return array of shipments with today's scheduled_ship_date.

---

## Deployment Status

| Component | Status | URL |
|---|---|---|
| Shopify Product | ✅ Live | https://beauplus.co/products/b-b-beau-gut-energy-testing |
| Widget Code | ✅ Active | On product page |
| Backend | ✅ Deployed | https://shopify-subscription-backend.onrender.com |
| Database | ✅ Connected | Supabase Singapore region |
| Webhook | ✅ Registered | Order creation → backend |
| Dashboard UI | ⬜ Not built | React/Retool needed |
| SPX Integration | ⚠️ Pending | Awaiting API confirmation |
| SMS | ⚠️ Placeholder | SMS_API_KEY set, waiting to activate |

---

## Next Steps (Priority Order)

### 1. Confirm Test Order Works (TODAY)
- Create a test order in your Shopify store
- Check that `subscriptions` and `shipments` rows appear in Supabase
- If they do: **webhook is working perfectly** ✅

### 2. Confirm SPX Path (THIS WEEK)
- Email/contact SPX: "Do you have a merchant API?"
- If YES: give me their API docs, I'll update the backend
- If NO (CSV only): I'll build CSV export instead

### 3. Build Dashboard UI (NEXT WEEK)
Options (in order of speed):
- **Retool** (~1-2 days): drag-and-drop, connects to your API, no code needed
- **Budibase** (~1-2 days): similar to Retool, free open-source option
- **Custom React** (~1-2 weeks): full control, but slower

Dashboard should display:
- Table of shipments due today/this week
- Filter by status, date, customer
- "Create SPX Entry" button for each row
- "Mark as Delivered" / "Mark as Failed" buttons
- Link to SPX tracking if available

### 4. Activate SMS (AFTER INITIAL LAUNCH)
- Sign up Semaphore
- Add API key to Render env vars
- Test sends

### 5. Test End-to-End
Once SPX API/CSV is confirmed and dashboard is built:
- Create a real test order
- See it in dashboard
- Create SPX entry manually
- Customer should receive SMS with tracking

---

## Code Files Reference

**Backend (Node.js + Express):**
- `src/index.js` — Main server entry, route setup
- `src/db.js` — Supabase connection pooling
- `src/webhooks/shopifyOrders.js` — Order creation handler
- `src/routes/shipments.js` — Shipment APIs + SPX creation
- `src/routes/subscriptions.js` — Subscription lookups
- `src/utils/verifyShopifyWebhook.js` — HMAC signature check (security)
- `src/utils/sms.js` — SMS sender stub
- `schema.sql` — Database tables + indexes

**Frontend (Shopify Liquid):**
- `subscription-widget-simplified.liquid` — Product page widget

---

## Troubleshooting

### No data appears in Supabase after creating an order
1. Check Render logs for errors (especially `connect ENETUNREACH` = DB connection failed)
2. Verify `DATABASE_URL` and `SHOPIFY_WEBHOOK_SECRET` are set in Render
3. Verify webhook URL in Shopify matches exactly: `/webhooks/orders/create`
4. Check Shopify Admin → **Settings → Notifications → Webhooks** → click the webhook to see recent deliveries + errors

### Backend times out
- Check Render → Project → Metrics (CPU/memory usage)
- If high: need to upgrade Render plan or optimize queries
- Check database connection pooling in `db.js` — defaults are fine for MVP

### Webhook says "⚠️ Missing HMAC header"
- `SHOPIFY_WEBHOOK_SECRET` is not in Render env vars
- Or the value was miscopied
- Go back to Shopify webhook page, copy the secret again, re-paste into Render

---

## Support / Questions

If something breaks:
1. **Check Render logs first** — 90% of issues show up there
2. **Verify env vars are set** — DATABASE_URL, SHOPIFY_WEBHOOK_SECRET
3. **Test `/health` endpoint** — proves backend is running
4. **Create a test order** — proves webhook is connected
5. **Query Supabase directly** — confirms database is accessible

---

## Key Decisions Made

1. **Custom backend instead of Recharge** → saves $25/month, full control, fits prepaid model better
2. **Supabase instead of local Postgres** → zero DevOps, auto-scaling, cheaper than RDS
3. **Render for deployment** → simplest GitHub integration, cheapest Node.js hosting
4. **30-day intervals for shipments** → matches "monthly deliveries" promise to customers
5. **HMAC webhook verification** → prevents order spoofing attacks
6. **Prepaid totals stored, per-month prices calculated** → honest billing, no recurring charges

---

**Document Version:** 1.0  
**Last Updated:** August 6, 2026  
**Status:** Webhook + backend live, awaiting SPX + dashboard
