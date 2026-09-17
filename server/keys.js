/**
 * keys.js — the cryptographic backbone of the one hard rule.
 *
 * Sentinel (risk) holds an Ed25519 *private* key. Every other agent gets, at
 * most, the public key — which lets it verify a stamp but never forge one.
 * "Execution can't self-authorize" stops being a policy document and becomes a
 * property of the type system: Pilot's signature argument is validated against
 * the public key, and Pilot is never handed the private one.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const PRIVATE = path.join(config.keysDir, 'sentinel_ed25519_private.pem');
const PUBLIC = path.join(config.keysDir, 'sentinel_ed25519_public.pem');

let cache = null;

function ensureDir() {
  fs.mkdirSync(config.keysDir, { recursive: true, mode: 0o700 });
}

export function loadSentinelKeys() {
  if (cache) return cache;
  ensureDir();
  if (fs.existsSync(PRIVATE) && fs.existsSync(PUBLIC)) {
    cache = {
      privatePem: fs.readFileSync(PRIVATE, 'utf8'),
      publicPem: fs.readFileSync(PUBLIC, 'utf8'),
      generatedAt: fs.statSync(PRIVATE).mtime.toISOString(),
      fresh: false,
    };
    return cache;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  cache = {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    generatedAt: new Date().toISOString(),
    fresh: true,
  };
  fs.writeFileSync(PRIVATE, cache.privatePem, { mode: 0o600 });
  fs.writeFileSync(PUBLIC, cache.publicPem, { mode: 0o644 });
  return cache;
}

export function publicKeyPem() {
  return loadSentinelKeys().publicPem;
}

export function signDigest(privatePem, digest) {
  const key = crypto.createPrivateKey(privatePem);
  return crypto.sign(null, Buffer.from(digest, 'hex'), key).toString('base64');
}

export function verifyDigest(publicPem, digest, signatureB64) {
  try {
    const key = crypto.createPublicKey(publicPem);
    return crypto.verify(
      null,
      Buffer.from(digest, 'hex'),
      key,
      Buffer.from(String(signatureB64 || ''), 'base64')
    );
  } catch {
    return false;
  }
}

export function fingerprint(publicPem = publicKeyPem()) {
  return crypto.createHash('sha256').update(publicPem).digest('hex').slice(0, 16);
}
