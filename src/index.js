require('dotenv').config();
const express = require('express');
const cors = require('cors');

const verifyShopifyWebhook = require('./utils/verifyShopifyWebhook');
const shopifyOrdersWebhook = require('./webhooks/shopifyOrders');
const shipmentsRoutes = require('./routes/shipments');
const subscriptionsRoutes = require('./routes/subscriptions');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// --- Webhook route needs RAW body for HMAC verification, so it's
// registered BEFORE the global JSON body parser below, with its own
// raw-body middleware attached directly to this path only. ---
app.use(
  '/webhooks',
  express.raw({ type: 'application/json' }),
  verifyShopifyWebhook,
  shopifyOrdersWebhook
);

// Everything else uses normal JSON parsing
app.use(express.json());

app.use('/api/shipments', shipmentsRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
