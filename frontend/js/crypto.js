/**
 * MistRoom v2 Cryptography Engine using @noble/ciphers, @noble/hashes, and @noble/curves.
 * Pure JS, 100% offline, zero WebCrypto fallback.
 */
import { xchacha20poly1305, pbkdf2, sha256, ed25519 } from '../vendor/noble-crypto.js';
import { state } from './state.js';

const DB_NAME = 'mistroom_mesh_db';
const DB_VERSION = 1;
const ID_STORE = 'identity';

export function bytesToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function bytesToBase32(bytes) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function derivePeerIdFromPk(pkBytes) {
  const hash = sha256(pkBytes);
  return bytesToBase32(hash.slice(0, 16));
}

export function deriveRoomKey(passkey, roomName) {
  const enc = new TextEncoder();
  const passwordBytes = enc.encode(passkey);
  const salt = sha256(enc.encode('mistroom:v2:' + roomName));
  return pbkdf2(sha256, passwordBytes, salt, { c: 600000, dkLen: 32 });
}

export async function getOrCreateIdentity() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(ID_STORE)) {
        db.createObjectStore(ID_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction(ID_STORE, 'readwrite');
      const store = tx.objectStore(ID_STORE);
      const getReq = store.get('ed25519_identity');
      getReq.onsuccess = () => {
        if (getReq.result && getReq.result.privKey && getReq.result.pubKey) {
          resolve({
            privKey: getReq.result.privKey,
            pubKey: getReq.result.pubKey,
            peerId: derivePeerIdFromPk(getReq.result.pubKey)
          });
        } else {
          const privKey = ed25519.utils.randomPrivateKey();
          const pubKey = ed25519.getPublicKey(privKey);
          store.put({ key: 'ed25519_identity', privKey, pubKey });
          tx.oncomplete = () => {
            resolve({
              privKey,
              pubKey,
              peerId: derivePeerIdFromPk(pubKey)
            });
          };
        }
      };
      getReq.onerror = () => reject(getReq.error);
    };
    req.onerror = () => reject(req.error);
  });
}

export function signChallenge(nonceBase64) {
  if (!state.identity || !state.identity.privKey) return '';
  const nonceBytes = base64ToBytes(nonceBase64);
  const sigBytes = ed25519.sign(nonceBytes, state.identity.privKey);
  return bytesToBase64(sigBytes);
}

export function signMessageEnvelope(room, id, ts, n, c) {
  if (!state.identity || !state.identity.privKey) return '';
  const messageData = new TextEncoder().encode(`${room}|${id}|${ts}|${n}|${c}`);
  const sigBytes = ed25519.sign(messageData, state.identity.privKey);
  return bytesToBase64(sigBytes);
}

export function verifyMessageEnvelope(room, id, ts, n, c, sigB64, pkB64, expectedPeerId) {
  try {
    const pkBytes = base64ToBytes(pkB64);
    if (expectedPeerId) {
      const derived = derivePeerIdFromPk(pkBytes);
      if (derived !== expectedPeerId) return false;
    }
    const sigBytes = base64ToBytes(sigB64);
    const messageData = new TextEncoder().encode(`${room}|${id}|${ts}|${n}|${c}`);
    return ed25519.verify(sigBytes, messageData, pkBytes);
  } catch (e) {
    return false;
  }
}

export function encryptEnvelope(plaintext, keyBytes) {
  const enc = new TextEncoder();
  const rawBytes = enc.encode(plaintext);
  const nonce = new Uint8Array(24);
  crypto.getRandomValues(nonce);

  const cipher = xchacha20poly1305(keyBytes, nonce);
  const ciphertext = cipher.encrypt(rawBytes);

  return {
    v: 2,
    n: bytesToBase64(nonce),
    c: bytesToBase64(ciphertext)
  };
}

export function decryptEnvelope(envelope, keyBytes) {
  if (!envelope || envelope.v !== 2 || !envelope.n || !envelope.c) {
    console.debug('Rejected non-v2 envelope:', envelope);
    return null;
  }
  try {
    const nonce = base64ToBytes(envelope.n);
    const ciphertext = base64ToBytes(envelope.c);
    const cipher = xchacha20poly1305(keyBytes, nonce);
    const decryptedBytes = cipher.decrypt(ciphertext);
    return new TextDecoder().decode(decryptedBytes);
  } catch (e) {
    console.debug('Failed to authenticate/decrypt envelope:', e);
    return null;
  }
}
