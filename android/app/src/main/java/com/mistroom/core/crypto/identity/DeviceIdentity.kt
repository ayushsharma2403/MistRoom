package com.mistroom.core.crypto.identity

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator
import org.bouncycastle.crypto.params.Ed25519KeyGenerationParameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.MessageDigest
import java.security.SecureRandom
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Represents a MistRoom device identity backed by an Ed25519 key pair.
 *
 * The identity is the cryptographic root of trust for the device.
 * The fingerprint is derived as `SHA-256(ed25519_public_key)[0..16]` (32 hex chars).
 */
@Singleton
class DeviceIdentity @Inject constructor(
    private val keyStoreManager: KeyStoreManager,
) {
    private var _privateKey: Ed25519PrivateKeyParameters? = null
    private var _publicKey: Ed25519PublicKeyParameters? = null
    private var _fingerprint: String? = null

    val publicKey: ByteArray
        get() = _publicKey?.encoded
            ?: throw IllegalStateException("Identity not initialized. Call generateOrRestore() first.")

    val fingerprint: String
        get() = _fingerprint
            ?: throw IllegalStateException("Identity not initialized. Call generateOrRestore() first.")

    val isInitialized: Boolean
        get() = _privateKey != null

    /**
     * Generate a new Ed25519 key pair, or restore from Android Keystore if one exists.
     *
     * @return The device fingerprint (32-char hex).
     */
    fun generateOrRestore(): String {
        val stored = keyStoreManager.loadEd25519PrivateKey()
        if (stored != null) {
            _privateKey = Ed25519PrivateKeyParameters(stored, 0)
            _publicKey = _privateKey!!.generatePublicKey()
        } else {
            val generator = Ed25519KeyPairGenerator()
            generator.init(Ed25519KeyGenerationParameters(SecureRandom()))
            val keyPair = generator.generateKeyPair()

            _privateKey = keyPair.private as Ed25519PrivateKeyParameters
            _publicKey = keyPair.public as Ed25519PublicKeyParameters

            // Persist the private key in Android Keystore
            keyStoreManager.storeEd25519PrivateKey(_privateKey!!.encoded)
        }

        _fingerprint = deriveFingerprint(_publicKey!!.encoded)
        return _fingerprint!!
    }

    /**
     * Sign a message with the device's Ed25519 private key.
     *
     * @param message The raw bytes to sign.
     * @return 64-byte Ed25519 signature.
     */
    fun sign(message: ByteArray): ByteArray {
        val privateKey = _privateKey
            ?: throw IllegalStateException("Identity not initialized")

        val signer = Ed25519Signer()
        signer.init(true, privateKey)
        signer.update(message, 0, message.size)
        return signer.generateSignature()
    }

    /**
     * Verify an Ed25519 signature against a public key.
     *
     * @param publicKeyBytes 32-byte Ed25519 public key.
     * @param message The signed message bytes.
     * @param signature 64-byte Ed25519 signature.
     * @return `true` if the signature is valid.
     */
    fun verify(publicKeyBytes: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        val pubKey = Ed25519PublicKeyParameters(publicKeyBytes, 0)
        val verifier = Ed25519Signer()
        verifier.init(false, pubKey)
        verifier.update(message, 0, message.size)
        return verifier.verifySignature(signature)
    }

    /**
     * Build the `MistRoom fingerprint:timestamp:signature` auth header value
     * for authenticating requests to the relay server.
     */
    fun buildAuthHeader(method: String, path: String): String {
        val timestamp = System.currentTimeMillis()
        val message = "$fingerprint$timestamp${method.uppercase()}$path".toByteArray()
        val sig = sign(message)
        val sigB64 = android.util.Base64.encodeToString(sig, android.util.Base64.NO_WRAP)
        return "MistRoom $fingerprint:$timestamp:$sigB64"
    }

    companion object {
        /**
         * Derive a 32-character hex fingerprint from a raw 32-byte Ed25519 public key.
         */
        fun deriveFingerprint(publicKeyBytes: ByteArray): String {
            val digest = MessageDigest.getInstance("SHA-256")
            val hash = digest.digest(publicKeyBytes)
            return hash.take(16).joinToString("") { "%02x".format(it) }
        }
    }
}
