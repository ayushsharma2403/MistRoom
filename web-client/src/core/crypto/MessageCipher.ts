// MessageCipher.ts
// X25519 ECDH key exchange + AES-256-GCM authenticated encryption
// Zero-Trust: all keys generated locally, never sent to backend

import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';

const AES_ALGO = 'AES-GCM';
const IV_LEN = 12; // 96-bit nonce for GCM

// ── ECDH Key Agreement ────────────────────────────────────────────────────────

/** Generate an ephemeral X25519 key pair for ECDH */
export function generateEphemeralKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Derive a shared AES-256-GCM key from our X25519 private key and a peer's public key.
 * Uses HKDF-SHA256 to stretch the raw shared secret into a suitable key.
 */
export async function deriveSharedKey(
  ourPrivateKey: Uint8Array,
  peerPublicKey: Uint8Array
): Promise<CryptoKey> {
  const sharedSecret = x25519.getSharedSecret(ourPrivateKey, peerPublicKey);
  const info = new TextEncoder().encode('MistRoom-v1-Key');
  const derivedKeyBytes = hkdf(sha256, sharedSecret, undefined, info, 32);

  return crypto.subtle.importKey(
    'raw',
    derivedKeyBytes as unknown as BufferSource,
    { name: AES_ALGO },
    false,
    ['encrypt', 'decrypt']
  );
}

// ── AES-256-GCM Encrypt / Decrypt ────────────────────────────────────────────

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns concatenated bytes: [12-byte IV | ciphertext + 16-byte auth tag].
 */
export async function encrypt(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ciphertext = await crypto.subtle.encrypt({ name: AES_ALGO, iv }, key, plaintext as unknown as BufferSource);
  const result = new Uint8Array(IV_LEN + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LEN);
  return result;
}

/**
 * Decrypt AES-256-GCM ciphertext.
 * Expects format: [12-byte IV | ciphertext + 16-byte auth tag].
 * Throws if authentication fails (tampered data detected).
 */
export async function decrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = data.slice(0, IV_LEN);
  const ciphertext = data.slice(IV_LEN);
  const plaintext = await crypto.subtle.decrypt({ name: AES_ALGO, iv }, key, ciphertext as unknown as BufferSource);
  return new Uint8Array(plaintext);
}

// ── Session Key Cache ─────────────────────────────────────────────────────────

/** In-memory session key cache: peerFingerprint → CryptoKey */
const sessionCache = new Map<string, CryptoKey>();

export function cacheSessionKey(peerFingerprint: string, key: CryptoKey): void {
  sessionCache.set(peerFingerprint, key);
}

export function getSessionKey(peerFingerprint: string): CryptoKey | undefined {
  return sessionCache.get(peerFingerprint);
}

export function clearSessionKey(peerFingerprint: string): void {
  sessionCache.delete(peerFingerprint);
}
