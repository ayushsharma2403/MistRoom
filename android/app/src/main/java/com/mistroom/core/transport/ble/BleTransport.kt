package com.mistroom.core.transport.ble

import android.content.Context
import com.mistroom.core.mesh.MeshPacket
import com.mistroom.core.mesh.PacketSerializer
import com.mistroom.core.transport.api.MeshTransport
import com.mistroom.core.transport.api.TransportCapabilities
import com.mistroom.core.transport.api.TransportEvent
import com.mistroom.core.transport.api.TransportPeer
import com.mistroom.core.transport.api.TransportType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Concrete [MeshTransport] implementation for Bluetooth Low Energy.
 *
 * Wires together:
 * - [BleAdvertiser]  — peripheral broadcasting
 * - [BleScanner]     — central scanning
 * - [BleGattServer]  — receiving packets from connecting centrals
 * - [BleGattClient]  — sending packets to discovered peripherals
 * - [PacketSerializer] — binary encode/decode
 *
 * Lifecycle:
 * ```
 * start() → advertiser.start() + scanner.startScan() + gattServer.open()
 * stop()  → advertiser.stop() + scanner.stopScan() + gattServer.close() + client.disconnectAll()
 * ```
 */
@Singleton
class BleTransport @Inject constructor(
    private val context: Context,
    private val advertiser: BleAdvertiser,
    private val scanner: BleScanner,
    private val gattServer: BleGattServer,
    private val gattClient: BleGattClient,
    private val serializer: PacketSerializer,
) : MeshTransport {

    override val type: TransportType = TransportType.BLE

    override val capabilities: TransportCapabilities = TransportCapabilities(
        maxMtuBytes = BleConstants.MAX_MTU,
        supportsMulticast = false,
        requiresPairing = false,
        approximateRangeMeters = 50,
        supportsBackground = true,
    )

    override var isActive: Boolean = false
        private set

    private val _events = MutableSharedFlow<TransportEvent>(extraBufferCapacity = 128)
    override val events: Flow<TransportEvent> = _events.asSharedFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** address → TransportPeer for all currently known peers. */
    private val peerMap = ConcurrentHashMap<String, TransportPeer>()

    /** Local fingerprint, set on [start]. */
    private var localFingerprint: String = ""

    // ── MeshTransport ───────────────────────────────────────────────────────

    override suspend fun start() {
        if (isActive) return
        isActive = true

        // Resolve local fingerprint from DataStore / KeyStore — placeholder for now
        localFingerprint = "0000000000000000000000000000dead" // replaced by DeviceIdentity in Phase 5

        advertiser.start(localFingerprint)
        scanner.startScan()
        gattServer.open(localFingerprint)

        listenToScanner()
        listenToGattServerWrites()
        listenToGattClientNotifications()

        _events.emit(TransportEvent.StateChanged(TransportType.BLE, isActive = true))
    }

    override suspend fun stop() {
        if (!isActive) return
        isActive = false

        advertiser.stop()
        scanner.stopScan()
        gattServer.close()
        gattClient.disconnectAll()
        peerMap.clear()

        _events.emit(TransportEvent.StateChanged(TransportType.BLE, isActive = false))
    }

    override suspend fun sendPacket(packet: MeshPacket, peer: TransportPeer): Boolean {
        val data = serializer.serialize(packet)
        val ok = gattClient.writePacket(peer.address, data)
        _events.emit(TransportEvent.SendResult(packet.packetId, ok))
        return ok
    }

    override suspend fun broadcastPacket(packet: MeshPacket): Int {
        val data = serializer.serialize(packet)
        var sent = 0
        for (address in gattClient.connectedAddresses()) {
            if (gattClient.writePacket(address, data)) sent++
        }
        // Also notify GATT server subscribers (they connected to us)
        gattServer.notifyAll(data)
        return sent
    }

    override fun getConnectedPeers(): List<TransportPeer> = peerMap.values.toList()

    // ── Internal listeners ──────────────────────────────────────────────────

    /** When the scanner finds a new MistRoom device, connect as central. */
    private fun listenToScanner() {
        scope.launch {
            scanner.scanResults.collect { blePeer ->
                if (peerMap.containsKey(blePeer.address)) return@collect

                val fingerprint = gattClient.connect(
                    android.bluetooth.BluetoothAdapter.getDefaultAdapter()
                        ?.getRemoteDevice(blePeer.address) ?: return@collect
                )

                val peer = TransportPeer(
                    fingerprint = fingerprint ?: blePeer.fingerprint,
                    transportType = TransportType.BLE,
                    address = blePeer.address,
                    rssi = blePeer.rssi,
                )
                peerMap[blePeer.address] = peer
                _events.emit(TransportEvent.PeerDiscovered(peer))
            }
        }
    }

    /** When a central writes to our GATT server, deserialize and emit as PacketReceived. */
    private fun listenToGattServerWrites() {
        scope.launch {
            gattServer.packetWrites.collect { (device, data) ->
                val peer = peerMap.getOrPut(device.address) {
                    TransportPeer(
                        fingerprint = null,
                        transportType = TransportType.BLE,
                        address = device.address,
                    )
                }
                decodeAndEmit(data, peer)
            }
        }
    }

    /** When a peripheral notifies us (we are central), deserialize and emit. */
    private fun listenToGattClientNotifications() {
        scope.launch {
            gattClient.packetNotifications.collect { (address, data) ->
                val peer = peerMap[address] ?: TransportPeer(
                    fingerprint = gattClient.fingerprintFor(address),
                    transportType = TransportType.BLE,
                    address = address,
                )
                decodeAndEmit(data, peer)
            }
        }
    }

    private suspend fun decodeAndEmit(data: ByteArray, fromPeer: TransportPeer) {
        try {
            val packet = serializer.deserialize(data)
            _events.emit(TransportEvent.PacketReceived(packet, fromPeer))
        } catch (_: IllegalArgumentException) {
            // Malformed packet — discard silently
        }
    }
}
