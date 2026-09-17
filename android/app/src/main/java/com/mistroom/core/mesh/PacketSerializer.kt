package com.mistroom.core.mesh

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Serializes and deserializes [MeshPacket] to/from the binary wire format.
 *
 * This must match across all MistRoom clients (Android, iOS, desktop).
 */
@Singleton
class PacketSerializer @Inject constructor() {

    /**
     * Serialize a [MeshPacket] to its binary wire format.
     */
    fun serialize(packet: MeshPacket): ByteArray {
        val totalSize = MeshPacket.HEADER_SIZE + packet.payload.size
        val buffer = ByteBuffer.allocate(totalSize).order(ByteOrder.BIG_ENDIAN)

        // Header (64 bytes)
        buffer.put(packet.version)                              // 1B: version
        buffer.put(packet.flags)                                // 1B: flags
        buffer.put(packet.type.value)                           // 1B: type
        buffer.put(packet.ttl)                                  // 1B: ttl

        // 16B: packet_id (UUID as bytes)
        val uuid = UUID.fromString(packet.packetId)
        buffer.putLong(uuid.mostSignificantBits)
        buffer.putLong(uuid.leastSignificantBits)

        // 16B: sender fingerprint (first 16 bytes of hex → 16 chars → pad to 16 bytes)
        buffer.put(fingerprintToBytes(packet.senderFingerprint))

        // 16B: recipient fingerprint (0x00 for broadcast)
        if (packet.recipientFingerprint != null) {
            buffer.put(fingerprintToBytes(packet.recipientFingerprint))
        } else {
            buffer.put(ByteArray(16))  // All zeros = broadcast
        }

        buffer.put(packet.hopCount)                             // 1B: hop_count
        buffer.putLong(packet.timestampMillis)                  // 8B: timestamp
        buffer.putInt(packet.payload.size)                      // 4B: payload_length

        // Payload
        buffer.put(packet.payload)

        return buffer.array()
    }

    /**
     * Deserialize a [MeshPacket] from binary wire format.
     *
     * @throws IllegalArgumentException if the data is too short or malformed.
     */
    fun deserialize(data: ByteArray): MeshPacket {
        require(data.size >= MeshPacket.HEADER_SIZE) {
            "Packet too short: ${data.size} bytes (minimum ${MeshPacket.HEADER_SIZE})"
        }

        val buffer = ByteBuffer.wrap(data).order(ByteOrder.BIG_ENDIAN)

        val version = buffer.get()
        val flags = buffer.get()
        val typeByte = buffer.get()
        val ttl = buffer.get()

        // UUID
        val uuidHigh = buffer.getLong()
        val uuidLow = buffer.getLong()
        val packetId = UUID(uuidHigh, uuidLow).toString()

        // Sender fingerprint
        val senderBytes = ByteArray(16)
        buffer.get(senderBytes)
        val senderFingerprint = bytesToFingerprint(senderBytes)

        // Recipient fingerprint
        val recipientBytes = ByteArray(16)
        buffer.get(recipientBytes)
        val recipientFingerprint = if (recipientBytes.all { it == 0.toByte() }) {
            null
        } else {
            bytesToFingerprint(recipientBytes)
        }

        val hopCount = buffer.get()
        val timestampMillis = buffer.getLong()
        val payloadLength = buffer.getInt()

        require(data.size >= MeshPacket.HEADER_SIZE + payloadLength) {
            "Packet truncated: expected ${MeshPacket.HEADER_SIZE + payloadLength} bytes, got ${data.size}"
        }

        val payload = ByteArray(payloadLength)
        buffer.get(payload)

        return MeshPacket(
            version = version,
            flags = flags,
            type = PacketType.fromByte(typeByte),
            ttl = ttl,
            packetId = packetId,
            senderFingerprint = senderFingerprint,
            recipientFingerprint = recipientFingerprint,
            hopCount = hopCount,
            timestampMillis = timestampMillis,
            payload = payload,
        )
    }

    /**
     * Convert a 32-char hex fingerprint to 16 bytes.
     * Each pair of hex characters becomes one byte.
     */
    private fun fingerprintToBytes(fingerprint: String): ByteArray {
        require(fingerprint.length == 32) {
            "Fingerprint must be 32 hex chars, got ${fingerprint.length}"
        }
        return ByteArray(16) { i ->
            fingerprint.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
    }

    /**
     * Convert 16 bytes back to a 32-char hex fingerprint.
     */
    private fun bytesToFingerprint(bytes: ByteArray): String {
        require(bytes.size == 16) { "Expected 16 bytes for fingerprint" }
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
