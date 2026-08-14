import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Animated typing indicator dots.
class TypingIndicator extends StatefulWidget {
  final String alias;

  const TypingIndicator({super.key, required this.alias});

  @override
  State<TypingIndicator> createState() => _TypingIndicatorState();
}

class _TypingIndicatorState extends State<TypingIndicator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Animated dots
          AnimatedBuilder(
            animation: _ctrl,
            builder: (context, _) {
              return Row(
                mainAxisSize: MainAxisSize.min,
                children: List.generate(3, (i) {
                  final delay = i * 0.16;
                  final t = ((_ctrl.value - delay) % 1.0).clamp(0.0, 1.0);
                  final scale = t < 0.4 ? t / 0.4 : (t < 0.8 ? 1.0 : 0.3);
                  return Container(
                    width: 5,
                    height: 5,
                    margin: const EdgeInsets.symmetric(horizontal: 2),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: AppTheme.accentCyan.withAlpha((scale * 255).toInt()),
                    ),
                  );
                }),
              );
            },
          ),
          const SizedBox(width: 8),
          Text(
            '${widget.alias} is typing via P2P...',
            style: const TextStyle(
              color: AppTheme.accentCyan,
              fontSize: 12,
              fontStyle: FontStyle.italic,
            ),
          ),
        ],
      ),
    );
  }
}
