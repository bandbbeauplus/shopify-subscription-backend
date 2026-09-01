const express = require('express');
const cors = require('cors');

const verifyShopifyWebhook = require('./middleware/verifyShopifyWebhook');
const { verifySpxWebhook } = require('./middleware/verifySpxWebhook');
const errorHandler = require('./middleware/errorHandler');
const notFound = require('./middleware/notFound');
const shopifyOrdersWebhook = require('./webhooks/shopifyOrders');
const { router: spxTrackingWebhook } = require('./webhooks/spxTracking');
const { router: spxEvidenceWebhook } = require('./webhooks/spxEvidence');
const shipmentsRoutes = require('./routes/shipments');
const subscriptionsRoutes = require('./routes/subscriptions');
const verifyDashboardApiKey = require('./middleware/verifyDashboardApiKey');

function createApp() {
  const app = express();

  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS'));
    }
  }));
  app.disable('x-powered-by');

  // SPX signs the exact raw JSON body with the SPX app secret. This endpoint
  // must remain outside Shopify's HMAC middleware.
  app.use(
    '/spx/webhooks',
    express.raw({ type: 'application/json', limit: '256kb' }),
    verifySpxWebhook,
    spxTrackingWebhook,
    spxEvidenceWebhook
  );

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

  app.use('/api', verifyDashboardApiKey);
  app.use('/api/shipments', shipmentsRoutes);
  app.use('/api/subscriptions', subscriptionsRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
