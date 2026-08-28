# B&B BEAU+ Subscription System Setup Guide

**Updated:** August 22, 2026

**Status:** Shopify admin and backend workflow implemented; SPX UAT account and
API access verified. SellerCraft/Anchanto SKU mapping and end-to-end order tests
still require coordination with Ninja Van.

## System purpose

The store sells two ordinary products and two prepaid monthly-delivery products.
Customers pay the complete plan price through the normal Shopify checkout. The
custom app records only prepaid plan purchases and schedules their deliveries.

Current variant rules:

- Ordinary variants: `7 Sachets`, `14 Sachets`, and `28 Sachets`. These remain
  normal Shopify orders and must not create subscriptions.
- Prepaid variants: titles beginning with `1-Month Plan`, `3-Month Plan`,
  `6-Month Plan`, or `12-Month Plan`. These create 1, 3, 6, or 12 scheduled
  shipments.
- SKU codes are used for SellerCraft/Anchanto mapping and Shopify variant
  resolution. They may change, so recurrence is determined by variant title,
  not SKU.

## Current architecture

```text
Customer checks out in Shopify
        |
        +--> SellerCraft OMS imports the Shopify order
        |        |
        |        +--> Anchanto WMS receives it for picking and packing
        |
        +--> Signed Shopify webhook reaches the Express backend
                 |
                 +--> ordinary variant: ignored by subscription system
                 |
                 +--> prepaid plan: subscription + calendar-month schedule

Shipment 1: link the original Shopify checkout order
Shipment 2+: create a tagged, zero-value Shopify delivery order
        |
SellerCraft imports the due order -> Anchanto packs it
        |
After packed confirmation, book SPX and receive tracking/AWB
        |
Archive the AWB in Google Drive and upsert the Ninja Van monitoring Sheet

Notify the warehouse for printing and pickup preparation
        |
SPX performs last-mile delivery and supplies customer tracking
```

SellerCraft is the OMS connector, Anchanto is Ninja Van's WMS, and SPX is the
selected last-mile courier. Ninja Van has confirmed SPX is not currently
integrated with Anchanto, so the app/shipper must arrange SPX booking and provide
the AWB to the warehouse.

## Implemented components

- Shopify embedded admin pages: Overview, Shipments, and Subscriptions.
- Shopify session authentication and server-only backend proxy.
- Theme app block for selecting prepaid plan variants before Shopify checkout.
- Raw-body Shopify HMAC verification and duplicate-order protection.
- Strict variant-title detection that ignores ordinary sachet variants.
- Calendar-month schedule generation in PostgreSQL/Supabase.
- Shipment 1 linking to the original checkout order.
- Retryable, tagged zero-value Shopify orders for shipment 2 onward.
- Manual Ninja Van packed confirmation for the managed SellerCraft connection,
  plus mock OMS/WMS progression for isolated testing.
- Signed SPX API 1.4 batch order submission, API 1.5 tracking retrieval, and API
  1.6 AWB retrieval.
- SPX UAT address isolation so real customer addresses are never sent to UAT.
- SPX mass-order Excel generation only after warehouse status is `packed`.
- Manual SPX tracking and optional HTTPS AWB PDF recording.
- Optional automatic Drive archival and retry-safe Google Sheet upsert after
  SPX API 1.6 completes.
- AWB handoff state, Shopify fulfillment action, manual status changes, and
  subscription cancellation.

## Required configuration

### Frontend service

Set the values documented in `subscription-frontend/.env.example`. Important
items are the Shopify app credentials and URL, the Express backend URL, and the
private shared API key.

Required Shopify scopes:

```text
read_products,read_orders,write_orders,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders
```

Deploy Shopify configuration and the theme extension with:

```powershell
npm run deploy -- --config bb-subscription-dashboard
```

### Backend service

Set the values documented in `.env.example`. `DASHBOARD_API_KEY` must exactly
match the frontend's `SUBSCRIPTION_API_KEY`. Use `OMS_MODE=manual` for the
current managed SellerCraft/Anchanto integration. Set `SPX_MODE=api` only after
all required SPX values in `.env.example` are configured.

