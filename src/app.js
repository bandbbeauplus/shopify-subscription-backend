const express = require('express');
const cors = require('cors');

const verifyShopifyWebhook = require('./middleware/verifyShopifyWebhook');
const errorHandler = require('./middleware/errorHandler');
const notFound = require('./middleware/notFound');
const shopifyOrdersWebhook = require('./webhooks/shopifyOrders');
const shipmentsRoutes = require('./routes/shipments');
const subscriptionsRoutes = require('./routes/subscriptions');

function createApp() {
  const app = express();

  // Intentionally unrestricted during testing. Add an allow-list before production.
  app.use(cors());
  app.disable('x-powered-by');

  // Shopify HMAC verification must receive the exact raw request body.
  app.use(
    '/webhooks',
    express.raw({ type: 'application/json', limit: '1mb' }),
    verifyShopifyWebhook,
    shopifyOrdersWebhook
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.use('/api/shipments', shipmentsRoutes);
  app.use('/api/subscriptions', subscriptionsRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
