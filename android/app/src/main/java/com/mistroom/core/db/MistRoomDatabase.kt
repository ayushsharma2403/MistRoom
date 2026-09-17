package com.mistroom.core.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters

// ── Type converters ──────────────────────────────────────────────────────────

class OutboxStatusConverter {
    @TypeConverter
    fun fromStatus(status: OutboxStatus): String = status.name

    @TypeConverter
    fun toStatus(value: String): OutboxStatus = OutboxStatus.valueOf(value)
}

// ── Database ─────────────────────────────────────────────────────────────────

/**
 * MistRoom local Room database.
 *
 * Currently contains the offline message outbox. Additional tables
 * (conversations, contacts, local messages) will be added in Phase 5+.
 */
@Database(
    entities = [OutboxMessage::class],
    version = 1,
    exportSchema = true,
)
@TypeConverters(OutboxStatusConverter::class)
abstract class MistRoomDatabase : RoomDatabase() {

    abstract fun outboxDao(): OutboxDao

    companion object {
        private const val DB_NAME = "mistroom.db"

        @Volatile
        private var INSTANCE: MistRoomDatabase? = null

        fun getInstance(context: Context): MistRoomDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: buildDatabase(context).also { INSTANCE = it }
            }
        }

        private fun buildDatabase(context: Context): MistRoomDatabase =
            Room.databaseBuilder(
                context.applicationContext,
                MistRoomDatabase::class.java,
                DB_NAME,
            )
                .fallbackToDestructiveMigration() // Dev-only; replace with proper migrations before release
                .build()
    }
}
