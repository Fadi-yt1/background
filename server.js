'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const { loadConfig } = require('./lib/config');
const { removeBackground, PhotoRoomError } = require('./lib/photoroom');
const { redact } = require('./lib/secure-store');

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);

function createApp(config) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' blob: data:",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "object-src 'none'",
      ].join('; ')
    );
    next();
  });

  const upload = multer({
    storage: multer.memoryStorage(), // Uploads stay in RAM; nothing touches disk.
    limits: { fileSize: config.maxUploadBytes, files: 1 },
    fileFilter(req, file, done) {
      if (!ACCEPTED_TYPES.has(file.mimetype)) {
        done(new PhotoRoomError('Please upload a PNG, JPEG, WebP, or HEIC image.', { status: 415 }));
        return;
      }
      done(null, true);
    },
  });

  const limiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'You have hit the request limit for this site. Please try again later.' },
  });

  app.get('/api/health', (req, res) => {
    // Deliberately reveals nothing about the key beyond whether one is loaded.
    res.json({ status: 'ok', mode: config.mode, maxUploadBytes: config.maxUploadBytes });
  });

  app.post('/api/remove-background', limiter, (req, res, next) => {
    upload.single('image')(req, res, (uploadError) => {
      if (uploadError) return next(uploadError);
      if (!req.file) {
        return next(new PhotoRoomError('No image was uploaded.', { status: 400 }));
      }
      return handleRemoval(req, res, next, config);
    });
  });

  app.use(
    express.static(path.join(__dirname, 'public'), {
      maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
      extensions: ['html'],
    })
  );

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  app.use((error, req, res, next) => {
    const status = resolveStatus(error);
    const message = resolveMessage(error, status, config);

    if (status >= 500) {
      console.error('[error]', redact(error.stack || error.message, config.allSecrets));
    }

    res.status(status).json({ error: message });
  });

  return app;
}

async function handleRemoval(req, res, next, config) {
  const startedAt = Date.now();
  try {
    const result = await removeBackground(req.file.buffer, req.file.originalname, config);

    console.log(
      `[cutout] ${req.file.mimetype} ${(req.file.size / 1024).toFixed(0)}KB -> ` +
        `${(result.buffer.length / 1024).toFixed(0)}KB in ${Date.now() - startedAt}ms`
    );

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'inline; filename="cutout.png"');
    res.send(result.buffer);
  } catch (error) {
    next(error);
  }
}

function resolveStatus(error) {
  if (error instanceof PhotoRoomError) return error.status;
  if (error.code === 'LIMIT_FILE_SIZE') return 413;
  if (error.code && String(error.code).startsWith('LIMIT_')) return 400;
  return 500;
}

function resolveMessage(error, status, config) {
  if (error.code === 'LIMIT_FILE_SIZE') {
    return `That image is larger than the ${Math.round(config.maxUploadBytes / (1024 * 1024))} MB limit.`;
  }
  // PhotoRoomError messages are written for visitors and carry no upstream
  // detail, so they are safe to show even for a 5xx. Anything else is an
  // unexpected internal failure whose message could hint at our configuration.
  if (error instanceof PhotoRoomError || status < 500) {
    return redact(error.message, config.allSecrets);
  }
  return 'Something went wrong on our side. Please try again.';
}

function start() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`\n  Configuration error: ${error.message}\n`);
    process.exit(1);
  }

  createApp(config).listen(config.port, () => {
    console.log(`\n  ClearCut running at http://localhost:${config.port}`);
    console.log(`  Mode: ${config.mode}  |  Key: ${config.keySource}  |  ${config.keyFingerprint}\n`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { createApp };
