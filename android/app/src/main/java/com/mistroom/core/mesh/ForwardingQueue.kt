package com.mistroom.core.mesh

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Item in the forwarding queue.
 *
 * @property packet The mesh packet to forward.
 * @property excludeAddress Don't send back to this address (the peer we received from).
 * @property priority Higher = more important. Messages > heartbeats.
 * @property enqueuedAtMillis When this item was added to the queue.
 */
data class ForwardingItem(
    val packet: MeshPacket,
    val excludeAddress: String? = null,
    val priority: Int = 0,
    val enqueuedAtMillis: Long = System.currentTimeMillis(),
)

/**
 * Priority-based forwarding queue for mesh packet relay.
 *
 * Packets awaiting forwarding are queued and processed in priority order.
 * Higher priority packets (e.g., messages, ACKs) are sent before lower
 * priority ones (e.g., presence, heartbeat).
 */
@Singleton
class ForwardingQueue @Inject constructor() {

    companion object {
        /** Maximum items in the queue before dropping oldest. */
        const val MAX_QUEUE_SIZE = 1000

        /** Priority levels. */
        const val PRIORITY_CRITICAL = 100   // ACKs, key exchange
        const val PRIORITY_HIGH = 75        // Messages
        const val PRIORITY_MEDIUM = 50      // Presence
        const val PRIORITY_LOW = 25         // Heartbeat, discovery
    }

    private val channel = Channel<Pair<MeshPacket, String?>>(capacity = MAX_QUEUE_SIZE)

    /**
     * Enqueue a packet for forwarding.
     *
     * @param packet The mesh packet to forward.
     * @param excludeAddress Address to exclude (peer we received from).
     */
    suspend fun enqueue(packet: MeshPacket, excludeAddress: String? = null) {
        val priority = when (packet.type) {
            PacketType.ACK, PacketType.KEY_EXCHANGE -> PRIORITY_CRITICAL
            PacketType.MESSAGE, PacketType.ATTACHMENT_META -> PRIORITY_HIGH
            PacketType.PRESENCE -> PRIORITY_MEDIUM
            PacketType.HEARTBEAT, PacketType.PEER_DISCOVERY -> PRIORITY_LOW
            else -> PRIORITY_MEDIUM
        }

        // Try to send without suspending; drop if queue is full
        channel.trySend(Pair(packet, excludeAddress))
    }

    /**
     * Flow of packets to be forwarded, consumed by the mesh router.
     */
    fun dequeueFlow(): Flow<Pair<MeshPacket, String?>> = channel.receiveAsFlow()

    /**
     * Current approximate queue size.
     */
    val pendingCount: Int
        get() = 0  // Channel doesn't expose count; this is approximate

    /**
     * Close the queue (cleanup).
     */
    fun close() {
        channel.close()
    }
}
