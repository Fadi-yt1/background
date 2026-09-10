'use strict';

/**
 * Vercel serverless entry point for the cutout endpoint.
 *
 * Vercel serves `public/` statically and mounts this file at
 * /api/remove-background. The API key is read from the function's environment,
 * decrypted in memory, and never returned to the caller — the same contract the
 * standalone server keeps.
 */

const { loadConfig } = require('../lib/config');
const { cutout, readBody } = require('../lib/cutout');
const { PhotoRoomError } = require('../lib/photoroom');
const { redact } = require('../lib/secure-store');

// Cached across warm invocations so scrypt runs once per instance, not per request.
let cachedConfig;
function getConfig() {
  if (!cachedConfig) cachedConfig = loadConfig();
  return cachedConfig;
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Use POST to submit an image.' });
    return;
  }

  let config;
  try {
    config = getConfig();
  } catch (error) {
    // A misconfigured deployment must not describe its own configuration.
    console.error('[config]', error.message);
    res.status(500).json({ error: 'This site is not configured yet. Please try again later.' });
    return;
  }

  try {
    const body = await readBody(req, config.maxUploadBytes);
    const result = await cutout(body, req.headers, config);

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'inline; filename="cutout.png"');
    res.status(200).send(result.buffer);
  } catch (error) {
    const status = error instanceof PhotoRoomError ? error.status : 500;
    if (status >= 500) {
      console.error('[error]', redact(error.stack || error.message, config.allSecrets));
    }
    res.status(status).json({
      error:
        error instanceof PhotoRoomError
          ? redact(error.message, config.allSecrets)
          : 'Something went wrong on our side. Please try again.',
    });
  }
}

module.exports = handler;
// Vercel hands us the raw stream only when its own body parsing is disabled.
module.exports.config = { api: { bodyParser: false } };
