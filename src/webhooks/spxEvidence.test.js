const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEvidenceUrls, validEvidencePayload } = require('./spxEvidence');

test('keeps unique HTTPS evidence URLs and rejects unsafe values', () => {
  assert.deepEqual(normalizeEvidenceUrls([
    'https://proof.spx.ph/pickup/1.jpg',
    'http://proof.spx.ph/insecure.jpg',
    'not-a-url',
    'https://proof.spx.ph/pickup/1.jpg',
  ]), ['https://proof.spx.ph/pickup/1.jpg']);
  assert.equal(normalizeEvidenceUrls(['http://proof.spx.ph/insecure.jpg']), null);
});

test('accepts proof updates identified by tracking number or customer order ID', () => {
  const payload = validEvidencePayload({
    id: 'proof-event-1',
    tracking_no: 'SPEPH123',
    epod_list: ['https://proof.spx.ph/delivery/1.jpg'],
  });
  assert.equal(payload.eventId, 'proof-event-1');
  assert.deepEqual(payload.evidence.epod_list, ['https://proof.spx.ph/delivery/1.jpg']);
  assert.equal(validEvidencePayload({ id: 'proof-event-2', epod_list: [] }), null);
});
