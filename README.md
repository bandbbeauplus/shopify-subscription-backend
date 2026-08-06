# Subscription Backend (b&b BEAU+)

Tracks prepaid Shopify subscription orders (1/3/6/12 month plans), generates
a shipment schedule per order, and gives you a dashboard-ready API to manage
fulfillment + SPX handoff.

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

1. Ask SPX support if a merchant API exists (vs. manual/CSV-only entry)
2. If yes: update the request body/auth in `create-spx` to match their docs
3. If no: replace that function with logic that generates a CSV matching
   their "Import to Mass Edit" format (seen in your SPX app screenshot) —
   happy to build that version once you confirm which path SPX supports

## Next steps once this is running

- Build the actual dashboard UI (React) that calls these endpoints
- Add auth (this API has none right now — anyone with the URL can hit it)
- Add a cron job to catch shipments whose date passed without action, and
  alert your team (Slack webhook, email, etc.)
