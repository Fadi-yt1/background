'use strict';

/**
 * The background-removal request, expressed without any web framework.
 *
 * Both entry points use this: `server.js` for local development and
 * self-hosting, and `api/remove-background.js` when running on Vercel. Keeping
 * one implementation means the validation and the credential handling cannot
 * drift between the two.
 */

const { removeBackground, PhotoRoomError } = require('./photoroom');

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);

/** Strips directories and control characters from a client-supplied filename. */
function safeFilename(value) {
  if (typeof value !== 'string' || !value) return 'upload.png';
  const base = value.split(/[/\\]/).pop() || 'upload.png';
  // Control bytes must never reach the upstream multipart form.
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || 'upload.png';
}

function contentTypeOf(headers) {
  const raw = headers['content-type'] || headers['Content-Type'] || '';
  return String(raw).split(';')[0].trim().toLowerCase();
}

/**
 * Validates an upload and returns the transparent PNG for it.
 *
 * @param {Buffer} body raw image bytes
 * @param {object} headers incoming request headers
 * @param {object} config resolved app config
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
async function cutout(body, headers, config) {
  const type = contentTypeOf(headers);

  if (!body || body.length === 0) {
    throw new PhotoRoomError('No image was uploaded.', { status: 400 });
  }
  if (!ACCEPTED_TYPES.has(type)) {
    throw new PhotoRoomError('Please upload a PNG, JPEG, WebP, or HEIC image.', { status: 415 });
  }
  if (body.length > config.maxUploadBytes) {
    const limit = Math.round(config.maxUploadBytes / (1024 * 1024));
    throw new PhotoRoomError(`That image is larger than the ${limit} MB limit.`, { status: 413 });
  }

  return removeBackground(body, safeFilename(headers['x-file-name']), config);
}

/** Reads a Node request stream into a Buffer, stopping early past the limit. */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        // Abandon the upload rather than buffering something oversized.
        req.destroy();
        const limit = Math.round(limitBytes / (1024 * 1024));
        reject(new PhotoRoomError(`That image is larger than the ${limit} MB limit.`, { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = { cutout, readBody, safeFilename, ACCEPTED_TYPES };
