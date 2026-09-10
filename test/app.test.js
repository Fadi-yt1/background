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
  return fetch(`${base}/api/remove-background`, {
    method: 'POST',
    headers: { 'Content-Type': type, 'X-File-Name': name },
    body: bytes,
  });
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

  const response = await fetch(`${app.base}/api/remove-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
  });
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

/* --------------------------------------------------- serverless entry point */

/**
 * Runs the Vercel handler against a real HTTP server, so it receives a genuine
 * request stream. `res` is shimmed with the helpers Vercel adds to Node's
 * response object.
 */
async function startFunction(handler, env) {
  const server = http.createServer((req, res) => {
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (payload) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
      return res;
    };
    res.send = (payload) => {
      res.end(payload);
      return res;
    };
    Object.assign(process.env, env);
    Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, server };
}

test('the serverless handler returns a cutout and hides the key', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });

  const env = {
    KEY_ENCRYPTION_SECRET: PASSPHRASE,
    PHOTOROOM_API_KEY_ENC: seal(LIVE_KEY, PASSPHRASE),
    PHOTOROOM_API_URL: upstream.url,
  };
  // Loaded after the environment is set, since the module caches its config.
  delete require.cache[require.resolve('../api/remove-background')];
  Object.assign(process.env, env);
  const handler = require('../api/remove-background');
  const fn = await startFunction(handler, env);

  t.after(() => {
    fn.server.close();
    upstream.server.close();
    for (const key of Object.keys(env)) delete process.env[key];
    delete require.cache[require.resolve('../api/remove-background')];
  });

  const response = await fetch(`${fn.base}/api/remove-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-File-Name': 'photo.png' },
    body: PNG,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(upstream.received[0].headers['x-api-key'], LIVE_KEY);
  assert.ok(!JSON.stringify([...response.headers]).includes(LIVE_KEY));
});

test('the serverless handler rejects a GET', async (t) => {
  const handler = require('../api/remove-background');
  const fn = await startFunction(handler, {});
  t.after(() => fn.server.close());

  const response = await fetch(`${fn.base}/api/remove-background`);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
});

test('the serverless handler refuses a non-image body', async (t) => {
  const env = {
    KEY_ENCRYPTION_SECRET: PASSPHRASE,
    PHOTOROOM_API_KEY_ENC: seal(LIVE_KEY, PASSPHRASE),
  };
  delete require.cache[require.resolve('../api/remove-background')];
  Object.assign(process.env, env);
  const handler = require('../api/remove-background');
  const fn = await startFunction(handler, env);

  t.after(() => {
    fn.server.close();
    for (const key of Object.keys(env)) delete process.env[key];
    delete require.cache[require.resolve('../api/remove-background')];
  });

  const response = await fetch(`${fn.base}/api/remove-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'not an image',
  });
  assert.equal(response.status, 415);
});

/* ------------------------------------------------------------ upload limits */

test('the advertised upload limit stays under Vercel body cap', () => {
  const { resolveUploadLimit } = require('../lib/config');
  assert.equal(resolveUploadLimit({}), 12 * 1024 * 1024);
  assert.equal(resolveUploadLimit({ VERCEL: '1' }), 4 * 1024 * 1024);
  // An explicit request below the cap is honoured as-is.
  assert.equal(resolveUploadLimit({ VERCEL: '1', MAX_UPLOAD_MB: '2' }), 2 * 1024 * 1024);
});

test('filenames from headers are stripped of paths', () => {
  const { safeFilename } = require('../lib/cutout');
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('C:\\Users\\me\\photo.png'), 'photo.png');
  assert.equal(safeFilename(undefined), 'upload.png');
});

test('a broken inactive key does not stop startup', () => {
  // Live mode with a sandbox blob sealed under a different passphrase.
  const config = loadConfig({
    KEY_ENCRYPTION_SECRET: PASSPHRASE,
    PHOTOROOM_API_KEY_ENC: seal(LIVE_KEY, PASSPHRASE),
    PHOTOROOM_SANDBOX_API_KEY_ENC: seal(SANDBOX_KEY, 'a-completely-different-passphrase'),
  });
  assert.equal(config.apiKey, LIVE_KEY);
  assert.deepEqual(config.allSecrets, [LIVE_KEY]);
});

test('a broken active key does stop startup', () => {
  assert.throws(
    () =>
      loadConfig({
        KEY_ENCRYPTION_SECRET: PASSPHRASE,
        PHOTOROOM_API_KEY_ENC: seal(LIVE_KEY, 'a-completely-different-passphrase'),
      }),
    /Unable to decrypt/
  );
});
