package com.mistroom.feature.main

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bluetooth
import androidx.compose.material.icons.filled.BluetoothDisabled
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mistroom.core.transport.api.TransportEvent
import com.mistroom.core.transport.api.TransportManager
import com.mistroom.core.transport.api.TransportType

/**
 * A slim status bar showing BLE mesh state and connected peer count.
 *
 * Place at the top or bottom of the main screen. Observes
 * [TransportManager.events] to update reactively.
 *
 * ```kotlin
 * TransportStatusBar(transportManager = hiltViewModel<MainViewModel>().transportManager)
 * ```
 */
@Composable
fun TransportStatusBar(
    transportManager: TransportManager,
    modifier: Modifier = Modifier,
) {
    var isActive by remember { mutableStateOf(false) }
    var peerCount by remember { mutableIntStateOf(0) }

    // Collect transport events
    LaunchedEffect(transportManager) {
        transportManager.events.collect { event ->
            when (event) {
                is TransportEvent.StateChanged -> {
                    if (event.type == TransportType.BLE) {
                        isActive = event.isActive
                    }
                }
                is TransportEvent.PeerDiscovered -> {
                    peerCount = transportManager.getAllConnectedPeers().size
                }
                is TransportEvent.PeerLost -> {
                    peerCount = transportManager.getAllConnectedPeers().size
                }
                else -> Unit
            }
        }
    }

    val bgColor = if (isActive) Color(0xFF1A3A2A) else Color(0xFF2A1A1A)
    val iconColor = if (isActive) Color(0xFF4CAF8A) else Color(0xFFCF6679)

    // Pulse animation when active
    val infiniteTransition = rememberInfiniteTransition(label = "ble_pulse")
    val pulseAlpha by infiniteTransition.animateFloat(
        initialValue = 1f,
        targetValue = if (isActive) 0.4f else 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(1000),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "pulse_alpha",
    )

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(bgColor)
            .padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Start,
    ) {
        Icon(
            imageVector = if (isActive) Icons.Default.Bluetooth else Icons.Default.BluetoothDisabled,
            contentDescription = if (isActive) "BLE active" else "BLE off",
            tint = iconColor,
            modifier = Modifier
                .size(16.dp)
                .alpha(if (isActive) pulseAlpha else 1f),
        )

        Spacer(Modifier.width(8.dp))

        Text(
            text = when {
                !isActive -> "Mesh offline"
                peerCount == 0 -> "Scanning…"
                peerCount == 1 -> "1 peer nearby"
                else -> "$peerCount peers nearby"
            },
            color = Color.White.copy(alpha = 0.85f),
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}
