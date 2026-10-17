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

let cachedWordlist = null;

export async function loadWordlist() {
  if (cachedWordlist) return cachedWordlist;
  try {
    const res = await fetch('/vendor/wordlist.txt');
    const text = await res.text();
    const words = text.trim().split(/\s+/);
    if (words.length === 2048) {
      cachedWordlist = words;
      return words;
    }
  } catch (e) {
    console.debug('Failed to load wordlist:', e);
  }
  return null;
}

export function generate12WordPhrase(words) {
  if (!words || words.length !== 2048) throw new Error('Valid 2048-wordlist required');
  const entropy = new Uint8Array(16); // 128 bits
  crypto.getRandomValues(entropy);

  // 12 words: 128 bits + 4 bits checksum = 132 bits = 12 * 11 bits
  const hash = sha256(entropy);
  const checksum = hash[0] >> 4; // 4 bits

  let bits = '';
  for (let i = 0; i < 16; i++) {
    bits += entropy[i].toString(2).padStart(8, '0');
  }
  bits += checksum.toString(2).padStart(4, '0');

  const phraseWords = [];
  for (let i = 0; i < 12; i++) {
    const idx = parseInt(bits.slice(i * 11, (i + 1) * 11), 2);
    phraseWords.push(words[idx]);
  }
  return phraseWords.join(' ');
}

export function validate12WordPhrase(phrase, words) {
  if (!phrase || typeof phrase !== 'string') return false;
  const parts = phrase.trim().toLowerCase().split(/\s+/);
  if (parts.length !== 12) return false;
  const wordSet = new Set(words);
  return parts.every(w => wordSet.has(w));
}

export function deriveIdentityFromPhrase(phrase) {
  const enc = new TextEncoder();
  const phraseBytes = enc.encode(phrase.trim().toLowerCase());
  const salt = enc.encode('mistroom:identity:v2');
  const seed = pbkdf2(sha256, phraseBytes, salt, { c: 100000, dkLen: 32 });

  const privKey = seed;
  const pubKey = ed25519.getPublicKey(privKey);
  const peerId = derivePeerIdFromPk(pubKey);

  return { privKey, pubKey, peerId, phrase: phrase.trim().toLowerCase() };
}

export async function restoreIdentityFromPhrase(phrase) {
  const words = await loadWordlist();
  if (!words || !validate12WordPhrase(phrase, words)) {
    throw new Error('Invalid 12-word recovery phrase');
  }
  const identity = deriveIdentityFromPhrase(phrase);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction(ID_STORE, 'readwrite');
      const store = tx.objectStore(ID_STORE);
      store.put({
        key: 'ed25519_identity',
        privKey: identity.privKey,
        pubKey: identity.pubKey,
        phrase: identity.phrase
      });
      tx.oncomplete = () => resolve(identity);
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getOrCreateIdentity() {
  const words = await loadWordlist();
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
            peerId: derivePeerIdFromPk(getReq.result.pubKey),
            phrase: getReq.result.phrase || null
          });
        } else {
          let phrase = null;
          let privKey;
          let pubKey;
          if (words) {
            phrase = generate12WordPhrase(words);
            const derived = deriveIdentityFromPhrase(phrase);
            privKey = derived.privKey;
            pubKey = derived.pubKey;
          } else {
            privKey = ed25519.utils.randomPrivateKey();
            pubKey = ed25519.getPublicKey(privKey);
          }
          store.put({ key: 'ed25519_identity', privKey, pubKey, phrase });
          tx.oncomplete = () => {
            resolve({
              privKey,
              pubKey,
              peerId: derivePeerIdFromPk(pubKey),
              phrase
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

export function signAck(id, status) {
  if (!state.identity || !state.identity.privKey) return '';
  const data = new TextEncoder().encode(`ack|${id}|${status}`);
  const sigBytes = ed25519.sign(data, state.identity.privKey);
  return bytesToBase64(sigBytes);
}

export function signResolveNeed(id) {
  if (!state.identity || !state.identity.privKey) return '';
  const data = new TextEncoder().encode(`resolve|${id}`);
  const sigBytes = ed25519.sign(data, state.identity.privKey);
  return bytesToBase64(sigBytes);
}

export function verifyGenericSig(dataStr, sigB64, pkB64) {
  try {
    const pkBytes = base64ToBytes(pkB64);
    const sigBytes = base64ToBytes(sigB64);
    const data = new TextEncoder().encode(dataStr);
    return ed25519.verify(sigBytes, data, pkBytes);
  } catch (e) {
    return false;
  }
}

export function encryptEnvelope(plaintext, keyBytes = state.cryptoKey) {
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

export function decryptEnvelope(envelope, keyBytes = state.cryptoKey) {
  if (!envelope || envelope.v !== 2 || !envelope.n || !envelope.c) {
    console.debug('Rejected non-v2 envelope:', envelope);
    return null;
  }
  if (!keyBytes) {
    console.debug('No crypto key available to decrypt envelope');
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
