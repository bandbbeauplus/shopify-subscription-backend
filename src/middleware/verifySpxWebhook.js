const crypto = require('node:crypto');
const { generateCheckSign } = require('../services/spxClient');

function configuredValue(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function safeHexEqual(expected, received) {
  if (!/^[a-f0-9]{64}$/i.test(String(received || ''))) return false;
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(received, 'hex');
  return receivedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function verifySignature({
  appId,
  timestamp,
  randomNum,
  checkSign,
  rawBody,
  nowSeconds = Math.floor(Date.now() / 1000),
  expectedAppId = configuredValue('SPX_WEBHOOK_APP_ID', process.env.SPX_APP_ID),
  appSecret = configuredValue('SPX_WEBHOOK_APP_SECRET', process.env.SPX_APP_SECRET),
}) {
  if (!expectedAppId || !appSecret || String(appId || '') !== expectedAppId) return false;
  if (!/^\d+$/.test(String(timestamp || '')) || !/^\d+$/.test(String(randomNum || ''))) return false;

  const timestampNumber = Number(timestamp);
  const maximumAge = Number(configuredValue('SPX_WEBHOOK_MAX_AGE_SECONDS', '600'));
  if (!Number.isSafeInteger(timestampNumber) || !Number.isFinite(maximumAge) || maximumAge < 60) return false;
  if (Math.abs(nowSeconds - timestampNumber) > maximumAge) return false;

  const expected = generateCheckSign({
    appId: expectedAppId,
    appSecret,
    timestamp: String(timestamp),
    randomNum: String(randomNum),
    body: rawBody.toString('utf8'),
  });
  return safeHexEqual(expected, checkSign);
}

function verifySpxWebhook(req, res, next) {
  if (!Buffer.isBuffer(req.body)) return res.status(401).send('Unauthorized');
  const valid = verifySignature({
    appId: req.get('app-id'),
    timestamp: req.get('timestamp'),
    randomNum: req.get('random-num'),
    checkSign: req.get('check-sign'),
    rawBody: req.body,
  });
  if (!valid) return res.status(401).send('Unauthorized');

  try {
    req.body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }
  next();
}

module.exports = { safeHexEqual, verifySignature, verifySpxWebhook };
