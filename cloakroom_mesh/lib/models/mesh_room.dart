/// Represents a mesh chat room with its code and encryption key material.
class MeshRoom {
  final String roomCode;
  final String name;
  final DateTime createdAt;

  MeshRoom({
    required this.roomCode,
    required this.name,
    DateTime? createdAt,
  }) : createdAt = createdAt ?? DateTime.now();

  Map<String, dynamic> toMap() => {
        'roomCode': roomCode,
        'name': name,
        'createdAt': createdAt.toIso8601String(),
      };

  factory MeshRoom.fromMap(Map<String, dynamic> map) => MeshRoom(
        roomCode: map['roomCode'] as String,
        name: map['name'] as String,
        createdAt: DateTime.tryParse(map['createdAt'] as String? ?? ''),
      );

  /// Generate a random 6-character room code.
  static String generateCode() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    final rng = DateTime.now().microsecondsSinceEpoch;
    final buf = StringBuffer();
    for (var i = 0; i < 6; i++) {
      buf.write(chars[(rng * (i + 7) * 31) % chars.length]);
    }
    return buf.toString();
  }
}
