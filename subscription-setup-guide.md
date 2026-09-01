# B&B BEAU+ Subscription System Setup Guide

**Updated:** September 1, 2026

**Status:** Shopify admin and backend workflow implemented. SellerCraft
synchronized Shopify test order #1005 to Anchanto, and Shopify cancellation
also synchronized successfully. The order entered the expected out-of-stock
problem state because warehouse inventory was zero. SPX account verification,
order creation, tracking retrieval, and AWB PDF generation all passed in UAT.
Google Drive/Sheet automation is implemented in code but still needs client
credentials and one live integration test.

## System purpose

The store sells two ordinary products and two prepaid monthly-delivery products.
Customers pay through the normal Shopify checkout. The custom app records every
order for fulfillment, while only prepaid plan purchases create subscriptions
and future scheduled deliveries.

Current variant rules:

- Ordinary variants: `7 Sachets`, `14 Sachets`, and `28 Sachets`. These create
  one-time shipment rows but must not create subscriptions.
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
                 +--> ordinary variant: one-time fulfillment shipment
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
- Separate ordinary-order and subscription-delivery queues in the dashboard.
- Physical-box and parcel-weight calculation at 188 g per box (1/2/4 boxes for
  7/14/28 sachets; 4 boxes or 0.752 kg per monthly prepaid delivery).
- Calendar-month schedule generation in PostgreSQL/Supabase.
- Shipment 1 linking to the original checkout order.
- Retryable, tagged zero-value Shopify orders for shipment 2 onward.
- Manual Ninja Van packed confirmation for the managed SellerCraft connection,
  plus mock OMS/WMS progression for isolated testing.
- Signed SPX API 1.4 batch order submission, API 1.5 tracking retrieval, and API
  1.6 AWB retrieval.
- Signed SPX tracking webhook with replay protection and automatic shipment
  status updates.
- Signed SPX evidence webhook that stores permanent pickup, delivery, return,
  and handling-proof URLs without duplicating the files in Drive.
- SPX UAT address isolation so real customer addresses are never sent to UAT.
- SPX mass-order Excel generation only after warehouse status is `packed`.
- Manual SPX tracking and optional HTTPS AWB PDF recording.
- Optional automatic Drive archival and retry-safe Google Sheet upsert after
  SPX API 1.6 completes.
- AWB handoff state, Shopify fulfillment action, manual status changes, and
  subscription cancellation.
- Shopify order-cancellation webhook for matching pending shipments.
- Customer SMS disabled by default; Shopify handles customer notifications.

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

## SellerCraft and Anchanto status

Ninja Van's team manages the SellerCraft account/connection. They requested
Shopify access to products, orders, inventory, and locations. Use a dedicated
staff account or custom role rather than sharing the store owner's password when
possible.

Completed validation:

1. Ninja Van connected Shopify to SellerCraft using the approved access token
   and staff access.
2. Product and order synchronization are enabled.
3. A paid, unfulfilled Shopify test order synchronized to Anchanto.
4. Anchanto correctly identified the mapped SKU and placed the order in
   `Problem` because no warehouse stock was available.
5. Cancelling the Shopify order synchronized the cancellation to Anchanto.
6. Shopify SKUs and Anchanto Product Master SKUs were updated to match.

Current operating rules:

- Notify Ninja Van before creating or changing test SKUs/orders because synced
  orders can be dispatched once warehouse stock exists.
- Product price edits can synchronize; coordinate material catalog changes.
- Do not enable pre-orders until Ninja Van confirms the Product Master,
  inventory/hold behavior, and release process.
- Packed confirmation remains manual in this app because there is no direct
  Anchanto status API contract.

## SPX status and testing

SPX supplied UAT app credentials and documentation. Keep all real credentials
only in local or hosted environment variables; never paste them into Git or
documentation.

The separate `spx-test` client:

- matches SPX's published HMAC-SHA256 signature test vector;
- sends `app-id`, `timestamp`, `random-num`, and `check-sign` headers;
- preserves the exact signed JSON body and `int64` user IDs;
- successfully created and verified the SPX UAT user account;
- successfully created a UAT order, retrieved its tracking number, and
  generated the AWB PDF.

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
pickup must not be enabled until SPX confirms the supplied Ninja Van warehouse
address hierarchy and the pickup-timeslot flow is implemented and verified.

For live credential provisioning, provide SPX this callback URL:

```text
https://shopify-subscription-backend.onrender.com/spx/webhooks/tracking
```

Configure the live app ID/secret before their callback test. The backend must
be on an always-on Render instance because SPX requires an HTTP 200 response
within three seconds and can stop callbacks after repeated timeouts.

Provide SPX the separate evidence callback URL:

```text
https://shopify-subscription-backend.onrender.com/spx/webhooks/evidence
```

SPX confirmed that evidence URLs do not expire. The app stores only those URLs
and event metadata in PostgreSQL and displays them in authenticated Shopify
admin, so no additional file-storage service is required.

## Google AWB monitoring status

The backend can automatically download the temporary SPX AWB PDF, archive it in
Google Drive, and add or update a Google Sheet row keyed by shipment ID. It
preserves a warehouse-edited print status and excludes customer PII.

Still required:

1. Create or select the client's Google Cloud project.
2. Enable Google Drive API and Google Sheets API.
3. Create a service account and keep its JSON key only in backend secrets.
4. Create a private/shared AWB Drive folder and an `AWB Monitoring` Sheet tab.
   Keep columns A-K available; the backend writes the headers automatically.
5. Share both with the service-account email and Ninja Van's approved accounts.
6. Configure `GOOGLE_AWB_MODE=api`,
   `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`, `GOOGLE_DRIVE_FOLDER_ID`, and
   `GOOGLE_SHEET_ID` on the backend host.
7. Run one dashboard SPX UAT booking through Drive upload and Sheet upsert.

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
- Ordinary one-time products create fulfillment shipment rows and receive the
  same SPX booking and Google AWB workflow without becoming subscriptions.
- The webhook does not yet enforce paid financial status.
- The Shopify `Order cancellation` webhook must be registered separately for
  automatic cancellation of matching pending internal records.
- SellerCraft/Anchanto exposes no direct API to this app, so packed and AWB-shared
  states are operator-confirmed in `OMS_MODE=manual`.
- Live SPX pickup still needs API 1.1 timeslot selection and confirmation of
  SPX's exact hierarchy for the supplied Ninja Van Cabuyao warehouse address.
- Each recurring plan SKU must be mapped in Anchanto to the correct physical
  monthly pack; different 1/3/6/12-month SKUs do not automatically share stock.
- Dashboard list endpoints do not yet paginate.

## Prioritized next actions

1. Request SPX production credentials, production base URL, account activation,
   and go-live requirements.
2. Confirm the Cabuyao warehouse address hierarchy and final pickup process,
   then implement and verify SPX API 1.1 timeslot selection.
3. Configure Google Drive/Sheets credentials and complete one live UAT archive.
4. Confirm Ninja Van's pre-order hold/release rules before accepting pre-orders.
5. Add paid-status handling, route-level integration
   tests, pagination, and dependency-security remediation.

## Security reminders

- Never send store-owner passwords, Shopify tokens, Shopify client secrets, SPX
  secrets, or customer data in public group chats.
- Rotate any token or secret exposed in a screenshot or message.
- Keep `.env` files out of Git and use different secrets for Shopify, dashboard
  authentication, SPX, OMS/WMS, and SMS.
