'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { seal, open, redact } = require('../lib/secure-store');
const { loadConfig } = require('../lib/config');
const { createApp } = require('../server');

const PASSPHRASE = 'a-passphrase-of-sufficient-length';
const LIVE_KEY = 'sk_pr_test_live_0123456789';
const SANDBOX_KEY = 'sandbox_sk_pr_test_0123456789';

// A one-pixel transparent PNG, used as both the upload and the mock reply.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

/* ------------------------------------------------------------ secure-store */

test('sealed keys round-trip with the right passphrase', () => {
  const blob = seal(LIVE_KEY, PASSPHRASE);
  assert.ok(blob.startsWith('v1.'));
  assert.ok(!blob.includes(LIVE_KEY), 'ciphertext must not contain the plaintext key');
  assert.equal(open(blob, PASSPHRASE), LIVE_KEY);
});

test('a wrong passphrase fails without hinting why', () => {
  const blob = seal(LIVE_KEY, PASSPHRASE);
  assert.throws(() => open(blob, 'another-passphrase-entirely'), /Check KEY_ENCRYPTION_SECRET/);
});

test('tampering with the ciphertext is detected', () => {
  const parts = seal(LIVE_KEY, PASSPHRASE).split('.');
  parts[4] = Buffer.from('not-the-real-payload').toString('base64url');
  assert.throws(() => open(parts.join('.'), PASSPHRASE), /Unable to decrypt/);
});

test('a short passphrase is rejected outright', () => {
  assert.throws(() => seal(LIVE_KEY, 'short'), /at least 16 characters/);
});

test('redact strips every configured secret', () => {
  const text = `upstream said ${LIVE_KEY} and ${SANDBOX_KEY}`;
  const clean = redact(text, [LIVE_KEY, SANDBOX_KEY]);
  assert.ok(!clean.includes(LIVE_KEY) && !clean.includes(SANDBOX_KEY));
});

/* ------------------------------------------------------------------ config */

test('config decrypts the sealed live key', () => {
  const config = loadConfig({
    KEY_ENCRYPTION_SECRET: PASSPHRASE,
    PHOTOROOM_API_KEY_ENC: seal(LIVE_KEY, PASSPHRASE),
  });
  assert.equal(config.apiKey, LIVE_KEY);
  assert.equal(config.mode, 'live');
  assert.match(config.keySource, /encrypted/);
});

test('sandbox mode selects the sandbox key', () => {
  const config = loadConfig({
    KEY_ENCRYPTION_SECRET: PASSPHRASE,
    PHOTOROOM_API_KEY_ENC: seal(LIVE_KEY, PASSPHRASE),
    PHOTOROOM_SANDBOX_API_KEY_ENC: seal(SANDBOX_KEY, PASSPHRASE),
    PHOTOROOM_MODE: 'sandbox',
  });
  assert.equal(config.apiKey, SANDBOX_KEY);
  assert.equal(config.mode, 'sandbox');
});

test('an encrypted key without a passphrase is a startup error', () => {
  assert.throws(
    () => loadConfig({ PHOTOROOM_API_KEY_ENC: seal(LIVE_KEY, PASSPHRASE) }),
    /KEY_ENCRYPTION_SECRET is missing/
  );
});

test('no key at all is a startup error', () => {
  assert.throws(() => loadConfig({}), /No live PhotoRoom API key is configured/);
});

test('the key fingerprint never contains the whole key', () => {
  const config = loadConfig({ PHOTOROOM_API_KEY: LIVE_KEY });
  assert.ok(!config.keyFingerprint.includes(LIVE_KEY));
});

/* ------------------------------------------------------------------ server */

