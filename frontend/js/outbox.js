/**
 * IndexedDB Offline Store-and-Forward Outbox.
 */
import { state } from './state.js';
import { updateMessageStatus } from './ui.js';

export const DB_NAME = 'mistroom_mesh_db';
export const DB_VERSION = 2;

export function initIndexedDB() {
  return new Promise(resolve => {
    if (!window.indexedDB) return resolve(null);
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('identity')) {
        db.createObjectStore('identity', { keyPath: 'key' });
      }
    };
    req.onsuccess = e => {
      state.dbInstance = e.target.result;
      resolve(state.dbInstance);
      flushOfflineOutbox();
    };
    req.onerror = () => resolve(null);
  });
}

const MAX_OUTBOX_ITEMS = 200;
const OUTBOX_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export function queueOfflineMessage(msg) {
  if (!state.dbInstance) return;
  try {
    const tx = state.dbInstance.transaction('outbox', 'readwrite');
    const store = tx.objectStore('outbox');

    // Add creation timestamp if missing
    if (!msg.created_at) msg.created_at = Date.now();

    const getAllReq = store.getAll();
    getAllReq.onsuccess = () => {
      const items = getAllReq.result || [];
      const now = Date.now();

      // Expire items older than 24h
      for (const it of items) {
        if (now - (it.created_at || it.ts || now) > OUTBOX_EXPIRY_MS) {
          store.delete(it.id);
        }
      }

      // Cap at 200 items: if at limit, remove oldest
      if (items.length >= MAX_OUTBOX_ITEMS) {
        items.sort((a, b) => (a.created_at || a.ts || 0) - (b.created_at || b.ts || 0));
        const toRemove = items.slice(0, items.length - MAX_OUTBOX_ITEMS + 1);
        for (const rem of toRemove) {
          store.delete(rem.id);
        }
      }

      store.put(msg);
    };
  } catch (e) {
    console.warn('Failed to queue offline message:', e);
  }
}

export function removeQueuedMessage(id) {
  if (!state.dbInstance) return;
  try {
    const tx = state.dbInstance.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').delete(id);
  } catch (e) {}
}

export async function flushOfflineOutbox() {
  if (!state.dbInstance) return;
  try {
    const tx = state.dbInstance.transaction('outbox', 'readwrite');
    const store = tx.objectStore('outbox');
    const req = store.getAll();
    req.onsuccess = async () => {
      const items = req.result || [];
      const now = Date.now();
      for (const item of items) {
        // Drop expired
        if (now - (item.created_at || item.ts || now) > OUTBOX_EXPIRY_MS) {
          store.delete(item.id);
          continue;
        }

        let sent = false;
        let p2pCount = 0;
        const serialized = JSON.stringify(item);
        for (const [, peer] of state.meshPeers) {
          if (peer.dc && peer.dc.readyState === 'open') {
            try {
              peer.dc.send(serialized);
              p2pCount++;
            } catch (e) {}
          }
        }
        if (p2pCount > 0) sent = true;

        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify(item));
          sent = true;
        }

        if (sent) {
          store.delete(item.id);
          updateMessageStatus(item.id, 'sent');
        }
      }
    };
  } catch (e) {}
}
