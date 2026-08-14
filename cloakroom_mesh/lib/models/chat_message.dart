import 'dart:convert';

/// Represents a chat message with encryption metadata.
class ChatMessage {
  final String id;
  final String roomCode;
  final String text;
  final String senderId;
  final String senderName;
  final String senderAvatar;
  final String senderColor;
  final DateTime timestamp;
  final bool isSystem;
  final bool isEncrypted;

  ChatMessage({
    required this.id,
    required this.roomCode,
    required this.text,
    required this.senderId,
    this.senderName = 'Anonymous',
    this.senderAvatar = '👻',
    this.senderColor = '#a855f7',
    DateTime? timestamp,
    this.isSystem = false,
    this.isEncrypted = true,
  }) : timestamp = timestamp ?? DateTime.now();

  Map<String, dynamic> toMap() => {
        'id': id,
        'roomCode': roomCode,
        'text': text,
        'senderId': senderId,
        'senderName': senderName,
        'senderAvatar': senderAvatar,
        'senderColor': senderColor,
        'timestamp': timestamp.toIso8601String(),
        'isSystem': isSystem,
        'isEncrypted': isEncrypted,
      };

  String toJson() => jsonEncode(toMap());

  factory ChatMessage.fromMap(Map<String, dynamic> map) => ChatMessage(
        id: map['id'] as String,
        roomCode: map['roomCode'] as String? ?? '',
        text: map['text'] as String,
        senderId: map['senderId'] as String,
        senderName: map['senderName'] as String? ?? 'Anonymous',
        senderAvatar: map['senderAvatar'] as String? ?? '👻',
        senderColor: map['senderColor'] as String? ?? '#a855f7',
        timestamp: DateTime.tryParse(map['timestamp'] as String? ?? ''),
        isSystem: map['isSystem'] as bool? ?? false,
        isEncrypted: map['isEncrypted'] as bool? ?? true,
      );

  factory ChatMessage.fromJson(String json) =>
      ChatMessage.fromMap(jsonDecode(json) as Map<String, dynamic>);

  /// Creates a system notification message.
  factory ChatMessage.system({
    required String roomCode,
    required String text,
  }) =>
      ChatMessage(
        id: 'sys_${DateTime.now().millisecondsSinceEpoch}',
        roomCode: roomCode,
        text: text,
        senderId: 'system',
        senderName: 'System',
        senderAvatar: '🔔',
        senderColor: '#64748b',
        isSystem: true,
        isEncrypted: false,
      );
}
