package com.mistroom.core.mesh

import com.mistroom.core.transport.api.TransportManager
import com.mistroom.core.transport.api.TransportPeer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Events emitted by the mesh router for the application layer.
 */
sealed class MeshEvent {
    /** A message packet addressed to this device was received. */
    data class MessageReceived(val packet: MeshPacket) : MeshEvent()

    /** An ACK was received for a previously sent packet. */
    data class AckReceived(val originalPacketId: String) : MeshEvent()

    /** A key exchange request was received from a peer. */
    data class KeyExchangeReceived(val packet: MeshPacket) : MeshEvent()

    /** A presence announcement was received. */
    data class PresenceReceived(val fingerprint: String, val isOnline: Boolean) : MeshEvent()

    /** A forwarded packet was relayed through this device. */
    data class PacketForwarded(val packetId: String, val hopCount: Int) : MeshEvent()
}

/**
 * Core mesh routing algorithm.
 *
 * Responsibilities:
 * - Receive raw packets from all transports via [TransportManager]
 * - Deduplicate packets (discard already-seen packet IDs)
 * - Check TTL/hop count (discard expired packets)
 * - Deliver packets addressed to this device to the application layer
 * - Forward packets addressed to other devices (store-and-forward mesh)
 * - Manage the forwarding queue for multi-hop delivery
 */
@Singleton
class MeshRouter @Inject constructor(
    private val transportManager: TransportManager,
    private val dedupCache: DedupCache,
    private val forwardingQueue: ForwardingQueue,
    private val packetSerializer: PacketSerializer,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val _events = MutableSharedFlow<MeshEvent>(extraBufferCapacity = 64)

    /** Application-level mesh events. */
    val events: SharedFlow<MeshEvent> = _events.asSharedFlow()

    /** This device's fingerprint, set during initialization. */
    var localFingerprint: String = ""
        private set

    /**
     * Initialize the router with the local device fingerprint and start
     * listening for packets from all transports.
     */
    fun initialize(fingerprint: String) {
        localFingerprint = fingerprint

        // Listen for incoming packets from all transports
        scope.launch {
            transportManager.events.collect { event ->
                when (event) {
                    is com.mistroom.core.transport.api.TransportEvent.PacketReceived -> {
                        handleIncomingPacket(event.packet, event.peer)
                    }
                    else -> { /* Transport state events handled elsewhere */ }
                }
            }
        }

        // Process the forwarding queue
        scope.launch {
            processForwardingQueue()
        }
    }

    /**
     * Send a new packet from this device.
     */
    suspend fun sendPacket(packet: MeshPacket): Boolean {
        // Mark our own packet as seen so we don't re-process it
        dedupCache.markSeen(packet.packetId)

        // If recipient is known and connected, send directly
        val peers = transportManager.getAllConnectedPeers()
        val directPeer = peers.find { it.fingerprint == packet.recipientFingerprint }

        return if (directPeer != null) {
            transportManager.sendPacket(packet, directPeer)
        } else if (packet.isBroadcast) {
            transportManager.broadcastPacket(packet) > 0
        } else {
            // No direct route — broadcast for mesh forwarding
            transportManager.broadcastPacket(packet) > 0
        }
    }

    /**
     * Handle a packet received from any transport.
     */
    private suspend fun handleIncomingPacket(packet: MeshPacket, fromPeer: TransportPeer) {
        // 1. Deduplication
        if (dedupCache.isDuplicate(packet.packetId)) {
            return
        }

        // 2. TTL check
        if (packet.isExpired) {
            return
        }

        // 3. Route the packet
        if (isAddressedToUs(packet)) {
            deliverLocally(packet)
        } else {
            // Forward to other peers (mesh relay)
            forwardPacket(packet, fromPeer)
        }
    }

    /**
     * Check if the packet is addressed to this device.
     */
    private fun isAddressedToUs(packet: MeshPacket): Boolean {
        return packet.recipientFingerprint == localFingerprint || packet.isBroadcast
    }

    /**
     * Deliver a packet to the local application layer.
     */
    private suspend fun deliverLocally(packet: MeshPacket) {
        when (packet.type) {
            PacketType.MESSAGE -> {
                _events.emit(MeshEvent.MessageReceived(packet))
            }
            PacketType.ACK -> {
                _events.emit(MeshEvent.AckReceived(
                    String(packet.payload)  // ACK payload contains original packet ID
                ))
            }
            PacketType.KEY_EXCHANGE -> {
                _events.emit(MeshEvent.KeyExchangeReceived(packet))
            }
            PacketType.PRESENCE -> {
                _events.emit(MeshEvent.PresenceReceived(
                    fingerprint = packet.senderFingerprint,
                    isOnline = packet.payload.isNotEmpty() && packet.payload[0] == 1.toByte(),
                ))
            }
            else -> {
                // HEARTBEAT, PEER_DISCOVERY, etc. — handled at transport layer
            }
        }
    }

    /**
     * Forward a packet to other peers (multi-hop mesh routing).
     */
    private suspend fun forwardPacket(packet: MeshPacket, fromPeer: TransportPeer) {
        val forwarded = packet.forwarded()

        if (forwarded.isExpired) {
            return  // Don't forward expired packets
        }

        // Add to forwarding queue for prioritized delivery
        forwardingQueue.enqueue(forwarded, excludeAddress = fromPeer.address)

        _events.emit(MeshEvent.PacketForwarded(
            packetId = packet.packetId,
            hopCount = forwarded.hopCount.toInt(),
        ))
    }

    /**
     * Continuously process the forwarding queue, sending packets to connected peers.
     */
    private suspend fun processForwardingQueue() {
        forwardingQueue.dequeueFlow().collect { (packet, excludeAddress) ->
            val peers = transportManager.getAllConnectedPeers()
                .filter { it.address != excludeAddress }

            for (peer in peers) {
                transportManager.sendPacket(packet, peer)
            }
        }
    }
}
