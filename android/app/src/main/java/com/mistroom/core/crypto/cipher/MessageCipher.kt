package com.mistroom.core.crypto.cipher

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.inject.Inject
import javax.inject.Singleton

/**
 * AES-256-GCM message encryption/decryption.
 *
 * All ciphertext is prefixed with a 12-byte random nonce:
 * ```
 * [nonce (12 bytes)][ciphertext + GCM tag (variable)]
 * ```
 *
 * This cipher is used for both messages and attachment chunks.
 */
@Singleton
class MessageCipher @Inject constructor() {

    companion object {
        private const val AES_GCM = "AES/GCM/NoPadding"
        private const val KEY_ALGORITHM = "AES"
        private const val NONCE_LENGTH = 12
        private const val TAG_LENGTH_BITS = 128
    }

    private val secureRandom = SecureRandom()

    /**
     * Encrypt plaintext with AES-256-GCM.
     *
     * @param plaintext The data to encrypt.
     * @param key 32-byte AES-256 encryption key.
     * @param associatedData Optional additional authenticated data (AAD).
     * @return `nonce || ciphertext` (nonce is prepended).
     */
    fun encrypt(
        plaintext: ByteArray,
        key: ByteArray,
        associatedData: ByteArray? = null,
    ): ByteArray {
        require(key.size == 32) { "AES-256 key must be 32 bytes, got ${key.size}" }

        val nonce = ByteArray(NONCE_LENGTH).also { secureRandom.nextBytes(it) }

        val cipher = Cipher.getInstance(AES_GCM)
        val keySpec = SecretKeySpec(key, KEY_ALGORITHM)
        val gcmSpec = GCMParameterSpec(TAG_LENGTH_BITS, nonce)
        cipher.init(Cipher.ENCRYPT_MODE, keySpec, gcmSpec)

        if (associatedData != null) {
            cipher.updateAAD(associatedData)
        }

        val ciphertext = cipher.doFinal(plaintext)

        // Prepend nonce to ciphertext
        return nonce + ciphertext
    }

    /**
     * Decrypt AES-256-GCM ciphertext.
     *
     * @param nonceAndCiphertext `nonce (12 bytes) || ciphertext`.
     * @param key 32-byte AES-256 encryption key.
     * @param associatedData Optional AAD (must match what was used during encryption).
     * @return Decrypted plaintext.
     * @throws javax.crypto.AEADBadTagException if the tag doesn't match (tampered data).
     */
    fun decrypt(
        nonceAndCiphertext: ByteArray,
        key: ByteArray,
        associatedData: ByteArray? = null,
    ): ByteArray {
        require(key.size == 32) { "AES-256 key must be 32 bytes, got ${key.size}" }
        require(nonceAndCiphertext.size > NONCE_LENGTH) {
            "Ciphertext too short (must include nonce)"
        }

        val nonce = nonceAndCiphertext.copyOfRange(0, NONCE_LENGTH)
        val ciphertext = nonceAndCiphertext.copyOfRange(NONCE_LENGTH, nonceAndCiphertext.size)

        val cipher = Cipher.getInstance(AES_GCM)
        val keySpec = SecretKeySpec(key, KEY_ALGORITHM)
        val gcmSpec = GCMParameterSpec(TAG_LENGTH_BITS, nonce)
        cipher.init(Cipher.DECRYPT_MODE, keySpec, gcmSpec)

        if (associatedData != null) {
            cipher.updateAAD(associatedData)
        }

        return cipher.doFinal(ciphertext)
    }
}
