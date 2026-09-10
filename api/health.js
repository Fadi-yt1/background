'use strict';

/**
 * Reports the limits the front end needs, and whether the deployment has a
 * usable key. It deliberately says nothing about the key itself.
 */

const { loadConfig } = require('../lib/config');

let cachedConfig;

module.exports = function handler(req, res) {
  try {
    if (!cachedConfig) cachedConfig = loadConfig();
  } catch {
    res.status(503).json({ status: 'unconfigured' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    status: 'ok',
    mode: cachedConfig.mode,
    maxUploadBytes: cachedConfig.maxUploadBytes,
  });
};
