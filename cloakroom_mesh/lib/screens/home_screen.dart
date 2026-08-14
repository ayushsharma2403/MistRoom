import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/mesh_room.dart';
import '../services/storage_service.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';

/// Home screen — Create or Join an offline P2P mesh room.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _roomNameCtrl = TextEditingController();
  final _joinCodeCtrl = TextEditingController();
  List<MeshRoom> _recentRooms = [];

  @override
  void initState() {
    super.initState();
    _loadRecentRooms();
  }

  void _loadRecentRooms() {
    setState(() {
      _recentRooms = StorageService.getAllRooms();
    });
  }

  void _createRoom() {
    final name =
        _roomNameCtrl.text.trim().isEmpty ? 'P2P Mesh Sanctum' : _roomNameCtrl.text.trim();
    final code = MeshRoom.generateCode();
    final room = MeshRoom(roomCode: code, name: name);
    StorageService.saveRoom(room);
    Navigator.of(context).pushNamed('/chat/$code');
  }

  void _joinRoom() {
    final code = _joinCodeCtrl.text.trim().toLowerCase();
    if (code.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter a valid room code')),
      );
      return;
    }
    Navigator.of(context).pushNamed('/chat/$code');
  }

  @override
  void dispose() {
    _roomNameCtrl.dispose();
    _joinCodeCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          color: AppTheme.bgDark,
          gradient: RadialGradient(
            center: Alignment(-0.7, -0.7),
            radius: 1.5,
            colors: [
              Color(0x1F8B5CF6),
              Colors.transparent,
            ],
          ),
        ),
        child: SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Column(
              children: [
                const SizedBox(height: 32),

                // Hero Section
                _buildHero(),
                const SizedBox(height: 36),

                // Create Room Card
                _buildCreateCard(),
                const SizedBox(height: 20),

                // Join Room Card
                _buildJoinCard(),
                const SizedBox(height: 32),

                // Recent Rooms
                if (_recentRooms.isNotEmpty) _buildRecentRooms(),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildHero() {
    return Column(
      children: [
        // E2E badge
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          decoration: BoxDecoration(
            color: AppTheme.primary.withAlpha(25),
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: AppTheme.borderGlow),
          ),
          child: const Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('🛡️', style: TextStyle(fontSize: 13)),
              SizedBox(width: 6),
              Text(
                'E2E Encrypted • Offline P2P Mesh • Zero Servers',
                style: TextStyle(
                  color: Color(0xFFC084FC),
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),

        // Title
        ShaderMask(
          shaderCallback: (bounds) => const LinearGradient(
            colors: [Colors.white, AppTheme.primary, AppTheme.accentCyan],
          ).createShader(bounds),
          child: const Text(
            'CloakRoom',
            style: TextStyle(
              fontSize: 40,
              fontWeight: FontWeight.w800,
              color: Colors.white,
              letterSpacing: -1,
            ),
          ),
        ),
        const SizedBox(height: 12),

        const Text(
          'Device-to-device anonymous chat.\nNo internet, no servers, no trace.',
          textAlign: TextAlign.center,
          style: TextStyle(
            color: AppTheme.textMuted,
            fontSize: 15,
            height: 1.5,
          ),
        ),
      ],
    );
  }

  Widget _buildCreateCard() {
    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Text('⚡', style: TextStyle(fontSize: 24)),
              SizedBox(width: 12),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Create a Secret Room',
                      style: TextStyle(
                          fontSize: 17, fontWeight: FontWeight.w700)),
                  Text('Start an offline P2P mesh space',
                      style:
                          TextStyle(color: AppTheme.textMuted, fontSize: 13)),
                ],
              ),
            ],
          ),
          const SizedBox(height: 20),
          TextField(
            controller: _roomNameCtrl,
            maxLength: 40,
            decoration: const InputDecoration(
              hintText: 'e.g. Cyberpunk Lounge, Secret Ops',
              labelText: 'Room Name (Optional)',
              counterText: '',
            ),
          ),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _createRoom,
              child: const Text('🚀 Create Room'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildJoinCard() {
    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Text('🔑', style: TextStyle(fontSize: 24)),
              SizedBox(width: 12),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Join via Room Code',
                      style: TextStyle(
                          fontSize: 17, fontWeight: FontWeight.w700)),
                  Text('Enter a 6-character mesh code',
                      style:
                          TextStyle(color: AppTheme.textMuted, fontSize: 13)),
                ],
              ),
            ],
          ),
          const SizedBox(height: 20),
          TextField(
            controller: _joinCodeCtrl,
            maxLength: 10,
            inputFormatters: [
              FilteringTextInputFormatter.allow(RegExp('[a-z0-9]')),
            ],
            decoration: const InputDecoration(
              hintText: 'e.g. x8k9m2',
              labelText: 'Room Code',
              counterText: '',
            ),
            style: const TextStyle(
              fontFamily: 'JetBrains Mono',
              letterSpacing: 3,
            ),
          ),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              onPressed: _joinRoom,
              child: const Text('👉 Join Room'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildRecentRooms() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(
          padding: EdgeInsets.only(bottom: 12),
          child: Text(
            '📶 Recent Mesh Rooms',
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w600,
              color: AppTheme.textMuted,
            ),
          ),
        ),
        ..._recentRooms.take(6).map(
              (room) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: GlassCard(
                  padding: const EdgeInsets.all(16),
                  onTap: () {
                    Navigator.of(context).pushNamed('/chat/${room.roomCode}');
                  },
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(room.name,
                              style: const TextStyle(
                                  fontWeight: FontWeight.w600, fontSize: 14)),
                          const SizedBox(height: 2),
                          Text(
                            'Created ${room.createdAt.day}/${room.createdAt.month}/${room.createdAt.year}',
                            style: const TextStyle(
                                color: AppTheme.textDim, fontSize: 11),
                          ),
                        ],
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 4),
                        decoration: BoxDecoration(
                          color: AppTheme.primary.withAlpha(38),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: AppTheme.borderGlow),
                        ),
                        child: Text(
                          room.roomCode,
                          style: const TextStyle(
                            fontFamily: 'JetBrains Mono',
                            color: Color(0xFFC084FC),
                            fontWeight: FontWeight.w600,
                            fontSize: 13,
                            letterSpacing: 1,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
      ],
    );
  }
}
