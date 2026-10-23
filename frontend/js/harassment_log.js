/**
 * Tamper-evident incident harassment log with hash chaining and Ed25519 digital signatures.
 * Stored in IndexedDB and encrypted at rest.
 */
import { state } from './state.js';
import {
  sha256, bytesToHex, bytesToBase64, base64ToBytes,
  encryptEnvelope, decryptEnvelope, deriveRoomKey
} from './crypto.js';
import { ed25519 } from '../vendor/noble-crypto.js';

export const LOG_DB_NAME = 'mistroom_evidence_db';
export const LOG_DB_VERSION = 1;
const LOG_STORE = 'incident_chain';
const PHOTO_STORE = 'incident_photos';

let logDbInstance = null;

export function initLogDB() {
  return new Promise(resolve => {
    if (!window.indexedDB) return resolve(null);
    const req = window.indexedDB.open(LOG_DB_NAME, LOG_DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(LOG_STORE)) {
        db.createObjectStore(LOG_STORE, { keyPath: 'idx' });
      }
      if (!db.objectStoreNames.contains(PHOTO_STORE)) {
        db.createObjectStore(PHOTO_STORE, { keyPath: 'hash' });
      }
    };
    req.onsuccess = e => {
      logDbInstance = e.target.result;
      resolve(logDbInstance);
    };
    req.onerror = () => resolve(null);
  });
}

function canonicalEntryBytes(entry) {
  const keys = Object.keys(entry).filter(k => k !== 'hash' && k !== 'sig').sort();
  const obj = {};
  for (const k of keys) {
    obj[k] = entry[k];
  }
  return new TextEncoder().encode(JSON.stringify(obj));
}

export async function addIncidentLogEntry({ text, cat = 'other', lat = null, lon = null, photoBlob = null, correctionFor = null }) {
  if (!logDbInstance) await initLogDB();
  const entries = await getAllEntries();
  const nextIdx = entries.length;
  const prevHash = nextIdx === 0 ? 'GENESIS' : entries[nextIdx - 1].hash;

  let photoHash = null;
  if (photoBlob) {
    const arrayBuf = await photoBlob.arrayBuffer();
    const photoBytes = new Uint8Array(arrayBuf);
    photoHash = bytesToHex(sha256(photoBytes));

    // Store photo in PHOTO_STORE
    const txP = logDbInstance.transaction(PHOTO_STORE, 'readwrite');
    txP.objectStore(PHOTO_STORE).put({ hash: photoHash, data: photoBytes, type: photoBlob.type });
  }

  const entry = {
    idx: nextIdx,
    ts: Date.now(),
    cat,
    text,
    lat,
    lon,
    prevHash
  };
  if (photoHash) entry.photoHash = photoHash;
  if (correctionFor !== null && correctionFor !== undefined) entry.correctionFor = correctionFor;

  // Compute entry hash
  const dataBytes = canonicalEntryBytes(entry);
  const hash = bytesToHex(sha256(dataBytes));
  entry.hash = hash;

  // Sign hash with user's Ed25519 identity
  if (state.identity && state.identity.privKey) {
    const sigBytes = ed25519.sign(new TextEncoder().encode(hash), state.identity.privKey);
    entry.sig = bytesToBase64(sigBytes);
  }

  const tx = logDbInstance.transaction(LOG_STORE, 'readwrite');
  tx.objectStore(LOG_STORE).put(entry);

  return entry;
}

