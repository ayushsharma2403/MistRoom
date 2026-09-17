package com.mistroom.core.transport.api

import com.mistroom.core.mesh.MeshPacket
import kotlinx.coroutines.flow.Flow

/**
 * Types of physical transport available for mesh communication.
 */
enum class TransportType {
    BLE,
    WIFI_DIRECT,
    WIFI_AWARE,
    INTERNET_RELAY,
}

/**
 * Describes what a transport can do.
 */
data class TransportCapabilities(
    val maxMtuBytes: Int,
    val supportsMulticast: Boolean,
    val requiresPairing: Boolean,
    val approximateRangeMeters: Int,
    val supportsBackground: Boolean,
)

/**
 * A discovered peer on a transport.
 */
data class TransportPeer(
    val fingerprint: String?,       // null if unknown (not yet authenticated)
    val transportType: TransportType,
    val address: String,            // MAC, IP, or relay URL
    val rssi: Int? = null,          // BLE signal strength
    val lastSeenMillis: Long = System.currentTimeMillis(),
)

/**
 * Transport state events.
 */
sealed class TransportEvent {
    data class PeerDiscovered(val peer: TransportPeer) : TransportEvent()
    data class PeerLost(val peer: TransportPeer) : TransportEvent()
    data class PacketReceived(val packet: MeshPacket, val peer: TransportPeer) : TransportEvent()
    data class SendResult(val packetId: String, val success: Boolean, val error: String? = null) : TransportEvent()
    data class StateChanged(val type: TransportType, val isActive: Boolean) : TransportEvent()
}

/**
 * Interface for a physical mesh transport (BLE, Wi-Fi Direct, relay, etc.).
 *
 * Each transport implementation handles discovery, connection, and raw packet
 * transfer over its medium. The [TransportManager] orchestrates multiple
 * transports to create a unified mesh.
 */
interface MeshTransport {

    /** The type of this transport. */
    val type: TransportType

    /** Static capabilities of this transport. */
    val capabilities: TransportCapabilities

    /** Whether this transport is currently active and scanning. */
    val isActive: Boolean

    /** Flow of transport events (peer discovery, packets, state changes). */
    val events: Flow<TransportEvent>

    /**
     * Start the transport: begin advertising, scanning, or connecting.
     */
    suspend fun start()

    /**
     * Stop the transport and release resources.
     */
    suspend fun stop()

    /**
     * Send a mesh packet to a specific peer.
     *
     * @param packet The serialized mesh packet.
     * @param peer The target peer.
     * @return `true` if the packet was sent successfully.
     */
    suspend fun sendPacket(packet: MeshPacket, peer: TransportPeer): Boolean

    /**
     * Broadcast a mesh packet to all connected peers on this transport.
     *
     * @param packet The serialized mesh packet.
     * @return Number of peers the packet was sent to.
     */
    suspend fun broadcastPacket(packet: MeshPacket): Int

    /**
     * Get the list of currently known peers on this transport.
     */
    fun getConnectedPeers(): List<TransportPeer>
}