/** Starts a stand-in for the PhotoRoom API and records what it receives. */
async function startUpstream(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1/segment`, received, server };
}

async function startApp(upstreamUrl, overrides = {}) {
  const config = loadConfig({
    KEY_ENCRYPTION_SECRET: PASSPHRASE,
    PHOTOROOM_API_KEY_ENC: seal(LIVE_KEY, PASSPHRASE),
    PHOTOROOM_API_URL: upstreamUrl,
    RATE_LIMIT_MAX: '100',
    ...overrides,
  });
  const server = createApp(config).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, server };
}

function upload(base, { bytes = PNG, type = 'image/png', name = 'photo.png' } = {}) {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type }), name);
  return fetch(`${base}/api/remove-background`, { method: 'POST', body: form });
}

test('a successful cutout is proxied back to the browser', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  const app = await startApp(upstream.url);
  t.after(() => {
    app.server.close();
    upstream.server.close();
  });

  const response = await upload(app.base);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await response.arrayBuffer()).length, PNG.length);

  // The key is attached server-side, on the upstream call only.
  assert.equal(upstream.received[0].headers['x-api-key'], LIVE_KEY);
});

test('the browser never receives the API key', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  const app = await startApp(upstream.url);
  t.after(() => {
    app.server.close();
    upstream.server.close();
  });

  for (const path of ['/', '/app.js', '/styles.css', '/api/health']) {
    const response = await fetch(`${app.base}${path}`);
    const body = await response.text();
    assert.ok(!body.includes(LIVE_KEY), `${path} leaked the API key`);
    assert.ok(!body.includes('x-api-key'), `${path} mentions the key header`);
  }

  const cutout = await upload(app.base);
  const headerDump = JSON.stringify([...cutout.headers]);
  assert.ok(!headerDump.includes(LIVE_KEY), 'response headers leaked the API key');
});

test('upstream failures become safe, generic messages', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    // A hostile or careless upstream might echo the key back at us.
    res.end(JSON.stringify({ detail: `invalid key ${LIVE_KEY}` }));
  });
  const app = await startApp(upstream.url);
  t.after(() => {
    app.server.close();
    upstream.server.close();
  });

  const response = await upload(app.base);
  const body = await response.text();
  assert.equal(response.status, 502);
  assert.ok(!body.includes(LIVE_KEY), 'the error response leaked the API key');
  assert.match(body, /rejected our credentials/);
});

test('non-image uploads are refused before any upstream call', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  const app = await startApp(upstream.url);
  t.after(() => {
    app.server.close();
    upstream.server.close();
  });

  const response = await upload(app.base, { bytes: Buffer.from('#!/bin/sh'), type: 'text/plain', name: 'x.sh' });
  assert.equal(response.status, 415);
  assert.equal(upstream.received.length, 0, 'the upstream should not have been called');
});

test('oversized uploads are refused with the configured limit', async (t) => {
  const upstream = await startUpstream((req, res) => res.end(PNG));
  const app = await startApp(upstream.url, { MAX_UPLOAD_MB: '1' });
  t.after(() => {
    app.server.close();
    upstream.server.close();
  });

  const response = await upload(app.base, { bytes: Buffer.alloc(2 * 1024 * 1024, 1) });
  assert.equal(response.status, 413);
  assert.match(await response.text(), /larger than the 1 MB limit/);
});

test('a request with no file is rejected', async (t) => {
  const upstream = await startUpstream((req, res) => res.end(PNG));
  const app = await startApp(upstream.url);
  t.after(() => {
    app.server.close();
    upstream.server.close();
  });

  const response = await fetch(`${app.base}/api/remove-background`, { method: 'POST', body: new FormData() });
  assert.equal(response.status, 400);
});

test('transient upstream errors are retried', async (t) => {
  let calls = 0;
  const upstream = await startUpstream((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(503);
      res.end('temporarily unavailable');
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  const app = await startApp(upstream.url);
  t.after(() => {
    app.server.close();
    upstream.server.close();
  });

  const response = await upload(app.base);
  assert.equal(response.status, 200);
  assert.equal(calls, 2, 'the failed attempt should have been retried once');
});

test('health exposes limits but no credentials', async (t) => {
  const upstream = await startUpstream((req, res) => res.end(PNG));
  const app = await startApp(upstream.url);
  t.after(() => {
    app.server.close();
    upstream.server.close();
  });

  const health = await (await fetch(`${app.base}/api/health`)).json();
  assert.deepEqual(Object.keys(health).sort(), ['maxUploadBytes', 'mode', 'status']);
});

test('security headers are set on the page', async (t) => {
  const upstream = await startUpstream((req, res) => res.end(PNG));
  const app = await startApp(upstream.url);
  t.after(() => {
    app.server.close();
    upstream.server.close();
  });

  const response = await fetch(`${app.base}/`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
});
