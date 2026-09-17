// DeviceIdentity.ts
// Ed25519 key generation, fingerprinting, and persistence via IndexedDB

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { openDB } from 'idb';

const DB_NAME = 'mistroom-identity';
const DB_STORE = 'keys';
const KEY_NAME = 'device-identity';

export interface Identity {
  /** Ed25519 private key (32 bytes) — NEVER leaves the device */
  privateKey: Uint8Array;
  /** Ed25519 public key (32 bytes) — shared as device fingerprint */
  publicKey: Uint8Array;
  /** SHA-256 of publicKey, hex encoded — used as peer address */
  fingerprint: string;
}

async function openIdentityDB() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore(DB_STORE);
    },
  });
}

/** Generate a new Ed25519 identity and persist it to IndexedDB */
async function generateIdentity(): Promise<Identity> {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  const fingerprint = bytesToHex(sha256(publicKey));
  const identity: Identity = { privateKey, publicKey, fingerprint };

  const db = await openIdentityDB();
  await db.put(DB_STORE, { privateKey, publicKey, fingerprint }, KEY_NAME);
  return identity;
}

/** Load persisted identity or generate one on first run */
export async function getOrCreateIdentity(): Promise<Identity> {
  const db = await openIdentityDB();
  const stored = await db.get(DB_STORE, KEY_NAME);
  if (stored) return stored as Identity;
  return generateIdentity();
}

/** Sign arbitrary bytes using our Ed25519 private key */
export function signBytes(privateKey: Uint8Array, data: Uint8Array): Uint8Array {
  return ed25519.sign(data, privateKey);
}

/** Verify an Ed25519 signature against a peer's public key */
export function verifySignature(
  publicKey: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array
): boolean {
  try {
    return ed25519.verify(signature, data, publicKey);
  } catch {
    return false;
  }
}
