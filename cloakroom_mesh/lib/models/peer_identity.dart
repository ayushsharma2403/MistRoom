import 'dart:math';

/// Generates a stable anonymous identity from a peer ID string.
class PeerIdentity {
  final String peerId;
  final String alias;
  final String avatar;
  final String color;
  final DateTime joinedAt;

  PeerIdentity({
    required this.peerId,
    required this.alias,
    required this.avatar,
    required this.color,
    DateTime? joinedAt,
  }) : joinedAt = joinedAt ?? DateTime.now();

  Map<String, dynamic> toMap() => {
        'peerId': peerId,
        'alias': alias,
        'avatar': avatar,
        'color': color,
        'joinedAt': joinedAt.toIso8601String(),
      };

  factory PeerIdentity.fromMap(Map<String, dynamic> map) => PeerIdentity(
        peerId: map['peerId'] as String,
        alias: map['alias'] as String,
        avatar: map['avatar'] as String,
        color: map['color'] as String,
        joinedAt: DateTime.tryParse(map['joinedAt'] as String? ?? ''),
      );

  static const _adjectives = [
    'Cyber', 'Neon', 'Shadow', 'Quantum', 'Digital',
    'Vapor', 'Aura', 'Binary', 'Crypto', 'Phantom',
    'Silent', 'Cosmic', 'Rogue', 'Drift', 'Prism',
  ];

  static const _nouns = [
    'Falcon', 'Nomad', 'Fox', 'Spectre', 'Ghost',
    'Sentinel', 'Cipher', 'Viper', 'Oracle', 'Spark',
    'Monk', 'Wraith', 'Wolf', 'Hawk', 'Storm',
  ];

  static const _avatars = [
    '⚡', '🔮', '🎭', '👾', '🐉', '🦊', '🛸',
    '🛡️', '🌌', '💎', '🐺', '🦅', '🔥', '🌀', '🧊',
  ];

  static const _colors = [
    '#8b5cf6', '#ec4899', '#3b82f6', '#10b981',
    '#f59e0b', '#06b6d4', '#a855f7', '#ef4444',
    '#14b8a6', '#f97316', '#6366f1', '#84cc16',
  ];

  /// Generates a deterministic anonymous identity from a peer ID.
  static PeerIdentity generate(String peerId) {
    final rand = Random(peerId.hashCode);
    final adj = _adjectives[rand.nextInt(_adjectives.length)];
    final noun = _nouns[rand.nextInt(_nouns.length)];
    final avatar = _avatars[rand.nextInt(_avatars.length)];
    final color = _colors[rand.nextInt(_colors.length)];

    return PeerIdentity(
      peerId: peerId,
      alias: '$adj $noun',
      avatar: avatar,
      color: color,
    );
  }
}
