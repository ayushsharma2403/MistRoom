package com.mistroom.core.transport.api

import com.mistroom.core.mesh.MeshPacket
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
 * Orchestrates multiple [MeshTransport] implementations to form a unified mesh network.
 *
 * The TransportManager:
 * - Starts/stops all registered transports
 * - Merges events from all transports into a single flow
 * - Routes outbound packets to the appropriate transport based on peer address
 * - Provides a unified view of all discovered peers
 */
@Singleton
class TransportManager @Inject constructor() {

    private val _transports = mutableMapOf<TransportType, MeshTransport>()
    private val _events = MutableSharedFlow<TransportEvent>(replay = 0, extraBufferCapacity = 64)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Merged event flow from all transports. */
    val events: SharedFlow<TransportEvent> = _events.asSharedFlow()

    /** All registered transports. */
    val transports: Map<TransportType, MeshTransport>
        get() = _transports.toMap()

    /**
     * Register a transport implementation.
     */
    fun registerTransport(transport: MeshTransport) {
        _transports[transport.type] = transport

        // Forward events from this transport to the merged flow
        scope.launch {
            transport.events.collect { event ->
                _events.emit(event)
            }
        }
    }

    /**
     * Start all registered transports.
     */
    suspend fun startAll() {
        _transports.values.forEach { transport ->
            try {
                transport.start()
            } catch (e: Exception) {
                _events.emit(
                    TransportEvent.StateChanged(transport.type, isActive = false)
                )
            }
        }
    }

    /**
     * Stop all registered transports.
     */
    suspend fun stopAll() {
        _transports.values.forEach { transport ->
            try {
                transport.stop()
            } catch (_: Exception) {
                // Best-effort shutdown
            }
        }
    }

    /**
     * Start a specific transport type.
     */
    suspend fun startTransport(type: TransportType) {
        _transports[type]?.start()
    }

    /**
     * Stop a specific transport type.
     */
    suspend fun stopTransport(type: TransportType) {
        _transports[type]?.stop()
    }

    /**
     * Send a packet to a specific peer. Picks the transport based on the peer's type.
     */
    suspend fun sendPacket(packet: MeshPacket, peer: TransportPeer): Boolean {
        val transport = _transports[peer.transportType] ?: return false
        return transport.sendPacket(packet, peer)
    }

    /**
     * Broadcast a packet across all active transports.
     *
     * @return Total number of peers the packet was sent to.
     */
    suspend fun broadcastPacket(packet: MeshPacket): Int {
        return _transports.values
            .filter { it.isActive }
            .sumOf { it.broadcastPacket(packet) }
    }

    /**
     * Get all connected peers across all transports.
     */
    fun getAllConnectedPeers(): List<TransportPeer> {
        return _transports.values.flatMap { it.getConnectedPeers() }
    }

    /**
     * Check if a specific transport type is currently active.
     */
    fun isTransportActive(type: TransportType): Boolean {
        return _transports[type]?.isActive == true
    }
}
