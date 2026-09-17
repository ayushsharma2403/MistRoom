package com.mistroom.core.crypto.session

import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.generators.X25519KeyPairGenerator
import org.bouncycastle.crypto.params.X25519KeyGenerationParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Session key derivation data class.
 *
 * @property encryptionKey 32-byte AES-256-GCM encryption key.
 * @property macKey 32-byte HMAC-SHA256 key for message authentication.
 * @property peerFingerprint The fingerprint of the remote device in this session.
 * @property createdAtMillis Timestamp of session establishment.
 */
data class SessionKey(
    val encryptionKey: ByteArray,
    val macKey: ByteArray,
    val peerFingerprint: String,
    val createdAtMillis: Long = System.currentTimeMillis(),
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is SessionKey) return false
        return encryptionKey.contentEquals(other.encryptionKey) &&
            macKey.contentEquals(other.macKey) &&
            peerFingerprint == other.peerFingerprint
    }

    override fun hashCode(): Int {
        var result = encryptionKey.contentHashCode()
        result = 31 * result + macKey.contentHashCode()
        result = 31 * result + peerFingerprint.hashCode()
        return result
    }
}

/**
 * Manages X25519 ECDH key agreement and HKDF-based session key derivation.
 *
 * Implements the Double Ratchet-inspired session establishment from the
 * MistRoom architecture: X25519 ephemeral → ECDH shared secret → HKDF →
 * split into encryption key + MAC key.
 */
@Singleton
class SessionManager @Inject constructor() {

    /** Active session keys indexed by peer fingerprint. */
    private val sessions = mutableMapOf<String, SessionKey>()

    /** Our current ephemeral X25519 key pair. */
    private var _ephemeralPrivate: X25519PrivateKeyParameters? = null
    private var _ephemeralPublic: X25519PublicKeyParameters? = null

    /** 32-byte X25519 ephemeral public key to send to peers. */
    val ephemeralPublicKey: ByteArray
        get() = _ephemeralPublic?.encoded
            ?: generateEphemeralKeyPair().let { _ephemeralPublic!!.encoded }

    /**
     * Generate a fresh X25519 ephemeral key pair for a new session.
     */
    fun generateEphemeralKeyPair() {
        val generator = X25519KeyPairGenerator()
        generator.init(X25519KeyGenerationParameters(SecureRandom()))
        val keyPair = generator.generateKeyPair()
        _ephemeralPrivate = keyPair.private as X25519PrivateKeyParameters
        _ephemeralPublic = keyPair.public as X25519PublicKeyParameters
    }

    /**
     * Perform X25519 ECDH key agreement with a peer's ephemeral public key
     * and derive session keys via HKDF.
     *
     * @param peerFingerprint The fingerprint of the remote device.
     * @param peerPublicKeyBytes 32-byte X25519 public key of the peer.
     * @return The derived [SessionKey] for this session.
     */
    fun establishSession(peerFingerprint: String, peerPublicKeyBytes: ByteArray): SessionKey {
        val privateKey = _ephemeralPrivate
            ?: throw IllegalStateException("No ephemeral key. Call generateEphemeralKeyPair() first.")

        val peerPublicKey = X25519PublicKeyParameters(peerPublicKeyBytes, 0)

        // X25519 ECDH
        val agreement = X25519Agreement()
        agreement.init(privateKey)
        val sharedSecret = ByteArray(agreement.agreementSize)
        agreement.calculateAgreement(peerPublicKey, sharedSecret, 0)

        // HKDF-SHA256: extract + expand to 64 bytes
        val info = "MistRoom-Session-v1-$peerFingerprint".toByteArray()
        val derivedBytes = hkdfSha256(
            ikm = sharedSecret,
            salt = null,
            info = info,
            outputLength = 64,
        )

        val sessionKey = SessionKey(
            encryptionKey = derivedBytes.copyOfRange(0, 32),
            macKey = derivedBytes.copyOfRange(32, 64),
            peerFingerprint = peerFingerprint,
        )

        sessions[peerFingerprint] = sessionKey

        // Erase ephemeral private key after use (forward secrecy)
        _ephemeralPrivate = null

        return sessionKey
    }

    /**
     * Retrieve an active session key for a peer.
     */
    fun getSession(peerFingerprint: String): SessionKey? = sessions[peerFingerprint]

    /**
     * Remove and destroy a session key.
     */
    fun destroySession(peerFingerprint: String) {
        sessions.remove(peerFingerprint)?.let { key ->
            key.encryptionKey.fill(0)
            key.macKey.fill(0)
        }
    }

    /**
     * HKDF-SHA256: Extract-then-Expand as per RFC 5869.
     */
    private fun hkdfSha256(
        ikm: ByteArray,
        salt: ByteArray?,
        info: ByteArray,
        outputLength: Int,
    ): ByteArray {
        val hmacAlgo = "HmacSHA256"
        val hashLen = 32

        // Extract
        val extractKey = salt ?: ByteArray(hashLen)
        val prk = hmacSha256(extractKey, ikm)

        // Expand
        val n = (outputLength + hashLen - 1) / hashLen
        val okm = ByteArray(outputLength)
        var t = ByteArray(0)

        for (i in 1..n) {
            val input = t + info + byteArrayOf(i.toByte())
            t = hmacSha256(prk, input)
            val offset = (i - 1) * hashLen
            val len = minOf(hashLen, outputLength - offset)
            System.arraycopy(t, 0, okm, offset, len)
        }

        return okm
    }

    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }
}
