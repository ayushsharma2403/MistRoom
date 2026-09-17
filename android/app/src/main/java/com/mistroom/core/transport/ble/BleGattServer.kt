package com.mistroom.core.transport.ble

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/** Standard CCCD UUID for enabling BLE notifications. */
private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

/**
 * Event emitted by the GATT server when a remote client writes data.
 */
data class GattServerEvent(
    val device: BluetoothDevice,
    val data: ByteArray,
)

/**
 * BLE GATT Server (peripheral role).
 *
 * Opens a GATT service with three characteristics:
 * - [BleConstants.PACKET_CHAR_UUID]      — mesh packet exchange (write + notify)
 * - [BleConstants.MTU_CHAR_UUID]         — MTU negotiation (read)
 * - [BleConstants.FINGERPRINT_CHAR_UUID] — local fingerprint (read)
 *
 * Remote centrals write mesh packets to [PACKET_CHAR_UUID]. The server emits
 * each write to [packetWrites] for the [BleTransport] to process. The server
 * also sends notifications to subscribed clients when a packet should be pushed.
 */
@Singleton
class BleGattServer @Inject constructor(
    private val context: Context,
) {
    private val bluetoothManager: BluetoothManager =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager

    private var gattServer: BluetoothGattServer? = null

    // Clients that have enabled notifications on PACKET_CHAR
    private val notifySubscribers = mutableSetOf<BluetoothDevice>()

    // Connected central devices
    private val _connectedDevices = mutableSetOf<BluetoothDevice>()
    val connectedDevices: Set<BluetoothDevice> get() = _connectedDevices.toSet()

    private val _packetWrites = MutableSharedFlow<GattServerEvent>(extraBufferCapacity = 64)
    /** Emits raw bytes whenever a client writes to PACKET_CHAR. */
    val packetWrites: SharedFlow<GattServerEvent> = _packetWrites.asSharedFlow()

    private var localFingerprintBytes: ByteArray = ByteArray(16)

    // ── GATT Server Callback ────────────────────────────────────────────────

    private val callback = object : BluetoothGattServerCallback() {

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> _connectedDevices.add(device)
                BluetoothProfile.STATE_DISCONNECTED -> {
                    _connectedDevices.remove(device)
                    notifySubscribers.remove(device)
                }
            }
        }

        override fun onCharacteristicReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic,
        ) {
            val response = when (characteristic.uuid) {
                BleConstants.FINGERPRINT_CHAR_UUID -> localFingerprintBytes
                BleConstants.MTU_CHAR_UUID -> byteArrayOf(BleConstants.MAX_MTU.toByte())
                else -> byteArrayOf()
            }
            try {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, response)
            } catch (_: SecurityException) {}
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (characteristic.uuid == BleConstants.PACKET_CHAR_UUID) {
                _packetWrites.tryEmit(GattServerEvent(device, value))
            }
            if (responseNeeded) {
                try {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
                } catch (_: SecurityException) {}
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (descriptor.uuid == CCCD_UUID) {
                if (value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
                    notifySubscribers.add(device)
                } else {
                    notifySubscribers.remove(device)
                }
            }
            if (responseNeeded) {
                try {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
                } catch (_: SecurityException) {}
            }
        }
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Open the GATT server and register the MistRoom service.
     *
     * @param fingerprintHex 32-char hex fingerprint of the local device.
     */
    fun open(fingerprintHex: String) {
        localFingerprintBytes = fingerprintHex.chunked(2).take(16)
            .map { it.toInt(16).toByte() }.toByteArray()

        try {
            gattServer = bluetoothManager.openGattServer(context, callback)
            gattServer?.addService(buildService())
        } catch (_: SecurityException) {}
    }

    /** Close the GATT server and release resources. */
    fun close() {
        try {
            gattServer?.close()
        } catch (_: SecurityException) {}
        gattServer = null
        _connectedDevices.clear()
        notifySubscribers.clear()
    }

    /**
     * Notify all subscribed clients of a new inbound or relayed packet.
     *
     * @param data Raw serialized [com.mistroom.core.mesh.MeshPacket] bytes.
     */
    fun notifyAll(data: ByteArray) {
        val server = gattServer ?: return
        val char = server.getService(BleConstants.SERVICE_UUID)
            ?.getCharacteristic(BleConstants.PACKET_CHAR_UUID) ?: return

        @Suppress("DEPRECATION")
        char.value = data

        for (device in notifySubscribers.toSet()) {
            try {
                @Suppress("DEPRECATION")
                server.notifyCharacteristicChanged(device, char, false)
            } catch (_: SecurityException) {}
        }
    }

    // ── Private helpers ─────────────────────────────────────────────────────

    private fun buildService(): BluetoothGattService {
        val service = BluetoothGattService(
            BleConstants.SERVICE_UUID,
            BluetoothGattService.SERVICE_TYPE_PRIMARY,
        )

        // Packet characteristic — write (from central) + notify (to central)
        val packetChar = BluetoothGattCharacteristic(
            BleConstants.PACKET_CHAR_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE or
                BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        packetChar.addDescriptor(
            BluetoothGattDescriptor(
                CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
            )
        )
        service.addCharacteristic(packetChar)

        // MTU hint characteristic — read only
        service.addCharacteristic(
            BluetoothGattCharacteristic(
                BleConstants.MTU_CHAR_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ,
                BluetoothGattCharacteristic.PERMISSION_READ,
            )
        )

        // Fingerprint characteristic — read only
        service.addCharacteristic(
            BluetoothGattCharacteristic(
                BleConstants.FINGERPRINT_CHAR_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ,
                BluetoothGattCharacteristic.PERMISSION_READ,
            )
        )

        return service
    }
}
