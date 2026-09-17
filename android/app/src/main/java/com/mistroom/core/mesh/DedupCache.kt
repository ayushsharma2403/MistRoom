package com.mistroom.core.mesh

import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Deduplication cache for mesh packets.
 *
 * Prevents the same packet from being processed or forwarded multiple times
 * as it propagates through the mesh network. Uses packet IDs with TTL-based
 * expiration.
 */
@Singleton
class DedupCache @Inject constructor() {

    companion object {
        /** Default entry expiration time: 5 minutes. */
        const val DEFAULT_EXPIRY_MILLIS = 5 * 60 * 1000L

        /** Maximum cache size before forced cleanup. */
        const val MAX_CACHE_SIZE = 10_000
    }

    private data class CacheEntry(
        val packetId: String,
        val insertedAtMillis: Long = System.currentTimeMillis(),
    )

    private val cache = ConcurrentHashMap<String, CacheEntry>()
    private var expiryMillis = DEFAULT_EXPIRY_MILLIS

    /**
     * Check if a packet ID has been seen before.
     * If not seen, it is added to the cache atomically.
     *
     * @param packetId The unique packet identifier.
     * @return `true` if this packet ID was already in the cache (duplicate),
     *         `false` if it's new (first time seen — now added).
     */
    fun isDuplicate(packetId: String): Boolean {
        evictExpired()

        val entry = CacheEntry(packetId)
        val previous = cache.putIfAbsent(packetId, entry)
        return previous != null
    }

    /**
     * Explicitly mark a packet ID as seen.
     */
    fun markSeen(packetId: String) {
        cache[packetId] = CacheEntry(packetId)
        if (cache.size > MAX_CACHE_SIZE) {
            evictExpired()
        }
    }

    /**
     * Check if a packet ID is in the cache without modifying it.
     */
    fun contains(packetId: String): Boolean {
        evictExpired()
        return cache.containsKey(packetId)
    }

    /**
     * Remove expired entries from the cache.
     */
    fun evictExpired() {
        val cutoff = System.currentTimeMillis() - expiryMillis
        cache.entries.removeIf { it.value.insertedAtMillis < cutoff }
    }

    /**
     * Clear the entire cache.
     */
    fun clear() {
        cache.clear()
    }

    /**
     * Current number of entries in the cache.
     */
    val size: Int get() = cache.size

    /**
     * Set custom expiry duration.
     */
    fun setExpiryMillis(millis: Long) {
        expiryMillis = millis
    }
}