The backend startup command applies the backward-compatible statements in
`schema.sql` before serving requests.

For UAT, use `SPX_ENVIRONMENT=uat` and
`SPX_API_BASE_URL=https://test-stable.spx.ph`. The service automatically uses
the approved Amsic-to-Agsam address profile. Configure only test phone numbers
and SPX-confirmed postal codes; never use real customer data in UAT.

## SellerCraft and Anchanto setup

Ninja Van's team manages the SellerCraft account/connection. They requested
Shopify access to products, orders, inventory, and locations. Use a dedicated
staff account or custom role rather than sharing the store owner's password when
possible.

Before placing a test order:

1. Assign a unique SKU to the chosen test variant.
2. Ask Ninja Van to confirm that SKU is synchronized and mapped in both
   SellerCraft and Anchanto.
3. Confirm the invited staff account has been accepted; `Pending` means access
   is not active yet.
4. Create one Shopify test order only after mapping is confirmed.
5. Verify Shopify -> SellerCraft OMS -> Anchanto WMS.
6. Have the warehouse mark the order packed and verify that fulfillment status
   returns through SellerCraft to Shopify.

## SPX status and testing

SPX supplied UAT app credentials and documentation. Keep all real credentials
only in local or hosted environment variables; never paste them into Git or
documentation.

The separate `spx-test` client:

- matches SPX's published HMAC-SHA256 signature test vector;
- sends `app-id`, `timestamp`, `random-num`, and `check-sign` headers;
- preserves the exact signed JSON body and `int64` user IDs;
- successfully created and verified the SPX UAT user account.

The app now follows SPX's asynchronous order flow:

1. Wait for Ninja Van to confirm Anchanto has packed the shipment.
2. In `OMS_MODE=manual`, click **Confirm Ninja Van packed**.
3. Submit API 1.4; the app stores the returned SPX batch number.
4. Check API 1.5 until the task is done and a tracking number is returned.
5. Check API 1.6 until the AWB PDF link is ready.
6. When Google AWB sync is configured, the backend downloads the temporary SPX
   PDF, stores it in Drive, and upserts the monitoring row by shipment ID.
7. Notify Ninja Van and mark the AWB shared only after the warehouse can access
   the Drive PDF.

Excel export and manual tracking confirmation remain available as fallbacks.
UAT defaults to drop-off because pickup requires API 1.1 timeslot values. Live
pickup must not be enabled until Ninja Van supplies the warehouse sender details
and the pickup-timeslot flow is implemented and verified.

## Verification commands

Backend:

```powershell
npm test
npm run migrate
```

Frontend:

```powershell
npm run typecheck
npm run lint
npm run build
```

SPX signing client:

```powershell
npm test
```

Do not run `npm run create-account` as a routine test because it performs a live
UAT mutation.

## Known limitations

- The system is currently single-store and backend records are not shop-scoped.
- Only the first matching prepaid line item in an order creates a subscription;
  carts with multiple prepaid lines need additional modeling.
- The webhook does not yet enforce paid financial status.
- SellerCraft/Anchanto exposes no direct API to this app, so packed and AWB-shared
  states are operator-confirmed in `OMS_MODE=manual`.
- Live SPX pickup still needs API 1.1 timeslot selection and Ninja Van's complete
  warehouse sender information.
- Each recurring plan SKU must be mapped in Anchanto to the correct physical
  monthly pack; different 1/3/6/12-month SKUs do not automatically share stock.
- SMS provider behavior has not been production-verified.
- Dashboard list endpoints do not yet paginate.

## Security reminders

- Never send store-owner passwords, Shopify tokens, Shopify client secrets, SPX
  secrets, or customer data in public group chats.
- Rotate any token or secret exposed in a screenshot or message.
- Keep `.env` files out of Git and use different secrets for Shopify, dashboard
  authentication, SPX, OMS/WMS, and SMS.
