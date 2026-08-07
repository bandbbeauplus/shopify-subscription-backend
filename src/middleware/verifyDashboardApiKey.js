const crypto = require('crypto');

function verifyDashboardApiKey(req, res, next) {
  const configuredKey = process.env.DASHBOARD_API_KEY;
  if (!configuredKey) {
    return res.status(503).json({ error: 'Dashboard API access is not configured' });
  }

  const suppliedKey = req.get('X-Dashboard-Key') || '';
  const expected = Buffer.from(configuredKey);
  const supplied = Buffer.from(suppliedKey);
  const matches = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);

  if (!matches) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

module.exports = verifyDashboardApiKey;
