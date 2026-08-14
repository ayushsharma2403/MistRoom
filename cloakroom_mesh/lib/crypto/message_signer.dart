import 'dart:convert';
import 'dart:typed_data';
import 'package:cryptography/cryptography.dart';

/// HMAC-SHA256 message integrity verification.
///
/// Signs each message payload before transmission and verifies
/// integrity on receipt, preventing tampering during multi-hop relay.
class MessageSigner {
  final _hmac = Hmac.sha256();

  /// Sign a message payload using a shared secret key.
  /// Returns the HMAC tag as a base64-encoded string.
  Future<String> sign(String payload, SecretKey key) async {
    final payloadBytes = utf8.encode(payload);
    final mac = await _hmac.calculateMac(payloadBytes, secretKey: key);
    return base64Encode(mac.bytes);
  }

  /// Verify the HMAC integrity of a received message.
  Future<bool> verify(String payload, String hmacB64, SecretKey key) async {
    try {
      final payloadBytes = utf8.encode(payload);
      final expectedMac = await _hmac.calculateMac(payloadBytes, secretKey: key);
      final receivedMacBytes = base64Decode(hmacB64);

      if (expectedMac.bytes.length != receivedMacBytes.length) return false;

      // Constant-time comparison to prevent timing attacks
      var result = 0;
      for (var i = 0; i < expectedMac.bytes.length; i++) {
        result |= expectedMac.bytes[i] ^ receivedMacBytes[i];
      }
      return result == 0;
    } catch (e) {
      return false;
    }
  }

  /// Create a SecretKey from raw bytes (e.g., from shared secret).
  SecretKey keyFromBytes(Uint8List bytes) => SecretKey(bytes);
}
