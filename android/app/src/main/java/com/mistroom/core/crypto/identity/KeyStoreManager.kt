package com.mistroom.core.crypto.identity

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Manages cryptographic key storage in the Android Keystore.
 *
 * Ed25519 keys are wrapped (encrypted) using an AES-256-GCM key stored in
 * the Android Keystore. The wrapped key bytes are persisted in encrypted
 * SharedPreferences, while the AES wrapping key never leaves the hardware.
 */
@Singleton
class KeyStoreManager @Inject constructor(
    private val context: android.content.Context,
) {
    companion object {
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val WRAPPING_KEY_ALIAS = "mistroom_key_wrapper"
        private const val PREFS_NAME = "mistroom_keys"
        private const val PREF_ED25519_WRAPPED = "ed25519_private_wrapped"
        private const val PREF_ED25519_IV = "ed25519_private_iv"
        private const val GCM_TAG_LENGTH = 128
    }

    private val keyStore: KeyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply {
        load(null)
    }

    /**
     * Store an Ed25519 private key by wrapping it with AES-256-GCM from the Keystore.
     */
    fun storeEd25519PrivateKey(rawPrivateKey: ByteArray) {
        val wrappingKey = getOrCreateWrappingKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey)

        val encryptedBytes = cipher.doFinal(rawPrivateKey)
        val iv = cipher.iv

        val prefs = context.getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
        prefs.edit()
            .putString(PREF_ED25519_WRAPPED, android.util.Base64.encodeToString(encryptedBytes, android.util.Base64.NO_WRAP))
            .putString(PREF_ED25519_IV, android.util.Base64.encodeToString(iv, android.util.Base64.NO_WRAP))
            .apply()
    }

    /**
     * Load the Ed25519 private key by unwrapping it with AES-256-GCM from the Keystore.
     *
     * @return Raw 32-byte private key, or null if no key is stored.
     */
    fun loadEd25519PrivateKey(): ByteArray? {
        val prefs = context.getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
        val wrappedB64 = prefs.getString(PREF_ED25519_WRAPPED, null) ?: return null
        val ivB64 = prefs.getString(PREF_ED25519_IV, null) ?: return null

        val wrappedBytes = android.util.Base64.decode(wrappedB64, android.util.Base64.NO_WRAP)
        val iv = android.util.Base64.decode(ivB64, android.util.Base64.NO_WRAP)

        val wrappingKey = getOrCreateWrappingKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey, GCMParameterSpec(GCM_TAG_LENGTH, iv))

        return cipher.doFinal(wrappedBytes)
    }

    /**
     * Delete all stored keys (for identity reset/wipe).
     */
    fun deleteAllKeys() {
        if (keyStore.containsAlias(WRAPPING_KEY_ALIAS)) {
            keyStore.deleteEntry(WRAPPING_KEY_ALIAS)
        }
        val prefs = context.getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
        prefs.edit().clear().apply()
    }

    /**
     * Check if a stored identity exists.
     */
    fun hasStoredIdentity(): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
        return prefs.contains(PREF_ED25519_WRAPPED)
    }

    /**
     * Get the AES-256-GCM wrapping key from Android Keystore, creating one if needed.
     */
    private fun getOrCreateWrappingKey(): SecretKey {
        return if (keyStore.containsAlias(WRAPPING_KEY_ALIAS)) {
            (keyStore.getEntry(WRAPPING_KEY_ALIAS, null) as KeyStore.SecretKeyEntry).secretKey
        } else {
            val keyGen = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                KEYSTORE_PROVIDER,
            )
            keyGen.init(
                KeyGenParameterSpec.Builder(
                    WRAPPING_KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setUserAuthenticationRequired(false) // App-level auth, not hardware
                    .build(),
            )
            keyGen.generateKey()
        }
    }
}
