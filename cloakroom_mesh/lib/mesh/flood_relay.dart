import 'dart:convert';

/// TTL + Message-ID Flooding — Mesh Relay Logic.
///
/// Each message gets a unique ID and a hop-count (TTL).
/// Every device that receives a new ID rebroadcasts it to its
/// peers and decrements TTL, dropping duplicates.
///
/// This one rule is the entire "mesh" behavior.
class FloodRelay {
  /// Default maximum hops a message can travel.
  static const int defaultTtl = 5;

  /// Set of seen message IDs to prevent duplicate processing.
  final Set<String> _seenMessageIds = {};

  /// Maximum number of seen IDs to track (prevents unbounded memory growth).
  static const int _maxSeenIds = 10000;

  /// Wraps a payload into a flood-relay envelope.
  ///
  /// Returns a JSON string ready for mesh broadcast.
  String createFloodEnvelope({
    required String messageId,
    required String payload,
    int ttl = defaultTtl,
    required String originPeerId,
    required String roomCode,
  }) {
    final envelope = {
      'type': 'flood_relay',
      'messageId': messageId,
      'ttl': ttl,
      'originPeerId': originPeerId,
      'roomCode': roomCode,
      'payload': payload,
      'createdAt': DateTime.now().toIso8601String(),
    };
    // Mark our own messages as seen immediately
    _markSeen(messageId);
    return jsonEncode(envelope);
  }

  /// Processes an incoming flood envelope.
  ///
  /// Returns a [FloodResult] indicating whether this message
  /// should be delivered to the local user and/or relayed onward.
  FloodResult processIncoming(String envelopeJson) {
    try {
      final envelope = jsonDecode(envelopeJson) as Map<String, dynamic>;

      if (envelope['type'] != 'flood_relay') {
        return FloodResult.passthrough(envelopeJson);
      }

      final messageId = envelope['messageId'] as String;
      final ttl = envelope['ttl'] as int;
      final payload = envelope['payload'] as String;
      final originPeerId = envelope['originPeerId'] as String;
      final roomCode = envelope['roomCode'] as String? ?? '';

      // Drop duplicate — already seen this message
      if (_seenMessageIds.contains(messageId)) {
        return FloodResult.duplicate();
      }

      // Mark as seen
      _markSeen(messageId);

      // Determine if we should relay further
      final shouldRelay = ttl > 1;
      String? relayEnvelope;
      if (shouldRelay) {
        final relayData = Map<String, dynamic>.from(envelope);
        relayData['ttl'] = ttl - 1;
        relayEnvelope = jsonEncode(relayData);
      }

      return FloodResult(
        isNew: true,
        isDuplicate: false,
        shouldRelay: shouldRelay,
        relayEnvelope: relayEnvelope,
        payload: payload,
        messageId: messageId,
        originPeerId: originPeerId,
        roomCode: roomCode,
        remainingTtl: ttl - 1,
      );
    } catch (e) {
      // Malformed envelope — treat as passthrough
      return FloodResult.passthrough(envelopeJson);
    }
  }

  void _markSeen(String messageId) {
    _seenMessageIds.add(messageId);

    // Evict oldest entries if set grows too large
    if (_seenMessageIds.length > _maxSeenIds) {
      final toRemove = _seenMessageIds.length - _maxSeenIds + 500;
      final iterator = _seenMessageIds.iterator;
      final removal = <String>[];
      for (var i = 0; i < toRemove && iterator.moveNext(); i++) {
        removal.add(iterator.current);
      }
      _seenMessageIds.removeAll(removal);
    }
  }

  /// Check if a message ID has already been seen.
  bool hasSeen(String messageId) => _seenMessageIds.contains(messageId);

  /// Clear all seen message state.
  void reset() => _seenMessageIds.clear();
}

/// Result of processing an incoming flood relay envelope.
class FloodResult {
  final bool isNew;
  final bool isDuplicate;
  final bool shouldRelay;
  final String? relayEnvelope;
  final String? payload;
  final String? messageId;
  final String? originPeerId;
  final String? roomCode;
  final int remainingTtl;

  FloodResult({
    required this.isNew,
    required this.isDuplicate,
    required this.shouldRelay,
    this.relayEnvelope,
    this.payload,
    this.messageId,
    this.originPeerId,
    this.roomCode,
    this.remainingTtl = 0,
  });

  /// A duplicate message — drop silently.
  factory FloodResult.duplicate() => FloodResult(
        isNew: false,
        isDuplicate: true,
        shouldRelay: false,
      );

  /// A non-flood-relay message — pass through without flood logic.
  factory FloodResult.passthrough(String raw) => FloodResult(
        isNew: true,
        isDuplicate: false,
        shouldRelay: false,
        payload: raw,
      );
}
