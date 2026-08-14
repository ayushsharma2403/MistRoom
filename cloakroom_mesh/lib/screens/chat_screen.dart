import 'dart:async';
import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';

import '../mesh/mesh_manager.dart';
import '../models/chat_message.dart';
import '../models/peer_identity.dart';
import '../services/storage_service.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';
import '../widgets/message_bubble.dart';
import '../widgets/mesh_status_badge.dart';
import '../widgets/peer_drawer.dart';
import '../widgets/typing_indicator.dart';

/// Chat screen — Full P2P mesh chat interface.
class ChatScreen extends StatefulWidget {
  final String roomCode;

  const ChatScreen({super.key, required this.roomCode});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _msgCtrl = TextEditingController();
  final _scrollCtrl = ScrollController();
  final _meshManager = MeshManager();
  final _messages = <ChatMessage>[];
  final _typingPeers = <String, String>{}; // peerId -> alias
  var _peers = <PeerIdentity>[];
  bool _meshActive = false;
  bool _showPeerDrawer = false;
  Timer? _typingTimer;

  @override
  void initState() {
    super.initState();
    _initMesh();
  }

  Future<void> _initMesh() async {
    // Load local message history
    _messages.addAll(StorageService.getMessagesForRoom(widget.roomCode));

    // Initialize mesh
    await _meshManager.init();

    _meshManager.onMessageReceived = (msg) {
      setState(() {
        _messages.add(msg);
      });
      StorageService.saveMessage(msg);
      _scrollToBottom();
    };

    _meshManager.onSystemMessage = (msg) {
      setState(() {
        _messages.add(msg);
      });
      _scrollToBottom();
    };

    _meshManager.onPeersChanged = (peers) {
      setState(() {
        _peers = peers;
      });
    };

    _meshManager.onTypingChanged = (peerId, isTyping) {
      setState(() {
        if (isTyping) {
          final peer = _peers.firstWhere(
            (p) => p.peerId == peerId,
            orElse: () => PeerIdentity.generate(peerId),
          );
          _typingPeers[peerId] = peer.alias;
        } else {
          _typingPeers.remove(peerId);
        }
      });
    };

    _meshManager.onIdentityAssigned = (identity) {
      setState(() {
        _peers = [identity];
      });
    };

    final started = await _meshManager.startMesh(widget.roomCode);
    setState(() {
      _meshActive = started;
    });

    if (started) {
      setState(() {
        _messages.add(ChatMessage.system(
          roomCode: widget.roomCode,
          text: '📶 P2P Mesh active — broadcasting on BLE & WiFi...',
        ));
      });
    } else {
      setState(() {
        _messages.add(ChatMessage.system(
          roomCode: widget.roomCode,
          text: '⚠️ Mesh failed to start — check Bluetooth and WiFi permissions.',
        ));
      });
    }
  }

  void _sendMessage() {
    final text = _msgCtrl.text.trim();
    if (text.isEmpty) return;

    _meshManager.sendMessage(text);
    _msgCtrl.clear();
    _meshManager.sendTypingStatus(false);
  }