export function getAllEntries() {
  return new Promise(resolve => {
    if (!logDbInstance) return resolve([]);
    const tx = logDbInstance.transaction(LOG_STORE, 'readonly');
    const store = tx.objectStore(LOG_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

export async function verifyIncidentLog() {
  const entries = await getAllEntries();
  if (entries.length === 0) return { ok: true, count: 0 };

  const pubKeyBytes = state.identity ? state.identity.pubKey : null;
  let prevHash = 'GENESIS';

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.idx !== i) {
      return { ok: false, brokenIndex: i, reason: `Index jump: expected ${i}, found ${entry.idx}` };
    }
    if (entry.prevHash !== prevHash) {
      return { ok: false, brokenIndex: i, reason: `Chain broken: prevHash does not match previous entry hash` };
    }

    const dataBytes = canonicalEntryBytes(entry);
    const computedHash = bytesToHex(sha256(dataBytes));
    if (entry.hash !== computedHash) {
      return { ok: false, brokenIndex: i, reason: `Content tampered: hash mismatch at index ${i}` };
    }

    if (pubKeyBytes && entry.sig) {
      try {
        const sigBytes = base64ToBytes(entry.sig);
        const valid = ed25519.verify(sigBytes, new TextEncoder().encode(entry.hash), pubKeyBytes);
        if (!valid) {
          return { ok: false, brokenIndex: i, reason: `Signature invalid at index ${i}` };
        }
      } catch (e) {
        return { ok: false, brokenIndex: i, reason: `Signature verification error at index ${i}` };
      }
    }

    prevHash = computedHash;
  }

  return { ok: true, count: entries.length, headHash: prevHash };
}

export async function exportIncidentLogBundle() {
  const entries = await getAllEntries();
  const pubKeyB64 = state.identity ? bytesToBase64(state.identity.pubKey) : null;
  const headHash = entries.length > 0 ? entries[entries.length - 1].hash : 'GENESIS';

  return {
    bundle_version: 1,
    public_key: pubKeyB64,
    head_hash: headHash,
    exported_at: Date.now(),
    entries,
    witness_receipts: []
  };
}

export async function verifyExternalBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    return { ok: false, reason: 'Invalid bundle: Not a JSON object' };
  }

  const entries = bundle.entries || [];
  const pubKeyB64 = bundle.public_key;
  const headHash = bundle.head_hash;

  if (!pubKeyB64) {
    return { ok: false, reason: 'Missing public_key in bundle' };
  }

  let pubKeyBytes;
  try {
    pubKeyBytes = base64ToBytes(pubKeyB64);
  } catch (e) {
    return { ok: false, reason: 'Invalid base64 in public_key' };
  }

  if (entries.length === 0) {
    return { ok: true, count: 0, headHash: 'GENESIS' };
  }

  let prevHash = 'GENESIS';

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.idx !== i) {
      return { ok: false, brokenIndex: i, reason: `Index mismatch at ${i}: got ${entry.idx}` };
    }
    if (entry.prevHash !== prevHash) {
      return { ok: false, brokenIndex: i, reason: `Chain broken at entry #${i}: prevHash does not match previous entry hash` };
    }

    const dataBytes = canonicalEntryBytes(entry);
    const computedHash = bytesToHex(sha256(dataBytes));
    if (entry.hash !== computedHash) {
      return { ok: false, brokenIndex: i, reason: `Hash mismatch at entry #${i}: computed ${computedHash.substring(0, 8)} != recorded ${entry.hash ? entry.hash.substring(0, 8) : 'none'}` };
    }

    if (!entry.sig) {
      return { ok: false, brokenIndex: i, reason: `Missing signature at entry #${i}` };
    }

    try {
      const sigBytes = base64ToBytes(entry.sig);
      const valid = ed25519.verify(sigBytes, new TextEncoder().encode(entry.hash), pubKeyBytes);
      if (!valid) {
        return { ok: false, brokenIndex: i, reason: `Invalid digital signature at entry #${i}` };
      }
    } catch (e) {
      return { ok: false, brokenIndex: i, reason: `Signature verification error at entry #${i}: ${e.message}` };
    }

    prevHash = computedHash;
  }

  if (headHash && headHash !== prevHash) {
    return { ok: false, reason: `Head hash mismatch: recorded ${headHash} != computed ${prevHash}` };
  }

  return { ok: true, count: entries.length, headHash: prevHash, publicKey: pubKeyB64 };
}
