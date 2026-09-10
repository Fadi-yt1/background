'use strict';

/**
 * Resolves runtime configuration, including the PhotoRoom credentials.
 *
 * Keys are read once at boot, held only in this process's memory, and are never
 * placed on any object that reaches the browser.
 */

const { open, fingerprint } = require('./secure-store');

const MEGABYTE = 1024 * 1024;

// Serverless hosts cap request bodies well below what a long-running server
// accepts (Netlify at 6 MB, Vercel at ~4.5 MB), and they reject the request
// before the function runs, so the advertised limit has to stay under that.
const SERVERLESS_BODY_LIMIT_BYTES = 4 * MEGABYTE;

/**
 * Reads one credential from the environment, decrypting it when sealed.
 *
 * `required` marks the key the app is actually about to use: that one must
 * decrypt or startup fails. The other key is only needed for sandbox mode and
 * for redaction, so a stale or wrongly-sealed blob is warned about rather than
 * taking the whole deployment down.
 */
function resolveKey({ sealedVar, plainVar, passphrase, env, required }) {
  const sealed = env[sealedVar];
  if (sealed) {
    try {
      return { value: open(sealed, passphrase), source: `${sealedVar} (encrypted)` };
    } catch (error) {
      if (required) throw error;
      console.warn(`[config] Ignoring ${sealedVar}: ${error.message}`);
      return { value: null, source: null };
    }
  }
  const plain = env[plainVar];
  if (plain) {
    return { value: plain, source: `${plainVar} (plaintext)` };
  }
  return { value: null, source: null };
}

function resolveUploadLimit(env) {
  const requested = Number(env.MAX_UPLOAD_MB || 12) * MEGABYTE;
  const serverless = Boolean(env.NETLIFY || env.VERCEL);
  return serverless ? Math.min(requested, SERVERLESS_BODY_LIMIT_BYTES) : requested;
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

  // Sandbox keys are free but watermark the result, so they are opt-in.
  const useSandbox = env.PHOTOROOM_MODE === 'sandbox';

  const live = resolveKey({
    sealedVar: 'PHOTOROOM_API_KEY_ENC',
    plainVar: 'PHOTOROOM_API_KEY',
    passphrase,
    env,
    required: !useSandbox,
  });
  const sandbox = resolveKey({
    sealedVar: 'PHOTOROOM_SANDBOX_API_KEY_ENC',
    plainVar: 'PHOTOROOM_SANDBOX_API_KEY',
    passphrase,
    env,
    required: useSandbox,
  });

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
    maxUploadBytes: resolveUploadLimit(env),
    rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MINUTES || 15) * 60 * 1000,
    rateLimitMax: Number(env.RATE_LIMIT_MAX || 30),
    upstreamUrl: env.PHOTOROOM_API_URL || 'https://sdk.photoroom.com/v1/segment',
    upstreamTimeoutMs: Number(env.PHOTOROOM_TIMEOUT_MS || 60000),
  };
}

module.exports = { loadConfig, resolveUploadLimit, MEGABYTE };
