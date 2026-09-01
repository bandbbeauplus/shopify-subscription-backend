const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const createApp = require('./app');

test('exposes the SPX webhook separately and rejects unsigned callbacks', async (context) => {
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/spx/webhooks/tracking`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'unsigned-event' }),
  });
  assert.equal(response.status, 401);
  assert.equal(await response.text(), 'Unauthorized');
});
