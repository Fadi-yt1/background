'use strict';

/**
 * Thin server-side client for the PhotoRoom segmentation endpoint.
 *
 * This is the only place the API key is attached to an outbound request, and it
 * runs exclusively on the server.
 */

const { redact } = require('./secure-store');

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Maps upstream failures onto messages that are safe and useful to show a visitor. */
function describeFailure(status, body) {
  switch (status) {
    case 400:
      return 'PhotoRoom could not read that image. Try a different file.';
    case 401:
    case 403:
      return 'The background service rejected our credentials. Please try again later.';
    case 402:
      return 'The background-removal quota for this site has been used up.';
    case 413:
      return 'That image is too large for the background service.';
    case 429:
      return 'Too many requests are hitting the background service. Give it a moment and retry.';
    default:
      return body
        ? `The background service returned an error (${status}).`
        : `The background service is unavailable (${status}).`;
  }
}

class PhotoRoomError extends Error {
  constructor(message, { status = 502, retryable = false } = {}) {
    super(message);
    this.name = 'PhotoRoomError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Removes the background from `buffer` and resolves with a transparent PNG.
 *
 * @param {Buffer} buffer raw image bytes
 * @param {string} filename original filename, forwarded for upstream diagnostics
 * @param {object} config resolved app config
 */
async function removeBackground(buffer, filename, config, { attempts = 3 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestOnce(buffer, filename, config);
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt === attempts) break;
      // Back off before retrying a transient upstream failure: 400ms, 800ms, …
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempt - 1)));
    }
  }

  throw lastError;
}

async function requestOnce(buffer, filename, config) {
  const form = new FormData();
  form.append('image_file', new Blob([buffer]), filename || 'upload.png');
  form.append('format', 'png');

  let response;
  try {
    response = await fetch(config.upstreamUrl, {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        Accept: 'image/png, application/json',
      },
      body: form,
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new PhotoRoomError(
      timedOut
        ? 'The background service took too long to respond. Please try again.'
        : 'Could not reach the background service. Please try again.',
      { status: timedOut ? 504 : 502, retryable: true }
    );
  }

  if (!response.ok) {
    // Read the body for our own logs only — it is never forwarded verbatim.
    const detail = redact(await response.text().catch(() => ''), config.allSecrets);
    if (detail) {
      console.warn(`[photoroom] ${response.status} ${detail.slice(0, 500)}`);
    }
    throw new PhotoRoomError(describeFailure(response.status, detail), {
      status: response.status === 429 ? 429 : 502,
      retryable: RETRYABLE_STATUS.has(response.status),
    });
  }

  const result = Buffer.from(await response.arrayBuffer());
  if (result.length === 0) {
    throw new PhotoRoomError('The background service returned an empty image.', {
      status: 502,
      retryable: true,
    });
  }

  return {
    buffer: result,
    contentType: response.headers.get('content-type') || 'image/png',
    creditsRemaining: response.headers.get('x-credits-remaining'),
  };
}

module.exports = { removeBackground, PhotoRoomError, describeFailure };
