package com.mistroom.core.transport.ble

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.mistroom.core.mesh.MeshRouter
import com.mistroom.core.transport.api.TransportManager
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Android foreground service that keeps the BLE mesh transport alive.
 *
 * Declared in AndroidManifest.xml with:
 * ```xml
 * android:foregroundServiceType="connectedDevice"
 * ```
 *
 * Starts automatically when the app comes to the foreground and remains
 * alive while the user has MistRoom open or has opted in to background mesh.
 *
 * Exposed via [LocalBinder] so the UI can observe [TransportManager.events].
 */
@AndroidEntryPoint
class BleGattService : Service() {

    companion object {
        private const val CHANNEL_ID = "mistroom_mesh"
        private const val NOTIFICATION_ID = 1001

        /** Start the mesh foreground service. */
        fun start(context: Context) {
            val intent = Intent(context, BleGattService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** Stop the mesh foreground service. */
        fun stop(context: Context) {
            context.stopService(Intent(context, BleGattService::class.java))
        }
    }

    @Inject
    lateinit var transportManager: TransportManager

    @Inject
    lateinit var meshRouter: MeshRouter

    @Inject
    lateinit var bleTransport: BleTransport

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // ── Binder (optional local binding for UI) ──────────────────────────────

    inner class LocalBinder : Binder() {
        fun getTransportManager(): TransportManager = transportManager
        fun getMeshRouter(): MeshRouter = meshRouter
    }

    private val binder = LocalBinder()

    override fun onBind(intent: Intent?): IBinder = binder

    // ── Service lifecycle ───────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        serviceScope.launch {
            // Register transport (idempotent — TransportModule already registers it,
            // but this ensures it's registered even without DI in edge cases)
            if (!transportManager.isTransportActive(com.mistroom.core.transport.api.TransportType.BLE)) {
                transportManager.startTransport(com.mistroom.core.transport.api.TransportType.BLE)
            }
        }
        return START_STICKY // Restart if killed by system
    }

    override fun onDestroy() {
        serviceScope.launch {
            transportManager.stopAll()
        }
        serviceScope.cancel()
        super.onDestroy()
    }

    // ── Notification ────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "MistRoom Mesh",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Keeps the MistRoom mesh transport active"
                setShowBadge(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        // Tapping the notification opens the app (MainActivity)
        val openAppIntent = packageManager
            .getLaunchIntentForPackage(packageName)
            ?.let { intent ->
                PendingIntent.getActivity(
                    this, 0, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("MistRoom")
            .setContentText("Mesh active — searching for nearby peers")
            .setSmallIcon(android.R.drawable.ic_menu_share) // Replace with real icon
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openAppIntent)
            .build()
    }
}
