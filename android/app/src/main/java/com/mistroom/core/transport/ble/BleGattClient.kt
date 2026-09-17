package com.mistroom.core.transport.ble

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.content.Context
import android.os.Build
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

/**
 * BLE GATT client (central role).
 *
 * Manages a pool of outbound [BluetoothGatt] connections (max 7 — Android
 * platform limit). For each peer:
 *  1. Connects and negotiates the highest possible MTU (up to 517 bytes).
 *  2. Reads [BleConstants.FINGERPRINT_CHAR_UUID] to authenticate the peer.
 *  3. Subscribes to notifications on [BleConstants.PACKET_CHAR_UUID].
 *  4. Writes outbound packets, chunking them if payload > (mtu - 3).
 *
 * Received notifications are emitted on [packetNotifications].
 */
@Singleton
class BleGattClient @Inject constructor(
    private val context: Context,
) {
    companion object {
        /** Android supports ~7 concurrent GATT connections. */
        const val MAX_CONNECTIONS = 7
    }

    // address → BluetoothGatt
    private val connections = ConcurrentHashMap<String, BluetoothGatt>()

    // address → negotiated MTU (payload capacity = mtu - 3)
    private val mtuMap = ConcurrentHashMap<String, Int>()

    // address → remote fingerprint (read from FINGERPRINT_CHAR)
    private val fingerprintMap = ConcurrentHashMap<String, String>()

    // Pending MTU/write completions
    private val pendingMtu = ConcurrentHashMap<String, CompletableDeferred<Int>>()
    private val pendingWrite = ConcurrentHashMap<String, CompletableDeferred<Boolean>>()

    private val writeMutex = Mutex()

    private val _packetNotifications = MutableSharedFlow<Pair<String, ByteArray>>(
        extraBufferCapacity = 128,
    )
    /** Emits (address, rawPacketBytes) on every PACKET_CHAR notification. */
    val packetNotifications: SharedFlow<Pair<String, ByteArray>> =
        _packetNotifications.asSharedFlow()

    // ── Connection management ───────────────────────────────────────────────

    /**
     * Connect to a BLE peer (central → peripheral).
     *
     * No-op if already connected or connection pool is full.
     *
     * @return The remote fingerprint hex if connection succeeded, null otherwise.
     */
    suspend fun connect(device: BluetoothDevice): String? {
        val address = device.address
        if (connections.containsKey(address)) return fingerprintMap[address]
        if (connections.size >= MAX_CONNECTIONS) return null

        val mtuDeferred = CompletableDeferred<Int>()
        pendingMtu[address] = mtuDeferred

        val gatt = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                device.connectGatt(context, false, buildCallback(address), BluetoothDevice.TRANSPORT_LE)
            } else {
                @Suppress("DEPRECATION")
                device.connectGatt(context, false, buildCallback(address))
            }
        } catch (_: SecurityException) {
            pendingMtu.remove(address)
            return null
        }

        connections[address] = gatt

        // Wait for MTU negotiation (triggered in onServicesDiscovered)
        val mtu = try {
            mtuDeferred.await()
        } catch (_: Exception) {
            disconnect(address)
            return null
        }
        mtuMap[address] = mtu

        return fingerprintMap[address]
    }

    /** Disconnect from a peer and release the GATT connection. */
    fun disconnect(address: String) {
        connections.remove(address)?.let { gatt ->
            try {
                gatt.disconnect()
                gatt.close()
            } catch (_: SecurityException) {}
        }
        mtuMap.remove(address)
        fingerprintMap.remove(address)
        pendingMtu.remove(address)?.cancel()
        pendingWrite.remove(address)?.cancel()
    }

    /** Disconnect all peers. */
    fun disconnectAll() {
        connections.keys.toList().forEach { disconnect(it) }
    }

    /** All currently connected peer addresses. */
    fun connectedAddresses(): Set<String> = connections.keys.toSet()

    /** Fingerprint for a connected peer, or null if not yet read. */
    fun fingerprintFor(address: String): String? = fingerprintMap[address]

    // ── Packet writing ──────────────────────────────────────────────────────

    /**
     * Write a serialized mesh packet to [BleConstants.PACKET_CHAR_UUID] on the
     * given peer. Chunks the data into MTU-sized pieces if needed.
     *
     * @return true if all chunks were written successfully.
     */
    suspend fun writePacket(address: String, data: ByteArray): Boolean {
        val gatt = connections[address] ?: return false
        val service = gatt.getService(BleConstants.SERVICE_UUID) ?: return false
        val char = service.getCharacteristic(BleConstants.PACKET_CHAR_UUID) ?: return false

        val payloadCapacity = (mtuMap[address] ?: BleConstants.DEFAULT_MTU) - 3
        val chunks = data.toList().chunked(payloadCapacity).map { it.toByteArray() }

        return writeMutex.withLock {
            chunks.all { chunk ->
                val deferred = CompletableDeferred<Boolean>()
                pendingWrite[address] = deferred

                @Suppress("DEPRECATION")
                char.value = chunk
                val ok = try {
                    @Suppress("DEPRECATION")
                    gatt.writeCharacteristic(char)
                } catch (_: SecurityException) {
                    false
                }

                if (!ok) {
                    deferred.complete(false)
                }

                try {
                    deferred.await()
                } catch (_: Exception) {
                    false
                }
            }
        }
    }

    // ── GATT Callback ───────────────────────────────────────────────────────

    private fun buildCallback(address: String) = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (newState == android.bluetooth.BluetoothProfile.STATE_CONNECTED) {
                try {
                    gatt.discoverServices()
                } catch (_: SecurityException) {}
            } else if (newState == android.bluetooth.BluetoothProfile.STATE_DISCONNECTED) {
                disconnect(address)
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                pendingMtu[address]?.completeExceptionally(Exception("Service discovery failed"))
                return
            }

            // 1. Request max MTU
            try {
                gatt.requestMtu(BleConstants.MAX_MTU)
            } catch (_: SecurityException) {
                pendingMtu[address]?.complete(BleConstants.DEFAULT_MTU)
            }

            // 2. Read fingerprint characteristic
            val fpChar = gatt.getService(BleConstants.SERVICE_UUID)
                ?.getCharacteristic(BleConstants.FINGERPRINT_CHAR_UUID)
            if (fpChar != null) {
                try {
                    gatt.readCharacteristic(fpChar)
                } catch (_: SecurityException) {}
            }

            // 3. Subscribe to PACKET_CHAR notifications
            val packetChar = gatt.getService(BleConstants.SERVICE_UUID)
                ?.getCharacteristic(BleConstants.PACKET_CHAR_UUID)
            if (packetChar != null) {
                try {
                    gatt.setCharacteristicNotification(packetChar, true)
                    val descriptor = packetChar.getDescriptor(CCCD_UUID)
                    @Suppress("DEPRECATION")
                    descriptor?.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    descriptor?.let { gatt.writeDescriptor(it) }
                } catch (_: SecurityException) {}
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            pendingMtu[address]?.complete(mtu)
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            if (characteristic.uuid == BleConstants.FINGERPRINT_CHAR_UUID && status == BluetoothGatt.GATT_SUCCESS) {
                val bytes = characteristic.value ?: return
                val hex = bytes.joinToString("") { "%02x".format(it) }
                fingerprintMap[address] = hex
            }
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            pendingWrite[address]?.complete(status == BluetoothGatt.GATT_SUCCESS)
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) {
            if (characteristic.uuid == BleConstants.PACKET_CHAR_UUID) {
                characteristic.value?.let { data ->
                    _packetNotifications.tryEmit(address to data)
                }
            }
        }
    }
}
