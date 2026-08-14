import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Glassmorphism card widget.
class GlassCard extends StatelessWidget {
  final Widget child;
  final EdgeInsets padding;
  final bool glow;
  final VoidCallback? onTap;

  const GlassCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(24),
    this.glow = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        decoration: AppTheme.glassDecoration(glow: glow),
        padding: padding,
        child: child,
      ),
    );
  }
}
