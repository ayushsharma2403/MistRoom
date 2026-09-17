package com.mistroom.core.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

/**
 * DAO for the offline message outbox.
 */
@Dao
interface OutboxDao {

    /** Insert a new pending message. Ignores duplicates (same packet ID). */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(message: OutboxMessage)

    /** Return all PENDING messages ordered by creation time. */
    @Query("SELECT * FROM outbox_messages WHERE status = 'PENDING' ORDER BY createdAt ASC")
    suspend fun getPending(): List<OutboxMessage>

    /** Observe pending messages — triggers retry logic reactively. */
    @Query("SELECT * FROM outbox_messages WHERE status = 'PENDING' ORDER BY createdAt ASC")
    fun observePending(): Flow<List<OutboxMessage>>

    /** Pending messages for a specific recipient. */
    @Query(
        "SELECT * FROM outbox_messages WHERE recipientFingerprint = :fp AND status = 'PENDING'"
    )
    suspend fun getPendingFor(fp: String): List<OutboxMessage>

    /** Mark a message as successfully delivered. */
    @Query("UPDATE outbox_messages SET status = 'SENT' WHERE id = :id")
    suspend fun markSent(id: String)

    /** Increment attempt count and update lastAttemptAt. */
    @Query(
        "UPDATE outbox_messages SET attempts = attempts + 1, lastAttemptAt = :now WHERE id = :id"
    )
    suspend fun incrementAttempts(id: String, now: Long = System.currentTimeMillis())

    /** Mark as FAILED once max attempts exceeded. */
    @Query("UPDATE outbox_messages SET status = 'FAILED' WHERE id = :id")
    suspend fun markFailed(id: String)

    /** Delete delivered and expired messages older than [cutoff]. */
    @Query(
        "DELETE FROM outbox_messages WHERE (status = 'SENT' OR createdAt < :cutoff)"
    )
    suspend fun purgeOld(cutoff: Long)

    /** Full update (used for status transitions). */
    @Update
    suspend fun update(message: OutboxMessage)
}
