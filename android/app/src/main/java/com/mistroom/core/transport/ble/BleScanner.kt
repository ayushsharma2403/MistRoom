package com.mistroom.core.transport.ble

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.ParcelUuid
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * BLE GATT service UUID for MistRoom mesh protocol.
 */
object BleConstants {
    /** Custom service UUID for MistRoom. */
    const val SERVICE_UUID_STRING = "0000FACE-0000-1000-8000-00805F9B34FB"
    val SERVICE_UUID: java.util.UUID = java.util.UUID.fromString(SERVICE_UUID_STRING)

    /** Characteristic for mesh packet exchange. */
    const val PACKET_CHAR_UUID_STRING = "0000FACE-0001-1000-8000-00805F9B34FB"
    val PACKET_CHAR_UUID: java.util.UUID = java.util.UUID.fromString(PACKET_CHAR_UUID_STRING)

    /** Characteristic for MTU negotiation. */
    const val MTU_CHAR_UUID_STRING = "0000FACE-0002-1000-8000-00805F9B34FB"
    val MTU_CHAR_UUID: java.util.UUID = java.util.UUID.fromString(MTU_CHAR_UUID_STRING)

    /** Characteristic for peer fingerprint advertisement. */
    const val FINGERPRINT_CHAR_UUID_STRING = "0000FACE-0003-1000-8000-00805F9B34FB"
    val FINGERPRINT_CHAR_UUID: java.util.UUID = java.util.UUID.fromString(FINGERPRINT_CHAR_UUID_STRING)

    /** Default scan interval in milliseconds. */
    const val SCAN_INTERVAL_MS = 5000L

    /** Default BLE MTU. */
    const val DEFAULT_MTU = 23

    /** Maximum requestable MTU. */
    const val MAX_MTU = 517
}

/**
 * BLE scan result event.
 */
data class BleScanPeer(
    val address: String,         // MAC address
    val rssi: Int,
    val fingerprint: String?,    // From advertisement data, if available
    val serviceUuids: List<java.util.UUID>,
)

/**
 * BLE scanner that discovers nearby MistRoom devices by filtering on the
 * custom GATT service UUID.
 */
@Singleton
class BleScanner @Inject constructor(
    private val context: Context,
) {
    private val bluetoothManager: BluetoothManager =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager

    private val bluetoothAdapter: BluetoothAdapter?
        get() = bluetoothManager.adapter

    private val scanner: BluetoothLeScanner?
        get() = bluetoothAdapter?.bluetoothLeScanner

    private val _scanResults = MutableSharedFlow<BleScanPeer>(extraBufferCapacity = 64)
    val scanResults: SharedFlow<BleScanPeer> = _scanResults.asSharedFlow()

    private var isScanning = false

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val peer = BleScanPeer(
                address = result.device.address,
                rssi = result.rssi,
                fingerprint = extractFingerprint(result),
                serviceUuids = result.scanRecord?.serviceUuids?.map { it.uuid } ?: emptyList(),
            )
            _scanResults.tryEmit(peer)
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
            results.forEach { onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, it) }
        }

        override fun onScanFailed(errorCode: Int) {
            isScanning = false
        }
    }

    /**
     * Start scanning for MistRoom BLE devices.
     */
    fun startScan() {
        if (isScanning) return

        val filters = listOf(
            ScanFilter.Builder()
                .setServiceUuid(ParcelUuid(BleConstants.SERVICE_UUID))
                .build()
        )

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setReportDelay(0)
            .build()

        try {
            scanner?.startScan(filters, settings, scanCallback)
            isScanning = true
        } catch (e: SecurityException) {
            // Permission not granted — handle gracefully
            isScanning = false
        }
    }

    /**
     * Stop scanning.
     */
    fun stopScan() {
        if (!isScanning) return
        try {
            scanner?.stopScan(scanCallback)
        } catch (_: SecurityException) {
            // Best-effort stop
        }
        isScanning = false
    }

    /**
     * Check if Bluetooth is available and enabled.
     */
    fun isBluetoothAvailable(): Boolean {
        return bluetoothAdapter?.isEnabled == true
    }

    /**
     * Extract the device fingerprint from BLE advertisement data.
     * The fingerprint may be embedded in the service data or manufacturer data.
     */
    private fun extractFingerprint(result: ScanResult): String? {
        val serviceData = result.scanRecord?.getServiceData(ParcelUuid(BleConstants.SERVICE_UUID))
        if (serviceData != null && serviceData.size >= 16) {
            return serviceData.take(16).joinToString("") { "%02x".format(it) }
        }
        return null
    }
}
