'use strict';

/**
 * Resolves runtime configuration, including the PhotoRoom credentials.
 *
 * Keys are read once at boot, held only in this process's memory, and are never
 * placed on any object that reaches the browser.
 */

const { open, fingerprint } = require('./secure-store');

const MEGABYTE = 1024 * 1024;

function resolveKey({ sealedVar, plainVar, passphrase, env }) {
  const sealed = env[sealedVar];
  if (sealed) {
    return { value: open(sealed, passphrase), source: `${sealedVar} (encrypted)` };
  }
  const plain = env[plainVar];
  if (plain) {
    return { value: plain, source: `${plainVar} (plaintext)` };
  }
  return { value: null, source: null };
}

function loadConfig(env = process.env) {
  const passphrase = env.KEY_ENCRYPTION_SECRET;
  const usesSealedKeys = Boolean(env.PHOTOROOM_API_KEY_ENC || env.PHOTOROOM_SANDBOX_API_KEY_ENC);

  if (usesSealedKeys && !passphrase) {
    throw new Error(
      'An encrypted API key is configured but KEY_ENCRYPTION_SECRET is missing. ' +
        'Set it to the passphrase used by `npm run encrypt-key`.'
    );
  }

  const live = resolveKey({
    sealedVar: 'PHOTOROOM_API_KEY_ENC',
    plainVar: 'PHOTOROOM_API_KEY',
    passphrase,
    env,
  });
  const sandbox = resolveKey({
    sealedVar: 'PHOTOROOM_SANDBOX_API_KEY_ENC',
    plainVar: 'PHOTOROOM_SANDBOX_API_KEY',
    passphrase,
    env,
  });

  // Sandbox keys are free but watermark the result, so they are opt-in.
  const useSandbox = env.PHOTOROOM_MODE === 'sandbox';
  const active = useSandbox ? sandbox : live;

  if (!active.value) {
    const wanted = useSandbox ? 'sandbox' : 'live';
    throw new Error(
      `No ${wanted} PhotoRoom API key is configured. Add one to .env — see .env.example for the variable names.`
    );
  }

  return {
    port: Number(env.PORT || 3000),
    mode: useSandbox ? 'sandbox' : 'live',
    apiKey: active.value,
    keySource: active.source,
    keyFingerprint: fingerprint(active.value),
    // Every configured key, so responses and logs can be scrubbed of all of them.
    allSecrets: [live.value, sandbox.value].filter(Boolean),
    maxUploadBytes: Number(env.MAX_UPLOAD_MB || 12) * MEGABYTE,
    rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MINUTES || 15) * 60 * 1000,
    rateLimitMax: Number(env.RATE_LIMIT_MAX || 30),
    upstreamUrl: env.PHOTOROOM_API_URL || 'https://sdk.photoroom.com/v1/segment',
    upstreamTimeoutMs: Number(env.PHOTOROOM_TIMEOUT_MS || 60000),
  };
}

module.exports = { loadConfig, MEGABYTE };