  void _onTextChanged(String text) {
    _typingTimer?.cancel();
    if (text.isNotEmpty) {
      _meshManager.sendTypingStatus(true);
      _typingTimer = Timer(const Duration(seconds: 2), () {
        _meshManager.sendTypingStatus(false);
      });
    } else {
      _meshManager.sendTypingStatus(false);
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.animateTo(
          _scrollCtrl.position.maxScrollExtent,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOutCubic,
        );
      }
    });
  }

  void _shareRoomCode() {
    SharePlus.instance.share(
      ShareParams(text: 'Join CloakRoom mesh: ${widget.roomCode}'),
    );
  }

  @override
  void dispose() {
    _typingTimer?.cancel();
    _meshManager.stopMesh();
    _msgCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          color: AppTheme.bgDark,
          gradient: RadialGradient(
            center: Alignment(0.8, -0.6),
            radius: 1.4,
            colors: [Color(0x1406B6D4), Colors.transparent],
          ),
        ),
        child: SafeArea(
          child: Column(
            children: [
              _buildHeader(),
              Expanded(
                child: Row(
                  children: [
                    Expanded(child: _buildMessageList()),
                    if (_showPeerDrawer)
                      PeerDrawer(
                        peers: _peers,
                        myPeerId: _meshManager.myPeerId,
                      ),
                  ],
                ),
              ),
              if (_typingPeers.isNotEmpty)
                TypingIndicator(alias: _typingPeers.values.first),
              _buildInputBar(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHeader() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: AppTheme.bgCard,
        border: const Border(
          bottom: BorderSide(color: AppTheme.borderGlass),
        ),
      ),
      child: Row(
        children: [
          // Back
          IconButton(
            icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 18),
            color: AppTheme.textMuted,
            onPressed: () => Navigator.of(context).pop(),
          ),

          // Room info
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('CloakRoom',
                    style: TextStyle(
                        fontSize: 16, fontWeight: FontWeight.w700)),
                Row(
                  children: [
                    // Code badge
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: AppTheme.primary.withAlpha(38),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        widget.roomCode,
                        style: const TextStyle(
                          fontFamily: 'JetBrains Mono',
                          fontSize: 11,
                          color: Color(0xFFC084FC),
                          letterSpacing: 1,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    MeshStatusBadge(
                      peerCount: _meshManager.peerCount,
                      isActive: _meshActive,
                    ),
                  ],
                ),
              ],
            ),
          ),

          // Share button
          IconButton(
            icon: const Icon(Icons.share_rounded, size: 18),
            color: AppTheme.textMuted,
            onPressed: _shareRoomCode,
            tooltip: 'Share Room Code',
          ),

          // Peer drawer toggle
          IconButton(
            icon: Icon(
              _showPeerDrawer
                  ? Icons.people_rounded
                  : Icons.people_outline_rounded,
              size: 20,
            ),
            color: _showPeerDrawer ? AppTheme.accentCyan : AppTheme.textMuted,
            onPressed: () => setState(() => _showPeerDrawer = !_showPeerDrawer),
            tooltip: 'Show Peers',
          ),
        ],
      ),
    );
  }

  Widget _buildMessageList() {
    if (_messages.isEmpty) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('📶', style: TextStyle(fontSize: 48)),
            SizedBox(height: 16),
            Text(
              'Mesh Active',
              style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                  color: AppTheme.textMain),
            ),
            SizedBox(height: 4),
            Text(
              'Waiting for nearby devices...\nMessages travel device-to-device with E2E encryption.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textMuted, fontSize: 13),
            ),
          ],
        ),
      );
    }

    return ListView.separated(
      controller: _scrollCtrl,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      itemCount: _messages.length,
      separatorBuilder: (_, __) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final msg = _messages[index];
        final isMe = msg.senderId == _meshManager.myPeerId;

        Color senderColor;
        try {
          senderColor = Color(
              int.parse(msg.senderColor.replaceFirst('#', '0xFF')));
        } catch (_) {
          senderColor = AppTheme.primary;
        }

        return MessageBubble(
          text: msg.text,
          senderName: msg.senderName,
          senderAvatar: msg.senderAvatar,
          senderColor: senderColor,
          timestamp: _formatTime(msg.timestamp),
          isMe: isMe,
          isSystem: msg.isSystem,
          isEncrypted: msg.isEncrypted,
        );
      },
    );
  }

  Widget _buildInputBar() {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: const BoxDecoration(
        color: AppTheme.bgCard,
        border: Border(top: BorderSide(color: AppTheme.borderGlass)),
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _msgCtrl,
              onChanged: _onTextChanged,
              onSubmitted: (_) => _sendMessage(),
              textInputAction: TextInputAction.send,
              decoration: InputDecoration(
                hintText: 'Type a message...',
                suffixIcon: const Padding(
                  padding: EdgeInsets.only(right: 8),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.lock_rounded,
                          size: 12, color: AppTheme.accentGreen),
                      SizedBox(width: 2),
                      Text('E2E',
                          style: TextStyle(
                              color: AppTheme.accentGreen,
                              fontSize: 10,
                              fontWeight: FontWeight.w600)),
                    ],
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          Container(
            decoration: const BoxDecoration(
              gradient: AppTheme.primaryGradient,
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(
                  color: Color(0x668B5CF6),
                  blurRadius: 12,
                  offset: Offset(0, 4),
                ),
              ],
            ),
            child: IconButton(
              icon: const Icon(Icons.send_rounded, color: Colors.white, size: 20),
              onPressed: _sendMessage,
            ),
          ),
        ],
      ),
    );
  }

  String _formatTime(DateTime dt) {
    final h = dt.hour.toString().padLeft(2, '0');
    final m = dt.minute.toString().padLeft(2, '0');
    return '$h:$m';
  }
}
