package com.mistroom.di

import android.content.Context
import com.mistroom.core.db.MistRoomDatabase
import com.mistroom.core.db.OutboxDao
import com.mistroom.core.transport.api.MeshTransport
import com.mistroom.core.transport.api.TransportManager
import com.mistroom.core.transport.ble.BleTransport
import dagger.Binds
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt module: binds [BleTransport] as the [MeshTransport] implementation
 * and provides Room database + DAO singletons.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class TransportModule {

    /** Bind [BleTransport] as the primary [MeshTransport]. */
    @Binds
    @Singleton
    abstract fun bindMeshTransport(impl: BleTransport): MeshTransport

    companion object {

        @Provides
        @Singleton
        fun provideDatabase(@ApplicationContext context: Context): MistRoomDatabase =
            MistRoomDatabase.getInstance(context)

        @Provides
        @Singleton
        fun provideOutboxDao(db: MistRoomDatabase): OutboxDao = db.outboxDao()

        /**
         * Register [BleTransport] with [TransportManager] at startup.
         *
         * This provider is called once (Singleton scope), ensuring the transport
         * is registered exactly once even if [TransportManager] is injected in
         * multiple places.
         */
        @Provides
        @Singleton
        fun provideTransportManager(
            manager: TransportManager,
            bleTransport: BleTransport,
        ): TransportManager {
            manager.registerTransport(bleTransport)
            return manager
        }
    }
}
