package com.mistroom.core.mesh

import java.util.UUID

/**
 * Mesh packet flags as defined in the MistRoom architecture.
 */
object PacketFlags {
    const val NONE: Byte = 0x00
    const val ENCRYPTED: Byte = 0x01
    const val REQUIRES_ACK: Byte = 0x02
    const val IS_ACK: Byte = 0x04
    const val IS_BROADCAST: Byte = 0x08
    const val IS_RELAY: Byte = 0x10        // Packet was forwarded by a relay
    const val HAS_ATTACHMENT: Byte = 0x20
    const val IS_EPHEMERAL: Byte = 0x40.toByte()
}

/**
 * Mesh protocol message types.
 */
enum class PacketType(val value: Byte) {
    MESSAGE(0x01),
    ACK(0x02),
    KEY_EXCHANGE(0x03),
    PRESENCE(0x04),
    PEER_DISCOVERY(0x05),
    HEARTBEAT(0x06),
    ATTACHMENT_META(0x07),
    ATTACHMENT_CHUNK(0x08);

    companion object {
        fun fromByte(value: Byte): PacketType =
            entries.first { it.value == value }
    }
}

/**
 * Binary mesh packet as defined in the MistRoom architecture.
 *
 * Wire format (big-endian):
 * ```
 * [version: 1B][flags: 1B][type: 1B][ttl: 1B]
 * [packet_id: 16B (UUID)]
 * [sender_fp: 16B (first 16 bytes of SHA-256)]
 * [recipient_fp: 16B (0x00 for broadcast)]
 * [hop_count: 1B]
 * [timestamp: 8B (millis since epoch)]
 * [payload_length: 4B]
 * [payload: variable]
 * ```
 *
 * Total header size: 64 bytes.
 */
data class MeshPacket(
    val version: Byte = PROTOCOL_VERSION,
    val flags: Byte = PacketFlags.NONE,
    val type: PacketType = PacketType.MESSAGE,
    val ttl: Byte = DEFAULT_TTL,
    val packetId: String = UUID.randomUUID().toString(),
    val senderFingerprint: String,            // 32-char hex
    val recipientFingerprint: String? = null,  // null = broadcast
    val hopCount: Byte = 0,
    val timestampMillis: Long = System.currentTimeMillis(),
    val payload: ByteArray = ByteArray(0),
) {
    companion object {
        const val PROTOCOL_VERSION: Byte = 1
        const val DEFAULT_TTL: Byte = 7
        const val HEADER_SIZE = 64
    }

    /** True if this packet has been forwarded (hop_count > 0). */
    val isForwarded: Boolean get() = hopCount > 0

    /** True if this is a broadcast (no specific recipient). */
    val isBroadcast: Boolean get() = recipientFingerprint == null ||
        flags.toInt() and PacketFlags.IS_BROADCAST.toInt() != 0

    /** True if the packet has exceeded its TTL. */
    val isExpired: Boolean get() = hopCount >= ttl

    /**
     * Create a forwarded copy with incremented hop count.
     */
    fun forwarded(): MeshPacket = copy(
        hopCount = (hopCount + 1).toByte(),
        flags = (flags.toInt() or PacketFlags.IS_RELAY.toInt()).toByte(),
    )

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is MeshPacket) return false
        return packetId == other.packetId
    }

    override fun hashCode(): Int = packetId.hashCode()

    override fun toString(): String =
        "MeshPacket(id=${packetId.take(8)}, type=$type, from=${senderFingerprint.take(8)}, " +
            "to=${recipientFingerprint?.take(8) ?: "BROADCAST"}, hops=$hopCount/$ttl, " +
            "payload=${payload.size}B)"
}
