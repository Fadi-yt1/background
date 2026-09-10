'use strict';

/**
 * Encrypted credential storage.
 *
 * API keys are never shipped to the browser and are never stored in plaintext on
 * disk. They live in the environment as an AES-256-GCM ciphertext ("sealed"
 * blob) that can only be opened with the master passphrase in
 * KEY_ENCRYPTION_SECRET, which is supplied at run time.
 *
 * Blob format (all segments base64url):
 *   v1.<salt>.<iv>.<authTag>.<ciphertext>
 */

const crypto = require('crypto');

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const SCRYPT_COST = 16384; // N — ~16 MB of memory per derivation.

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, KEY_BYTES, { N: SCRYPT_COST, r: 8, p: 1 });
}

function b64(buf) {
  return buf.toString('base64url');
}

function unb64(str) {
  return Buffer.from(str, 'base64url');
}

/** Encrypts a secret into a self-describing, transportable blob. */
function seal(plaintext, passphrase) {
  assertPassphrase(passphrase);
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Nothing to encrypt: the secret is empty.');
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [VERSION, b64(salt), b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)].join('.');
}

/** Reverses `seal`. Throws if the passphrase is wrong or the blob was tampered with. */
function open(blob, passphrase) {
  assertPassphrase(passphrase);
  if (typeof blob !== 'string') {
    throw new Error('Sealed value must be a string.');
  }

  const parts = blob.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error(`Sealed value is malformed — expected "${VERSION}.<salt>.<iv>.<tag>.<data>".`);
  }

  const [, salt, iv, tag, ciphertext] = parts;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(passphrase, unb64(salt)), unb64(iv));
    decipher.setAuthTag(unb64(tag));
    return Buffer.concat([decipher.update(unb64(ciphertext)), decipher.final()]).toString('utf8');
  } catch {
    // Deliberately vague: never leak whether the passphrase or the payload was at fault.
    throw new Error('Unable to decrypt the API key. Check KEY_ENCRYPTION_SECRET.');
  }
}

function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 16) {
    throw new Error('KEY_ENCRYPTION_SECRET must be set to at least 16 characters.');
  }
}

/** Shows only the key's prefix, so logs and error pages can reference it safely. */
function fingerprint(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return '(none)';
  const digest = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
  return `${secret.slice(0, 6)}…${secret.slice(-2)} (sha256:${digest})`;
}

/** Strips any occurrence of the live secrets out of text headed for a log or a response. */
function redact(text, secrets) {
  let output = String(text);
  for (const secret of secrets) {
    if (secret && secret.length > 4) {
      output = output.split(secret).join('[redacted]');
    }
  }
  return output;
}

module.exports = { seal, open, fingerprint, redact, VERSION };
