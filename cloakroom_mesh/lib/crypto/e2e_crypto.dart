import 'dart:convert';
import 'dart:typed_data';
import 'package:cryptography/cryptography.dart';

/// End-to-End Encryption using X25519 key exchange + AES-256-GCM.
///
/// Each device generates an X25519 keypair on first launch.
/// When two peers connect, they exchange public keys and derive
/// a shared secret via Diffie-Hellman. All messages are then
/// encrypted with AES-256-GCM using the shared secret.
class E2ECrypto {
  final _keyExchange = X25519();
  final _cipher = AesGcm.with256bits();

  SimpleKeyPair? _myKeyPair;
  SimplePublicKey? _myPublicKey;

  // peerId -> derived shared SecretKey
  final Map<String, SecretKey> _peerSecrets = {};

  /// Initialize: generate or load the device's X25519 keypair.
  Future<void> init() async {
    final kp = await _keyExchange.newKeyPair();
    _myKeyPair = kp;
    _myPublicKey = await kp.extractPublicKey();
  }

  /// Get our public key bytes to share with peers.
  Future<Uint8List> getPublicKeyBytes() async {
    if (_myPublicKey == null) await init();
    return Uint8List.fromList(_myPublicKey!.bytes);
  }

  /// Perform X25519 key exchange with a remote peer's public key.
  /// Returns true if the shared secret was derived successfully.
  Future<bool> deriveSharedSecret(
      String peerId, Uint8List remotePublicKeyBytes) async {
    if (_myKeyPair == null) await init();

    try {
      final remotePublicKey =
          SimplePublicKey(remotePublicKeyBytes, type: KeyPairType.x25519);

      final sharedSecretKey = await _keyExchange.sharedSecretKey(
        keyPair: _myKeyPair!,
        remotePublicKey: remotePublicKey,
      );

      // Derive a 256-bit AES key from the shared secret
      final sharedBytes = await sharedSecretKey.extractBytes();
      _peerSecrets[peerId] = SecretKey(sharedBytes);

      return true;
    } catch (e) {
      return false;
    }
  }

  /// Encrypt a plaintext message for a specific peer.
  /// Returns a map with 'ciphertext', 'iv', and 'tag' fields (base64-encoded).
  Future<Map<String, String>?> encrypt(
      String peerId, String plaintext, String roomCode) async {
    final secretKey = _peerSecrets[peerId];
    if (secretKey == null) return null;

    try {
      final plaintextBytes = utf8.encode(plaintext);

      // Encrypt with AES-256-GCM
      // AAD (Associated Authenticated Data) = room code for binding
      final secretBox = await _cipher.encrypt(
        plaintextBytes,
        secretKey: secretKey,
        aad: utf8.encode(roomCode),
      );

      return {
        'ciphertext': base64Encode(secretBox.cipherText),
        'iv': base64Encode(secretBox.nonce),
        'tag': base64Encode(secretBox.mac.bytes),
      };
    } catch (e) {
      return null;
    }
  }

  /// Decrypt a ciphertext received from a specific peer.
  Future<String?> decrypt(
    String peerId,
    String ciphertextB64,
    String ivB64,
    String tagB64,
    String roomCode,
  ) async {
    final secretKey = _peerSecrets[peerId];
    if (secretKey == null) return null;

    try {
      final ciphertext = base64Decode(ciphertextB64);
      final iv = base64Decode(ivB64);
      final tag = base64Decode(tagB64);

      final secretBox = SecretBox(
        ciphertext,
        nonce: iv,
        mac: Mac(tag),
      );

      final plainBytes = await _cipher.decrypt(
        secretBox,
        secretKey: secretKey,
        aad: utf8.encode(roomCode),
      );

      return utf8.decode(plainBytes);
    } catch (e) {
      return null;
    }
  }

  /// Encrypt a message for broadcast to all connected peers.
  /// Returns a map of peerId -> encrypted payload.
  Future<Map<String, Map<String, String>>> encryptForAll(
      String plaintext, String roomCode) async {
    final results = <String, Map<String, String>>{};
    for (final peerId in _peerSecrets.keys) {
      final encrypted = await encrypt(peerId, plaintext, roomCode);
      if (encrypted != null) {
        results[peerId] = encrypted;
      }
    }
    return results;
  }

  /// Check if we have an established shared secret with a peer.
  bool hasSharedSecret(String peerId) => _peerSecrets.containsKey(peerId);

  /// Remove a peer's shared secret (on disconnect).
  void removePeer(String peerId) => _peerSecrets.remove(peerId);

  /// Clear all state.
  void dispose() {
    _peerSecrets.clear();
    _myKeyPair = null;
    _myPublicKey = null;
  }
}
