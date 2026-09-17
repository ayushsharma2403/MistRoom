package com.mistroom

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

/**
 * Application entry point.
 *
 * The [HiltAndroidApp] annotation triggers Hilt's code generation and
 * creates the application-level dependency container. All @Singleton
 * bindings (TransportManager, MeshRouter, BleTransport, OutboxRepository, …)
 * are initialized lazily when first requested.
 */
@HiltAndroidApp
class MistRoomApp : Application()
