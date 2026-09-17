// DedupCache.ts
// Prevents reprocessing or re-forwarding duplicate packets in the mesh network.
// Uses a bounded LRU-style set keyed by packetId (hex SHA-256 string).

const DEFAULT_MAX_SIZE = 1024;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  expiresAt: number;
}

export class DedupCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = DEFAULT_MAX_SIZE, ttlMs = DEFAULT_TTL_MS) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /** Returns true if this packetId has already been seen (and not expired) */
  has(packetId: string): boolean {
    const entry = this.cache.get(packetId);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(packetId);
      return false;
    }
    return true;
  }

  /** Mark a packetId as seen */
  add(packetId: string): void {
    // Evict oldest entry if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(packetId, { expiresAt: Date.now() + this.ttlMs });
  }

  /** Attempt to add; returns false if it was already seen (duplicate) */
  tryAdd(packetId: string): boolean {
    if (this.has(packetId)) return false;
    this.add(packetId);
    return true;
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}
