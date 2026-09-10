/**
 * Netlify function for the cutout endpoint.
 *
 * Netlify serves `public/` as the site and routes /api/remove-background here.
 * The API key is read from the function's environment, decrypted in memory, and
 * never returned to the caller — the same contract the standalone server keeps.
 *
 * The file is deliberately NOT named `remove-background`: Netlify treats any
 * function whose name ends in `-background` as a background function, which
 * returns an empty 202 and throws the cutout away. The public path is set below.
 */

import configModule from '../../lib/config.js';
import cutoutModule from '../../lib/cutout.js';
import photoroomModule from '../../lib/photoroom.js';
import secureStoreModule from '../../lib/secure-store.js';

const { loadConfig } = configModule;
const { cutout } = cutoutModule;
const { PhotoRoomError } = photoroomModule;
const { redact } = secureStoreModule;

// Synchronous Netlify functions cap the response body at 6 MB; refuse just
// under that so the visitor gets an explanation instead of a platform error.
const MAX_RESPONSE_BYTES = 5.5 * 1024 * 1024;

let cachedConfig;

function readEnv() {
  return typeof Netlify === 'undefined' ? process.env : Netlify.env.toObject();
}

function getConfig() {
  if (!cachedConfig) cachedConfig = loadConfig(readEnv());
  return cachedConfig;
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Use POST to submit an image.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', Allow: 'POST' },
    });
  }

  let appConfig;
  try {
    appConfig = getConfig();
  } catch (error) {
    // A misconfigured deployment must not describe its own configuration.
    console.error('[config]', error.message);
    return json({ error: 'This site is not configured yet. Please try again later.' }, 500);
  }

  try {
    const body = Buffer.from(await req.arrayBuffer());
    const headers = {
      'content-type': req.headers.get('content-type') || '',
      'x-file-name': req.headers.get('x-file-name') || '',
    };

    const result = await cutout(body, headers, appConfig);

    if (result.buffer.length > MAX_RESPONSE_BYTES) {
      throw new PhotoRoomError(
        'The finished cutout is too large to send back from this host. Try a smaller image.',
        { status: 413 }
      );
    }

    return new Response(result.buffer, {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': 'no-store',
        'Content-Disposition': 'inline; filename="cutout.png"',
      },
    });
  } catch (error) {
    const status = error instanceof PhotoRoomError ? error.status : 500;
    if (status >= 500) {
      console.error('[error]', redact(error.stack || error.message, appConfig.allSecrets));
    }
    return json(
      {
        error:
          error instanceof PhotoRoomError
            ? redact(error.message, appConfig.allSecrets)
            : 'Something went wrong on our side. Please try again.',
      },
      status
    );
  }
}

export const config = {
  path: '/api/remove-background',
};
