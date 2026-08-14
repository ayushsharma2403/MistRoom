import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Badge showing P2P mesh connection status.
class MeshStatusBadge extends StatelessWidget {
  final int peerCount;
  final bool isActive;

  const MeshStatusBadge({
    super.key,
    required this.peerCount,
    this.isActive = true,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: isActive
            ? AppTheme.accentCyan.withAlpha(30)
            : AppTheme.textDim.withAlpha(30),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(
          color: isActive
              ? AppTheme.accentCyan.withAlpha(100)
              : AppTheme.textDim.withAlpha(60),
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Animated pulse dot
          _PulseDot(
            color: isActive ? AppTheme.accentCyan : AppTheme.textDim,
          ),
          const SizedBox(width: 6),
          Text(
            '📶 Mesh ($peerCount)',
            style: TextStyle(
              color: isActive ? AppTheme.accentCyan : AppTheme.textDim,
              fontSize: 12,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.5,
            ),
          ),
        ],
      ),
    );
  }
}

class _PulseDot extends StatefulWidget {
  final Color color;
  const _PulseDot({required this.color});

  @override
  State<_PulseDot> createState() => _PulseDotState();
}

class _PulseDotState extends State<_PulseDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 2),
    )..repeat();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _ctrl,
      builder: (context, child) {
        final scale = 1.0 + 0.3 * (0.5 - (_ctrl.value - 0.5).abs()) * 2;
        return Transform.scale(
          scale: scale,
          child: Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: widget.color,
              boxShadow: [
                BoxShadow(
                  color: widget.color.withAlpha(150),
                  blurRadius: 8,
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
