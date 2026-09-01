const test = require('node:test');
const assert = require('node:assert/strict');
const { generateCheckSign } = require('../services/spxClient');
const { verifySignature } = require('./verifySpxWebhook');

test('accepts an SPX signature over the exact raw webhook body', () => {
  const rawBody = Buffer.from('{"id":"event-1","status_code":"1001"}');
  const timestamp = '1788220800';
  const randomNum = '12345';
  const checkSign = generateCheckSign({
    appId: '1000622', appSecret: 'test-secret', timestamp, randomNum, body: rawBody.toString('utf8'),
  });
  assert.equal(verifySignature({
    appId: '1000622', timestamp, randomNum, checkSign, rawBody, nowSeconds: 1788220800,
    expectedAppId: '1000622', appSecret: 'test-secret',
  }), true);
});

test('rejects a modified body and stale callback timestamp', () => {
  const signedBody = Buffer.from('{"id":"event-1"}');
  const timestamp = '1788220800';
  const randomNum = '12345';
  const checkSign = generateCheckSign({
    appId: '1000622', appSecret: 'test-secret', timestamp, randomNum, body: signedBody.toString('utf8'),
  });
  assert.equal(verifySignature({
    appId: '1000622', timestamp, randomNum, checkSign,
    rawBody: Buffer.from('{"id":"event-2"}'), nowSeconds: 1788220800,
    expectedAppId: '1000622', appSecret: 'test-secret',
  }), false);
  assert.equal(verifySignature({
    appId: '1000622', timestamp, randomNum, checkSign, rawBody: signedBody, nowSeconds: 1788222000,
    expectedAppId: '1000622', appSecret: 'test-secret',
  }), false);
});
