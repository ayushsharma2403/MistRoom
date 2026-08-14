import 'package:flutter/material.dart';
import '../models/peer_identity.dart';
import '../theme/app_theme.dart';

/// Slide-out drawer showing connected P2P mesh peers.
class PeerDrawer extends StatelessWidget {
  final List<PeerIdentity> peers;
  final String? myPeerId;

  const PeerDrawer({
    super.key,
    required this.peers,
    this.myPeerId,
  });

  Color _parseColor(String hex) {
    try {
      return Color(int.parse(hex.replaceFirst('#', '0xFF')));
    } catch (_) {
      return AppTheme.primary;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 260,
      decoration: AppTheme.glassDecoration(),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'Mesh Nodes',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: AppTheme.textMain,
                ),
              ),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: AppTheme.accentCyan.withAlpha(30),
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(
                      color: AppTheme.accentCyan.withAlpha(80)),
                ),
                child: Text(
                  '${peers.length}',
                  style: const TextStyle(
                    color: AppTheme.accentCyan,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),

          // Peer List
          Expanded(
            child: ListView.separated(
              itemCount: peers.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (context, index) {
                final peer = peers[index];
                final isMe = peer.peerId == myPeerId;

                return Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    color: isMe
                        ? AppTheme.primary.withAlpha(38)
                        : AppTheme.borderGlass,
                    borderRadius: BorderRadius.circular(8),
                    border: isMe
                        ? Border.all(color: AppTheme.borderGlow)
                        : null,
                  ),
                  child: Row(
                    children: [
                      Text(peer.avatar,
                          style: const TextStyle(fontSize: 20)),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '${peer.alias}${isMe ? " (You)" : ""}',
                              style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                                color: _parseColor(peer.color),
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                            Text(
                              isMe ? 'Local Node' : 'BLE / WiFi Direct',
                              style: const TextStyle(
                                fontSize: 10,
                                color: AppTheme.accentCyan,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Icon(
                        Icons.lock_rounded,
                        size: 12,
                        color: AppTheme.accentGreen.withAlpha(180),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
