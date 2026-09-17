package com.mistroom.core.mesh

import com.google.common.truth.Truth.assertThat
import com.mistroom.core.db.OutboxDao
import com.mistroom.core.db.OutboxMessage
import com.mistroom.core.db.OutboxStatus
import com.mistroom.core.transport.api.TransportEvent
import com.mistroom.core.transport.api.TransportManager
import com.mistroom.core.transport.api.TransportPeer
import com.mistroom.core.transport.api.TransportType
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runTest
import org.junit.Before
import org.junit.Test

class OutboxRepositoryTest {

    private val LOCAL_FP   = "0000111122223333000011112222333"  // 31 chars intentionally (tests handle it)
    private val REMOTE_FP  = "aabbccdd11223344aabbccdd11223344"

    private lateinit var outboxDao: OutboxDao
    private lateinit var transportManager: TransportManager
    private lateinit var meshRouter: MeshRouter
    private lateinit var serializer: PacketSerializer
    private lateinit var repo: OutboxRepository

    private val transportEvents = MutableSharedFlow<TransportEvent>(extraBufferCapacity = 32)
    private val meshEvents = MutableSharedFlow<MeshEvent>(extraBufferCapacity = 32)

    @Before
    fun setup() {
        outboxDao = mockk(relaxed = true)
        transportManager = mockk {
            every { events } returns transportEvents
        }
        meshRouter = mockk {
            every { events } returns meshEvents
            every { localFingerprint } returns LOCAL_FP
        }
        serializer = PacketSerializer()
        repo = OutboxRepository(outboxDao, transportManager, meshRouter, serializer)
    }

    // ── Enqueue ─────────────────────────────────────────────────────────────

    @Test
    fun `enqueue inserts pending message into dao`() = runTest {
        val packet = buildPacket()
        repo.enqueue(packet)

        coVerify {
            outboxDao.insert(match { msg ->
                msg.id == packet.packetId &&
                msg.recipientFingerprint == REMOTE_FP &&
                msg.status == OutboxStatus.PENDING
            })
        }
    }

    @Test
    fun `enqueue broadcast packet (null recipient) is ignored`() = runTest {
        val packet = buildPacket(recipient = null)
        repo.enqueue(packet)

        coVerify(exactly = 0) { outboxDao.insert(any()) }
    }

    // ── Retry ───────────────────────────────────────────────────────────────

    @Test
    fun `retryFor attempts delivery and marks sent on success`() = runTest {
        val msg = buildOutboxMessage(attempts = 0)
        coEvery { outboxDao.getPendingFor(REMOTE_FP) } returns listOf(msg)
        coEvery { meshRouter.sendPacket(any()) } returns true

        repo.retryFor(REMOTE_FP)

        coVerify { outboxDao.incrementAttempts(msg.id) }
        coVerify { outboxDao.markSent(msg.id) }
    }

    @Test
    fun `retryFor marks failed after max attempts`() = runTest {
        val msg = buildOutboxMessage(attempts = OutboxMessage.MAX_ATTEMPTS - 1)
        coEvery { outboxDao.getPendingFor(REMOTE_FP) } returns listOf(msg)
        coEvery { meshRouter.sendPacket(any()) } returns false

        repo.retryFor(REMOTE_FP)

        coVerify { outboxDao.markFailed(msg.id) }
    }

    @Test
    fun `retryFor leaves message PENDING when delivery fails below max attempts`() = runTest {
        val msg = buildOutboxMessage(attempts = 1)
        coEvery { outboxDao.getPendingFor(REMOTE_FP) } returns listOf(msg)
        coEvery { meshRouter.sendPacket(any()) } returns false

        repo.retryFor(REMOTE_FP)

        coVerify(exactly = 0) { outboxDao.markFailed(any()) }
        coVerify(exactly = 0) { outboxDao.markSent(any()) }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private fun buildPacket(recipient: String? = REMOTE_FP) = MeshPacket(
        type = PacketType.MESSAGE,
        senderFingerprint = REMOTE_FP,
        recipientFingerprint = recipient,
        payload = "test".toByteArray(),
    )

    private fun buildOutboxMessage(attempts: Int = 0) = OutboxMessage(
        id = "msg-${System.nanoTime()}",
        recipientFingerprint = REMOTE_FP,
        encryptedPayload = "encrypted".toByteArray(),
        packetType = PacketType.MESSAGE.value.toInt(),
        ttl = MeshPacket.DEFAULT_TTL.toInt(),
        attempts = attempts,
    )
}
