'use strict';

/**
 * Collects environment variables across the runtimes this app is deployed on.
 *
 * On Netlify a function sees configuration through the `Netlify.env` API as well
 * as `process.env`, and the two do not always agree: values marked as secret in
 * the Netlify UI can be absent from `Netlify.env.toObject()` while still being
 * readable through `Netlify.env.get()`. Reading only one source is how a
 * correctly configured deployment ends up reporting itself unconfigured, so this
 * merges every source it can see.
 */

// Everything lib/config.js looks at, so a secret-scoped value is never missed.
const CONFIG_KEYS = [
  'KEY_ENCRYPTION_SECRET',
  'PHOTOROOM_API_KEY_ENC',
  'PHOTOROOM_SANDBOX_API_KEY_ENC',
  'PHOTOROOM_API_KEY',
  'PHOTOROOM_SANDBOX_API_KEY',
  'PHOTOROOM_MODE',
  'PHOTOROOM_API_URL',
  'PHOTOROOM_TIMEOUT_MS',
  'MAX_UPLOAD_MB',
  'NETLIFY',
  'VERCEL',
];

function readEnv() {
  const env = { ...process.env };

  // eslint-disable-next-line no-undef -- `Netlify` only exists on the platform.
  const platform = typeof Netlify === 'undefined' ? null : Netlify;
  if (!platform?.env) return env;

  if (typeof platform.env.toObject === 'function') {
    Object.assign(env, platform.env.toObject());
  }

  if (typeof platform.env.get === 'function') {
    for (const key of CONFIG_KEYS) {
      const value = platform.env.get(key);
      if (value !== undefined && value !== null && value !== '') {
        env[key] = value;
      }
    }
  }

  return env;
}

/**
 * Names which configuration is missing, without revealing any value.
 *
 * Used by /api/health so an operator can tell a missing variable from a wrong
 * passphrase without reading the platform's function logs.
 */
function describeConfigProblem(env, error) {
  const has = (key) => Boolean(env[key]);

  if (!has('PHOTOROOM_API_KEY_ENC') && !has('PHOTOROOM_API_KEY')) {
    return 'No PhotoRoom key is set. Add PHOTOROOM_API_KEY_ENC to this deployment.';
  }
  if (has('PHOTOROOM_API_KEY_ENC') && !has('KEY_ENCRYPTION_SECRET')) {
    return 'KEY_ENCRYPTION_SECRET is missing, so the encrypted key cannot be opened.';
  }
  if (/decrypt/i.test(error?.message || '')) {
    return 'The key did not decrypt. KEY_ENCRYPTION_SECRET does not match the blob it was sealed with.';
  }
  return 'The configuration could not be loaded.';
}

module.exports = { readEnv, describeConfigProblem, CONFIG_KEYS };
