/**
 * Reports the limits the front end needs, and whether the deployment has a
 * usable key.
 *
 * When configuration is missing it names which variable is absent — never a
 * value — so an operator can fix a deployment without digging through function
 * logs. The cutout endpoint stays vague with visitors; this is the diagnostic.
 */

import configModule from '../../lib/config.js';
import runtimeEnvModule from '../../lib/runtime-env.js';

const { loadConfig } = configModule;
const { readEnv, describeConfigProblem } = runtimeEnvModule;

let cachedConfig;

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export default async function handler() {
  const env = readEnv();

  try {
    if (!cachedConfig) cachedConfig = loadConfig(env);
  } catch (error) {
    return json({ status: 'unconfigured', reason: describeConfigProblem(env, error) }, 503);
  }

  return json(
    {
      status: 'ok',
      mode: cachedConfig.mode,
      maxUploadBytes: cachedConfig.maxUploadBytes,
    },
    200
  );
}

export const config = {
  path: '/api/health',
};
