// OutboxRepository.ts
// Store-and-forward queue backed by IndexedDB (idb).
// Messages are stored locally and sent when transport becomes available.

import { openDB, type IDBPDatabase } from 'idb';

export type OutboxStatus = 'pending' | 'routing' | 'relayed' | 'delivered' | 'failed';

export interface OutboxMessage {
  id: string;               // packetId (hex)
  dstFp: string;            // recipient fingerprint (hex)
  encryptedPayload: string; // base64-encoded ciphertext
  status: OutboxStatus;
  createdAt: number;        // epoch ms
  attempts: number;
  lastAttemptAt?: number;
}

const DB_NAME = 'mistroom-outbox';
const STORE = 'messages';

async function openOutboxDB(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      const store = db.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('by-status', 'status');
      store.createIndex('by-dst', 'dstFp');
    },
  });
}

export class OutboxRepository {
  private db: IDBPDatabase | null = null;

  private async getDB(): Promise<IDBPDatabase> {
    if (!this.db) this.db = await openOutboxDB();
    return this.db;
  }

  async enqueue(msg: Omit<OutboxMessage, 'attempts' | 'createdAt' | 'status'>): Promise<void> {
    const db = await this.getDB();
    await db.put(STORE, {
      ...msg,
      status: 'pending' as OutboxStatus,
      attempts: 0,
      createdAt: Date.now(),
    });
  }

  async getPending(): Promise<OutboxMessage[]> {
    const db = await this.getDB();
    return db.getAllFromIndex(STORE, 'by-status', 'pending');
  }

  async updateStatus(id: string, status: OutboxStatus): Promise<void> {
    const db = await this.getDB();
    const msg = await db.get(STORE, id);
    if (!msg) return;
    await db.put(STORE, {
      ...msg,
      status,
      attempts: msg.attempts + (status === 'routing' ? 1 : 0),
      lastAttemptAt: Date.now(),
    });
  }

  async getAll(): Promise<OutboxMessage[]> {
    const db = await this.getDB();
    return db.getAll(STORE);
  }

  async remove(id: string): Promise<void> {
    const db = await this.getDB();
    await db.delete(STORE, id);
  }

  async clear(): Promise<void> {
    const db = await this.getDB();
    await db.clear(STORE);
  }
}
