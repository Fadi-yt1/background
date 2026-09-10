#!/usr/bin/env node
'use strict';

/**
 * Turns a plaintext API key into an encrypted blob for .env.
 *
 * Usage:
 *   npm run encrypt-key                       prompts for both values
 *   npm run encrypt-key -- --generate         prints a fresh master passphrase
 *   npm run encrypt-key -- --key sk_pr_xxx    reads the passphrase from the prompt
 *
 * Prompting is the safer path: neither the key nor the passphrase lands in your
 * shell history.
 */

const readline = require('readline');
const crypto = require('crypto');
const { seal } = require('../lib/secure-store');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[name] = next;
      i += 1;
    } else {
      args[name] = true;
    }
  }
  return args;
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log('Usage: npm run encrypt-key -- [--key <api-key>] [--passphrase <passphrase>] [--var <ENV_VAR>]');
    console.log('       npm run encrypt-key -- --generate    print a new KEY_ENCRYPTION_SECRET');
    return;
  }

  if (args.generate) {
    console.log(`KEY_ENCRYPTION_SECRET=${crypto.randomBytes(32).toString('base64url')}`);
    return;
  }

  const key = typeof args.key === 'string' ? args.key : await prompt('PhotoRoom API key: ');
  if (!key) throw new Error('An API key is required.');

  const passphrase =
    typeof args.passphrase === 'string'
      ? args.passphrase
      : process.env.KEY_ENCRYPTION_SECRET ||
        (await prompt('Master passphrase (KEY_ENCRYPTION_SECRET, 16+ characters): '));

  const variable =
    typeof args.var === 'string'
      ? args.var
      : key.startsWith('sandbox_')
        ? 'PHOTOROOM_SANDBOX_API_KEY_ENC'
        : 'PHOTOROOM_API_KEY_ENC';

  const sealed = seal(key, passphrase);

  console.log('\nAdd this line to .env (which is git-ignored):\n');
  console.log(`${variable}=${sealed}\n`);
  console.log('In production, keep KEY_ENCRYPTION_SECRET in your host secret manager rather');
  console.log('than in .env, so the passphrase and the ciphertext are never stored together.\n');
}

main().catch((error) => {
  console.error(`\n  ${error.message}\n`);
  process.exit(1);
});
