/**
 * Reports the limits the front end needs, and whether the deployment has a
 * usable key. It deliberately says nothing about the key itself.
 */

import configModule from '../../lib/config.js';

const { loadConfig } = configModule;

let cachedConfig;

function readEnv() {
  return typeof Netlify === 'undefined' ? process.env : Netlify.env.toObject();
}

export default async function handler() {
  try {
    if (!cachedConfig) cachedConfig = loadConfig(readEnv());
  } catch {
    return new Response(JSON.stringify({ status: 'unconfigured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  return new Response(
    JSON.stringify({
      status: 'ok',
      mode: cachedConfig.mode,
      maxUploadBytes: cachedConfig.maxUploadBytes,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
}

export const config = {
  path: '/api/health',
};
