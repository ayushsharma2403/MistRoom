package com.mistroom.core.mesh

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class PacketSerializerTest {

    private val serializer = PacketSerializer()

    private fun samplePacket(
        type: PacketType = PacketType.MESSAGE,
        recipient: String? = "aabbccdd11223344aabbccdd11223344",
        payload: ByteArray = "hello mesh".toByteArray(),
        ttl: Byte = MeshPacket.DEFAULT_TTL,
        hopCount: Byte = 0,
    ) = MeshPacket(
        type = type,
        senderFingerprint = "deadbeef00112233deadbeef00112233",
        recipientFingerprint = recipient,
        ttl = ttl,
        hopCount = hopCount,
        payload = payload,
    )

    // ── Round-trip ──────────────────────────────────────────────────────────

    @Test
    fun `serialize then deserialize produces identical packet`() {
        val original = samplePacket()
        val bytes = serializer.serialize(original)
        val decoded = serializer.deserialize(bytes)

        assertThat(decoded.packetId).isEqualTo(original.packetId)
        assertThat(decoded.type).isEqualTo(original.type)
        assertThat(decoded.senderFingerprint).isEqualTo(original.senderFingerprint)
        assertThat(decoded.recipientFingerprint).isEqualTo(original.recipientFingerprint)
        assertThat(decoded.ttl).isEqualTo(original.ttl)
        assertThat(decoded.hopCount).isEqualTo(original.hopCount)
        assertThat(decoded.payload).isEqualTo(original.payload)
    }

    @Test
    fun `broadcast packet round-trip has null recipient`() {
        val packet = samplePacket(recipient = null, payload = ByteArray(0))
        val decoded = serializer.deserialize(serializer.serialize(packet))
        assertThat(decoded.recipientFingerprint).isNull()
        assertThat(decoded.isBroadcast).isTrue()
    }

    @Test
    fun `empty payload round-trip`() {
        val packet = samplePacket(payload = ByteArray(0))
        val decoded = serializer.deserialize(serializer.serialize(packet))
        assertThat(decoded.payload).isEmpty()
    }

    @Test
    fun `large payload round-trip`() {
        val big = ByteArray(1024) { it.toByte() }
        val packet = samplePacket(payload = big)
        val decoded = serializer.deserialize(serializer.serialize(packet))
        assertThat(decoded.payload).isEqualTo(big)
    }

    @Test
    fun `all packet types round-trip correctly`() {
        for (type in PacketType.entries) {
            val packet = samplePacket(type = type)
            val decoded = serializer.deserialize(serializer.serialize(packet))
            assertThat(decoded.type).isEqualTo(type)
        }
    }

    @Test
    fun `forwarded packet preserves hop count`() {
        val packet = samplePacket(hopCount = 3)
        val decoded = serializer.deserialize(serializer.serialize(packet))
        assertThat(decoded.hopCount).isEqualTo(3)
    }

    // ── Header size ─────────────────────────────────────────────────────────

    @Test
    fun `serialized packet with no payload has exactly HEADER_SIZE bytes`() {
        val packet = samplePacket(payload = ByteArray(0))
        assertThat(serializer.serialize(packet).size).isEqualTo(MeshPacket.HEADER_SIZE)
    }

    @Test
    fun `serialized packet size equals header plus payload`() {
        val payload = ByteArray(42)
        val packet = samplePacket(payload = payload)
        assertThat(serializer.serialize(packet).size).isEqualTo(MeshPacket.HEADER_SIZE + 42)
    }

    // ── Error cases ─────────────────────────────────────────────────────────

    @Test(expected = IllegalArgumentException::class)
    fun `deserialize too-short data throws`() {
        serializer.deserialize(ByteArray(10))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `deserialize truncated payload throws`() {
        val packet = samplePacket(payload = ByteArray(100))
        val bytes = serializer.serialize(packet)
        // Drop the last 50 bytes to simulate truncation
        serializer.deserialize(bytes.copyOf(bytes.size - 50))
    }
}
