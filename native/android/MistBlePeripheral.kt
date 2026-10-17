package org.mistroom.app.ble

import android.app.*
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Base64
import androidx.core.app.NotificationCompat
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.*

/**
 * Android Foreground Service maintaining persistent Bluetooth mesh operations
 * and displaying the required sticky notification "MistRoom mesh is running".
 */
class MistMeshForegroundService : Service() {

    companion object {
        const val CHANNEL_ID = "mistroom_mesh_service_channel"
        const val NOTIFICATION_ID = 1001

        fun startService(context: Context) {
            val intent = Intent(context, MistMeshForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopService(context: Context) {
            val intent = Intent(context, MistMeshForegroundService::class.java)
            context.stopService(intent)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("MistRoom")
            .setContentText("MistRoom mesh is running")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        startForeground(NOTIFICATION_ID, notification)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "MistRoom Mesh Service",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps MistRoom peer-to-peer BLE mesh active in the background"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }
}

/**
 * Receiver for Exact Alarms scheduled via AlarmManager for Safe-walk expiry
 */
class MistAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val payload = intent.getStringExtra("actionPayload") ?: "{}"
        val broadcastIntent = Intent("org.mistroom.app.SAFEWALK_ALARM_FIRED").apply {
            putExtra("payload", payload)
            setPackage(context.packageName)
        }
        context.sendBroadcast(broadcastIntent)
    }
}

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

        // Start Android foreground service with persistent notification
        MistMeshForegroundService.startService(context)

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .build()

        // 4-byte rotating random tag in manufacturer or service data
        val tagB64 = call.getString("data")
        val tagBytes = if (!tagB64.isNullOrEmpty()) {
            Base64.decode(tagB64, Base64.NO_WRAP)
        } else {
            val b = ByteArray(4)
            Random().nextBytes(b)
            b
        }

        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addServiceUuid(ParcelUuid(SERVICE_UUID))
            .addServiceData(ParcelUuid(SERVICE_UUID), tagBytes)
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

        // Stop foreground service
        MistMeshForegroundService.stopService(context)
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

    /**
     * Requirement 7: Expose native AlarmManager exact alarm for Safe-walk timer
     */
    @PluginMethod
    fun scheduleExactAlarm(call: PluginCall) {
        val delaySeconds = call.getInt("delaySeconds") ?: 60
        val payload = call.getString("actionPayload") ?: "{}"

        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
        if (alarmManager == null) {
            call.reject("AlarmManager unavailable")
            return
        }

        val intent = Intent(context, MistAlarmReceiver::class.java).apply {
            putExtra("actionPayload", payload)
        }

        val pendingIntent = PendingIntent.getBroadcast(
            context,
            4001,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val triggerTime = SystemClock.elapsedRealtime() + (delaySeconds * 1000L)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerTime, pendingIntent)
        } else {
            alarmManager.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerTime, pendingIntent)
        }

        call.resolve()
    }

    @PluginMethod
    fun cancelExactAlarm(call: PluginCall) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
        val intent = Intent(context, MistAlarmReceiver::class.java)
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            4001,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        alarmManager?.cancel(pendingIntent)
        call.resolve()
    }
}
