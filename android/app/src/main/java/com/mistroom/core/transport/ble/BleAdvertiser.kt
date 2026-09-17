package com.mistroom.core.transport.ble

import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.ParcelUuid
import javax.inject.Inject
import javax.inject.Singleton

/**
 * BLE peripheral advertiser.
 *
 * Broadcasts the MistRoom [BleConstants.SERVICE_UUID] plus the first 16 bytes
 * of the local device fingerprint in the service data. Peers use this to
 * pre-screen MistRoom devices before connecting.
 *
 * Advertising is limited in time by Android to conserve battery; the
 * [BleGattService] restarts it on a periodic schedule if needed.
 */
@Singleton
class BleAdvertiser @Inject constructor(
    private val context: Context,
) {
    private val bluetoothManager: BluetoothManager =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager

    private val advertiser: BluetoothLeAdvertiser?
        get() = bluetoothManager.adapter?.bluetoothLeAdvertiser

    private var isAdvertising = false

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
            isAdvertising = true
        }

        override fun onStartFailure(errorCode: Int) {
            isAdvertising = false
        }
    }

    /**
     * Start advertising.
     *
     * @param fingerprintHex 32-char hex fingerprint of the local device.
     *   The first 16 bytes (32 hex chars → 16 bytes) are embedded in the
     *   service data so scanning peers can filter without connecting.
     */
    fun start(fingerprintHex: String) {
        if (isAdvertising) return
        val adv = advertiser ?: return

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0) // Advertise indefinitely
            .build()

        val serviceData = fingerprintToBytes(fingerprintHex)

        val data = AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid(BleConstants.SERVICE_UUID))
            .addServiceData(ParcelUuid(BleConstants.SERVICE_UUID), serviceData)
            .setIncludeDeviceName(false)   // Save space in advertisement payload
            .setIncludeTxPowerLevel(false)
            .build()

        try {
            adv.startAdvertising(settings, data, advertiseCallback)
        } catch (_: SecurityException) {
            // BLUETOOTH_ADVERTISE permission not granted — handled by PermissionManager
        }
    }

    /** Stop advertising. */
    fun stop() {
        if (!isAdvertising) return
        try {
            advertiser?.stopAdvertising(advertiseCallback)
        } catch (_: SecurityException) {
            // Best-effort
        }
        isAdvertising = false
    }

    /** Whether the device is currently advertising. */
    fun isAdvertising(): Boolean = isAdvertising

    /**
     * Convert the first 16 bytes of a 32-char hex fingerprint to a [ByteArray].
     * Truncates longer fingerprints to 16 bytes for BLE payload space.
     */
    private fun fingerprintToBytes(fingerprintHex: String): ByteArray {
        val hex = fingerprintHex.take(32) // 16 bytes max
        return ByteArray(hex.length / 2) { i ->
            hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
    }
}
