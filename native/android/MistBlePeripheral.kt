package org.mistroom.app.ble

import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.os.ParcelUuid
import android.util.Base64
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.*

@CapacitorPlugin(name = "MistBlePeripheral")
class MistBlePeripheralPlugin : Plugin() {

    private val SERVICE_UUID = UUID.fromString("6e6d6973-7400-4d53-5400-000000000001")
    private val CHAR_WRITE_UUID = UUID.fromString("6e6d6973-7400-4d53-5400-000000000002")
    private val CHAR_NOTIFY_UUID = UUID.fromString("6e6d6973-7400-4d53-5400-000000000003")

    private var bluetoothManager: BluetoothManager? = null
    private var bluetoothAdapter: BluetoothAdapter? = null
    private var bleAdvertiser: BluetoothLeAdvertiser? = null
    private var gattServer: BluetoothGattServer? = null

    private val connectedDevices = mutableSetOf<BluetoothDevice>()

    override fun load() {
        bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        bluetoothAdapter = bluetoothManager?.adapter
        bleAdvertiser = bluetoothAdapter?.bluetoothLeAdvertiser
    }

    @PluginMethod
    fun startAdvertising(call: PluginCall) {
        if (bleAdvertiser == null) {
            call.reject("BLE Advertiser unavailable or Bluetooth off")
            return
        }

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .build()

        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addServiceUuid(ParcelUuid(SERVICE_UUID))
            .build()

        bleAdvertiser?.startAdvertising(settings, data, object : AdvertiseCallback() {
            override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
                startGattServer()
                call.resolve()
            }

            override fun onStartFailure(errorCode: Int) {
                call.reject("Advertising failed: code $errorCode")
            }
        })
    }

    @PluginMethod
    fun stopAdvertising(call: PluginCall) {
        bleAdvertiser?.stopAdvertising(object : AdvertiseCallback() {})
        gattServer?.close()
        gattServer = null
        connectedDevices.clear()
        call.resolve()
    }

    private fun startGattServer() {
        if (gattServer != null) return

        gattServer = bluetoothManager?.openGattServer(context, object : BluetoothGattServerCallback() {
            override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    connectedDevices.add(device)
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    connectedDevices.remove(device)
                }
            }

            override fun onCharacteristicWriteRequest(
                device: BluetoothDevice, requestId: Int, characteristic: BluetoothGattCharacteristic,
                preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?
            ) {
                if (responseNeeded) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                }
                if (value != null) {
                    val ret = JSObject()
                    ret.put("deviceId", device.address)
                    ret.put("value", Base64.encodeToString(value, Base64.NO_WRAP))
                    notifyListeners("packetReceived", ret)
                }
            }
        })

        val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)

        val writeChar = BluetoothGattCharacteristic(
            CHAR_WRITE_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE
        )

        val notifyChar = BluetoothGattCharacteristic(
            CHAR_NOTIFY_UUID,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ
        )

        service.addCharacteristic(writeChar)
        service.addCharacteristic(notifyChar)
        gattServer?.addService(service)
    }

    @PluginMethod
    fun notify(call: PluginCall) {
        val bytesB64 = call.getString("value") ?: ""
        val bytes = Base64.decode(bytesB64, Base64.NO_WRAP)
        val charNotify = gattServer?.getService(SERVICE_UUID)?.getCharacteristic(CHAR_NOTIFY_UUID)

        if (charNotify != null) {
            charNotify.value = bytes
            for (device in connectedDevices) {
                gattServer?.notifyCharacteristicChanged(device, charNotify, false)
            }
            call.resolve()
        } else {
            call.reject("Notification characteristic not ready")
        }
    }
}
