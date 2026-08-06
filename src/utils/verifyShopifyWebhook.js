const crypto = require('crypto');

/**
 * Shopify signs every webhook with your webhook secret.
 * WITHOUT this check, anyone who finds your webhook URL could fake
 * "order created" events and pollute your shipments table.
 *
 * This must run on the RAW body (before JSON parsing), so index.js
 * uses express.raw() specifically on the webhook route.
 */
function verifyShopifyWebhook(req, res, next) {
  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

    if (!hmacHeader || !secret) {
      console.warn('⚠️ Missing HMAC header or secret — rejecting webhook');
      return res.status(401).send('Unauthorized');
    }

    const generatedHash = crypto
      .createHmac('sha256', secret)
      .update(req.body) // raw buffer
      .digest('base64');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(generatedHash),
      Buffer.from(hmacHeader)
    );

    if (!isValid) {
      console.warn('⚠️ Invalid webhook signature — rejecting');
      return res.status(401).send('Unauthorized');
    }

    // Parse the raw buffer into JSON now that it's verified
    req.body = JSON.parse(req.body.toString('utf8'));
    next();
  } catch (err) {
    console.error('Webhook verification error:', err);
    res.status(401).send('Unauthorized');
  }
}

module.exports = verifyShopifyWebhook;
