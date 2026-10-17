/**
 * Cryptography Engine (AES-256-GCM + PBKDF2 with Fallback).
 */
import { state } from './state.js';

export const hasSubtleCrypto = !!(window.crypto && window.crypto.subtle);

export async function deriveEncryptionKey(passkey) {
  if (!hasSubtleCrypto) {
    return 'fallback_key_' + passkey;
  }
  try {
    const enc = new TextEncoder();
    const rawKey = await window.crypto.subtle.importKey(
      'raw',
      enc.encode(passkey),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return await window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: enc.encode('mistroom_fixed_mesh_salt'),
        iterations: 100000,
        hash: 'SHA-256'
      },
      rawKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  } catch (e) {
    console.warn('SubtleCrypto error, falling back:', e);
    return 'fallback_key_' + passkey;
  }
}

export async function encryptMessage(plaintext) {
  if (!hasSubtleCrypto || typeof state.cryptoKey === 'string') {
    try {
      const b64 = btoa(unescape(encodeURIComponent(plaintext)));
      return { ciphertext: b64, iv: 'fallback' };
    } catch (e) {
      return { ciphertext: plaintext, iv: 'none' };
    }
  }
  if (!state.cryptoKey) return { ciphertext: plaintext, iv: '' };
  try {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const cipherBuffer = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      state.cryptoKey,
      encoded
    );
    return {
      ciphertext: btoa(String.fromCharCode(...new Uint8Array(cipherBuffer))),
      iv: btoa(String.fromCharCode(...iv))
    };
  } catch (err) {
    console.warn('Encryption fallback:', err);
    return { ciphertext: btoa(unescape(encodeURIComponent(plaintext))), iv: 'fallback' };
  }
}

export async function decryptMessage(ciphertext, ivBase64) {
  if (!ciphertext) return '';
  if (ivBase64 === 'fallback') {
    try {
      return decodeURIComponent(escape(atob(ciphertext)));
    } catch (e) {
      return ciphertext;
    }
  }
  if (!hasSubtleCrypto || typeof state.cryptoKey === 'string' || !ivBase64) {
    return ciphertext;
  }
  try {
    const iv = Uint8Array.from(atob(ivBase64), c => c.charCodeAt(0));
    const cipherBytes = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      state.cryptoKey,
      cipherBytes
    );
    return new TextDecoder().decode(decryptedBuffer);
  } catch (err) {
    return '[Decryption failed: Incorrect passkey]';
  }
}
