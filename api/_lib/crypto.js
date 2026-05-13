// api/_lib/crypto.js
// AES-256-GCM helpers for encrypting OAuth tokens and API keys before storing
// them in Supabase user_connections.credentials (JSONB).
//
// The key comes from the ENCRYPTION_SECRET environment variable, which MUST be
// a 64-character hex string (32 bytes). Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Output format for `encrypt`: "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
// `decrypt` accepts that exact format and returns the original plaintext.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV is the GCM recommended length

function getKey() {
  const hex = process.env.ENCRYPTION_SECRET;
  if (!hex) {
    throw new Error('ENCRYPTION_SECRET env var is not set');
  }
  if (hex.length !== 64) {
    throw new Error(
      `ENCRYPTION_SECRET must be 64 hex chars (32 bytes), got ${hex.length}`
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * @param {string} plaintext
 * @returns {string} "<iv>:<authTag>:<ciphertext>" all hex-encoded
 */
export function encrypt(plaintext) {
  if (plaintext == null) return null;
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypt a string previously produced by `encrypt`.
 * @param {string} payload
 * @returns {string} the original plaintext
 */
export function decrypt(payload) {
  if (payload == null) return null;
  const parts = String(payload).split(':');
  if (parts.length !== 3) {
    throw new Error('crypto.decrypt: malformed payload, expected iv:tag:cipher');
  }
  const key = getKey();
  const [ivHex, tagHex, ctHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(ctHex, 'hex');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Encrypt every leaf string of a credentials object.
 * Keys are preserved; only string leaves are transformed.
 * Convenient for storing structured credentials in JSONB.
 * @param {Record<string, any>} obj
 * @returns {Record<string, any>}
 */
export function encryptCredentials(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? encrypt(v) : v;
  }
  return out;
}

/**
 * Decrypt every leaf string of a credentials object produced by encryptCredentials.
 * @param {Record<string, any>} obj
 * @returns {Record<string, any>}
 */
export function decryptCredentials(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.split(':').length === 3) {
      try {
        out[k] = decrypt(v);
      } catch {
        out[k] = v; // not an encrypted payload, pass through
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}
