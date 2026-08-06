const crypto = require('crypto');

function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!hmacHeader || !secret || !Buffer.isBuffer(req.body)) {
    return res.status(401).send('Unauthorized');
  }

  const expected = crypto.createHmac('sha256', secret).update(req.body).digest();
  const received = Buffer.from(hmacHeader, 'base64');

  if (received.length !== expected.length || !crypto.timingSafeEqual(expected, received)) {
    return res.status(401).send('Unauthorized');
  }

  try {
    req.body = JSON.parse(req.body.toString('utf8'));
  } catch (error) {
    return res.status(400).send('Invalid JSON');
  }

  next();
}

module.exports = verifyShopifyWebhook;
