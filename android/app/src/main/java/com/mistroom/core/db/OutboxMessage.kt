package com.mistroom.core.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** Status of a queued outbound message. */
enum class OutboxStatus { PENDING, SENT, FAILED }

/**
 * A message waiting to be delivered over the mesh.
 *
 * Messages are queued here when the target peer is not currently reachable.
 * The [OutboxRepository] retries delivery whenever a new peer is discovered.
 */
@Entity(
    tableName = "outbox_messages",
    indices = [
        Index("status"),
        Index("recipientFingerprint"),
        Index("createdAt"),
    ],
)
data class OutboxMessage(
    @PrimaryKey val id: String,             // Matches MeshPacket.packetId
    val recipientFingerprint: String,       // 32-char hex target fingerprint
    val encryptedPayload: ByteArray,        // AES-256-GCM ciphertext
    val packetType: Int,                    // PacketType.value
    val ttl: Int,                           // Original TTL
    val createdAt: Long = System.currentTimeMillis(),
    val attempts: Int = 0,
    val lastAttemptAt: Long = 0L,
    val status: OutboxStatus = OutboxStatus.PENDING,
) {
    companion object {
        /** Drop messages older than 7 days. */
        const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000

        /** Give up after this many delivery attempts. */
        const val MAX_ATTEMPTS = 5
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is OutboxMessage) return false
        return id == other.id
    }

    override fun hashCode(): Int = id.hashCode()
}
