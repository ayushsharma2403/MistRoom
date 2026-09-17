package com.mistroom.core.mesh

import com.google.common.truth.Truth.assertThat
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import com.mistroom.core.transport.api.TransportEvent
import com.mistroom.core.transport.api.TransportManager
import com.mistroom.core.transport.api.TransportPeer
import com.mistroom.core.transport.api.TransportType
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runTest
import org.junit.Before
import org.junit.Test

class MeshRouterTest {

    private val LOCAL_FP  = "aaaa0000bbbb1111aaaa0000bbbb1111"
    private val REMOTE_FP = "cccc2222dddd3333cccc2222dddd3333"

    private lateinit var transportManager: TransportManager
    private lateinit var dedupCache: DedupCache
    private lateinit var forwardingQueue: ForwardingQueue
    private lateinit var serializer: PacketSerializer
    private lateinit var router: MeshRouter

    private val transportEvents = MutableSharedFlow<TransportEvent>(extraBufferCapacity = 64)

    @Before
    fun setup() {
        transportManager = mockk(relaxed = true) {
            every { events } returns transportEvents
            every { getAllConnectedPeers() } returns emptyList()
        }
        dedupCache = DedupCache()
        forwardingQueue = ForwardingQueue()
        serializer = PacketSerializer()
        router = MeshRouter(transportManager, dedupCache, forwardingQueue, serializer)
        router.initialize(LOCAL_FP)
    }

    // ── Deduplication ───────────────────────────────────────────────────────

    @Test
    fun `duplicate packet is silently dropped`() = runTest {
        val packet = buildPacket(recipientFp = LOCAL_FP)
        dedupCache.markSeen(packet.packetId)

        val received = mutableListOf<MeshEvent>()
        val job = kotlinx.coroutines.launch { router.events.collect { received.add(it) } }

        transportEvents.emit(
            TransportEvent.PacketReceived(packet, fakePeer())
        )

        kotlinx.coroutines.delay(50)
        assertThat(received).isEmpty()
        job.cancel()
    }

    // ── TTL enforcement ─────────────────────────────────────────────────────

    @Test
    fun `expired packet (hopCount >= ttl) is dropped`() = runTest {
        val packet = buildPacket(ttl = 3, hopCount = 3, recipientFp = LOCAL_FP)

        val received = mutableListOf<MeshEvent>()
        val job = kotlinx.coroutines.launch { router.events.collect { received.add(it) } }

        transportEvents.emit(TransportEvent.PacketReceived(packet, fakePeer()))
        kotlinx.coroutines.delay(50)

        assertThat(received).isEmpty()
        job.cancel()
    }

    // ── Local delivery ──────────────────────────────────────────────────────

    @Test
    fun `packet addressed to local device emits MessageReceived`() = runTest {
        val payload = "hello".toByteArray()
        val packet = buildPacket(
            type = PacketType.MESSAGE,
            recipientFp = LOCAL_FP,
            payload = payload,
        )

        val events = mutableListOf<MeshEvent>()
        val job = kotlinx.coroutines.launch { router.events.collect { events.add(it) } }

        transportEvents.emit(TransportEvent.PacketReceived(packet, fakePeer()))
        kotlinx.coroutines.delay(100)

        assertThat(events).hasSize(1)
        assertThat(events[0]).isInstanceOf(MeshEvent.MessageReceived::class.java)
        assertThat((events[0] as MeshEvent.MessageReceived).packet.payload).isEqualTo(payload)
        job.cancel()
    }

    @Test
    fun `broadcast packet emits MessageReceived`() = runTest {
        val packet = buildPacket(type = PacketType.MESSAGE, recipientFp = null)

        val events = mutableListOf<MeshEvent>()
        val job = kotlinx.coroutines.launch { router.events.collect { events.add(it) } }

        transportEvents.emit(TransportEvent.PacketReceived(packet, fakePeer()))
        kotlinx.coroutines.delay(100)

        assertThat(events.filterIsInstance<MeshEvent.MessageReceived>()).hasSize(1)
        job.cancel()
    }

    @Test
    fun `ACK packet emits AckReceived with original packet ID`() = runTest {
        val originalId = "original-123"
        val ackPacket = buildPacket(
            type = PacketType.ACK,
            recipientFp = LOCAL_FP,
            payload = originalId.toByteArray(),
        )

        val events = mutableListOf<MeshEvent>()
        val job = kotlinx.coroutines.launch { router.events.collect { events.add(it) } }

        transportEvents.emit(TransportEvent.PacketReceived(ackPacket, fakePeer()))
        kotlinx.coroutines.delay(100)

        val ackEvents = events.filterIsInstance<MeshEvent.AckReceived>()
        assertThat(ackEvents).hasSize(1)
        assertThat(ackEvents[0].originalPacketId).isEqualTo(originalId)
        job.cancel()
    }

    // ── Forwarding ──────────────────────────────────────────────────────────

    @Test
    fun `packet not addressed to us emits PacketForwarded`() = runTest {
        val packet = buildPacket(
            type = PacketType.MESSAGE,
            recipientFp = REMOTE_FP,  // addressed to someone else
        )

        val events = mutableListOf<MeshEvent>()
        val job = kotlinx.coroutines.launch { router.events.collect { events.add(it) } }

        transportEvents.emit(TransportEvent.PacketReceived(packet, fakePeer()))
        kotlinx.coroutines.delay(100)

        assertThat(events.filterIsInstance<MeshEvent.PacketForwarded>()).hasSize(1)
        job.cancel()
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private fun buildPacket(
        type: PacketType = PacketType.MESSAGE,
        recipientFp: String? = LOCAL_FP,
        payload: ByteArray = ByteArray(0),
        ttl: Byte = MeshPacket.DEFAULT_TTL,
        hopCount: Byte = 0,
    ) = MeshPacket(
        type = type,
        senderFingerprint = REMOTE_FP,
        recipientFingerprint = recipientFp,
        ttl = ttl,
        hopCount = hopCount,
        payload = payload,
    )

    private fun fakePeer() = TransportPeer(
        fingerprint = REMOTE_FP,
        transportType = TransportType.BLE,
        address = "AA:BB:CC:DD:EE:FF",
    )
}
