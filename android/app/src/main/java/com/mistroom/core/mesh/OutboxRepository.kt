package com.mistroom.core.mesh

import com.mistroom.core.db.OutboxDao
import com.mistroom.core.db.OutboxMessage
import com.mistroom.core.db.OutboxStatus
import com.mistroom.core.transport.api.TransportEvent
import com.mistroom.core.transport.api.TransportManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Manages the offline message outbox.
 *
 * When [MeshRouter] cannot deliver a message (no connected peer with the
 * target fingerprint), [enqueue] stores it in the Room database. Whenever
 * [TransportManager] emits a [TransportEvent.PeerDiscovered], this repository
 * checks for pending messages addressed to that peer and retries delivery.
 *
 * Messages are retired after [OutboxMessage.MAX_ATTEMPTS] failures and
 * purged once delivered or older than [OutboxMessage.MAX_AGE_MS].
 */
@Singleton
class OutboxRepository @Inject constructor(
    private val outboxDao: OutboxDao,
    private val transportManager: TransportManager,
    private val meshRouter: MeshRouter,
    private val serializer: PacketSerializer,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * Start listening to transport events to trigger retries on peer discovery
     * and clean up on ACK receipt.
     */
    fun start() {
        scope.launch { listenForPeerDiscovery() }
        scope.launch { listenForAcks() }
        scope.launch { periodicPurge() }
    }

    /**
     * Enqueue a [MeshPacket] for deferred delivery.
     *
     * Should be called when [MeshRouter.sendPacket] returns false because no
     * peer is reachable.
     */
    suspend fun enqueue(packet: MeshPacket) {
        val recipient = packet.recipientFingerprint ?: return // Don't queue broadcasts
        outboxDao.insert(
            OutboxMessage(
                id = packet.packetId,
                recipientFingerprint = recipient,
                encryptedPayload = packet.payload,
                packetType = packet.type.value.toInt(),
                ttl = packet.ttl.toInt(),
            )
        )
    }

    /**
     * Attempt delivery of all pending messages for a specific peer fingerprint.
     */
    suspend fun retryFor(fingerprint: String) {
        val pending = outboxDao.getPendingFor(fingerprint)
        for (msg in pending) {
            attemptDelivery(msg)
        }
    }

    // ── Internal ────────────────────────────────────────────────────────────

    private suspend fun attemptDelivery(msg: OutboxMessage) {
        outboxDao.incrementAttempts(msg.id)

        val packet = MeshPacket(
            packetId = msg.id,
            type = PacketType.fromByte(msg.packetType.toByte()),
            senderFingerprint = meshRouter.localFingerprint,
            recipientFingerprint = msg.recipientFingerprint,
            ttl = msg.ttl.toByte(),
            payload = msg.encryptedPayload,
        )

        val delivered = meshRouter.sendPacket(packet)

        if (delivered) {
            outboxDao.markSent(msg.id)
        } else if (msg.attempts + 1 >= OutboxMessage.MAX_ATTEMPTS) {
            outboxDao.markFailed(msg.id)
        }
        // Otherwise leave as PENDING for next peer-discovery retry
    }

    private suspend fun listenForPeerDiscovery() {
        transportManager.events.collect { event ->
            if (event is TransportEvent.PeerDiscovered) {
                val fingerprint = event.peer.fingerprint ?: return@collect
                retryFor(fingerprint)
            }
        }
    }

    private suspend fun listenForAcks() {
        meshRouter.events.collect { event ->
            if (event is MeshEvent.AckReceived) {
                // The ACK payload is the original packet ID
                outboxDao.markSent(event.originalPacketId)
            }
        }
    }

    private suspend fun periodicPurge() {
        while (true) {
            kotlinx.coroutines.delay(60 * 60 * 1000L) // Every hour
            val cutoff = System.currentTimeMillis() - OutboxMessage.MAX_AGE_MS
            outboxDao.purgeOld(cutoff)
        }
    }
}
