import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Chat message bubble with E2E encryption indicator.
class MessageBubble extends StatelessWidget {
  final String text;
  final String senderName;
  final String senderAvatar;
  final Color senderColor;
  final String timestamp;
  final bool isMe;
  final bool isSystem;
  final bool isEncrypted;

  const MessageBubble({
    super.key,
    required this.text,
    required this.senderName,
    required this.senderAvatar,
    required this.senderColor,
    required this.timestamp,
    required this.isMe,
    this.isSystem = false,
    this.isEncrypted = true,
  });

  @override
  Widget build(BuildContext context) {
    if (isSystem) return _buildSystemBubble();
    return _buildChatBubble();
  }

  Widget _buildSystemBubble() {
    return Center(
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        decoration: BoxDecoration(
          color: AppTheme.borderGlass,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: AppTheme.borderGlass),
        ),
        child: Text(
          text,
          style: const TextStyle(
            color: AppTheme.textDim,
            fontSize: 12,
          ),
        ),
      ),
    );
  }

  Widget _buildChatBubble() {
    return Align(
      alignment: isMe ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 300),
        child: Column(
          crossAxisAlignment:
              isMe ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            // Sender label
            if (!isMe)
              Padding(
                padding: const EdgeInsets.only(left: 4, bottom: 4),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(senderAvatar, style: const TextStyle(fontSize: 13)),
                    const SizedBox(width: 4),
                    Text(
                      senderName,
                      style: TextStyle(
                        color: senderColor,
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),

            // Message bubble
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              decoration: BoxDecoration(
                gradient: isMe ? AppTheme.primaryGradient : null,
                color: isMe ? null : const Color(0xD91E293B),
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(16),
                  topRight: const Radius.circular(16),
                  bottomLeft: Radius.circular(isMe ? 16 : 2),
                  bottomRight: Radius.circular(isMe ? 2 : 16),
                ),
                border: isMe ? null : Border.all(color: AppTheme.borderGlass),
                boxShadow: isMe
                    ? [
                        BoxShadow(
                          color: AppTheme.primary.withAlpha(100),
                          blurRadius: 12,
                          offset: const Offset(0, 4),
                        ),
                      ]
                    : null,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    text,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 15,
                    ),
                  ),
                  if (isEncrypted)
                    const Padding(
                      padding: EdgeInsets.only(top: 4),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.lock_rounded,
                              size: 10, color: AppTheme.accentGreen),
                          SizedBox(width: 2),
                          Text(
                            'E2E',
                            style: TextStyle(
                              color: AppTheme.accentGreen,
                              fontSize: 9,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),

            // Timestamp
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                timestamp,
                style: const TextStyle(
                  color: AppTheme.textDim,
                  fontSize: 10,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
