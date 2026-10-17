/**
 * IndexedDB Offline Store-and-Forward Outbox.
 */
import { state } from './state.js';
import { updateMessageStatus } from './ui.js';

export const DB_NAME = 'mistroom_mesh_db';
export const DB_VERSION = 1;

export function initIndexedDB() {
  return new Promise(resolve => {
    if (!window.indexedDB) return resolve(null);
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'id' });
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

export function queueOfflineMessage(msg) {
  if (!state.dbInstance) return;
  try {
    const tx = state.dbInstance.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').put(msg);
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
    const tx = state.dbInstance.transaction('outbox', 'readonly');
    const store = tx.objectStore('outbox');
    const req = store.getAll();
    req.onsuccess = async () => {
      const items = req.result || [];
      for (const item of items) {
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
          removeQueuedMessage(item.id);
          updateMessageStatus(item.id, 'sent');
        }
      }
    };
  } catch (e) {}
}
