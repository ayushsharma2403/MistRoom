import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// CloakRoom Dark Glassmorphism Theme.
class AppTheme {
  // Core colors
  static const bgDark = Color(0xFF090C15);
  static const bgCard = Color(0xBF12182A); // rgba(18,24,40,0.75)
  static const bgCardHover = Color(0xD91C253C); // rgba(28,37,60,0.85)
  static const borderGlass = Color(0x14FFFFFF); // rgba(255,255,255,0.08)
  static const borderGlow = Color(0x4D8B5CF6); // rgba(139,92,246,0.3)

  static const primary = Color(0xFF8B5CF6);
  static const primaryHover = Color(0xFF7C3AED);
  static const accentPink = Color(0xFFEC4899);
  static const accentCyan = Color(0xFF06B6D4);
  static const accentGreen = Color(0xFF10B981);
  static const accentAmber = Color(0xFFF59E0B);

  static const textMain = Color(0xFFF8FAFC);
  static const textMuted = Color(0xFF94A3B8);
  static const textDim = Color(0xFF64748B);

  static ThemeData get darkTheme {
    return ThemeData(
      brightness: Brightness.dark,
      scaffoldBackgroundColor: bgDark,
      primaryColor: primary,
      colorScheme: const ColorScheme.dark(
        primary: primary,
        secondary: accentCyan,
        surface: bgCard,
        error: Color(0xFFEF4444),
      ),
      textTheme: GoogleFonts.interTextTheme(ThemeData.dark().textTheme).apply(
        bodyColor: textMain,
        displayColor: textMain,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: bgCard,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          color: textMain,
          fontSize: 18,
          fontWeight: FontWeight.w700,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: const Color(0x990F172A),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: borderGlass),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: borderGlass),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: primary, width: 1.5),
        ),
        hintStyle: const TextStyle(color: textDim),
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: primary,
          foregroundColor: Colors.white,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
          elevation: 4,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: textMain,
          side: const BorderSide(color: borderGlass),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
          textStyle: const TextStyle(fontWeight: FontWeight.w500, fontSize: 15),
        ),
      ),
    );
  }

  /// Glassmorphism card decoration.
  static BoxDecoration glassDecoration({
    double borderRadius = 14,
    bool glow = false,
  }) {
    return BoxDecoration(
      color: bgCard,
      borderRadius: BorderRadius.circular(borderRadius),
      border: Border.all(
        color: glow ? borderGlow : borderGlass,
      ),
      boxShadow: glow
          ? [
              BoxShadow(
                color: primary.withAlpha(60),
                blurRadius: 30,
                offset: const Offset(0, 10),
              ),
            ]
          : [
              const BoxShadow(
                color: Color(0x80000000),
                blurRadius: 30,
                offset: Offset(0, 10),
              ),
            ],
    );
  }

  /// Primary gradient (purple → pink).
  static const primaryGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [primary, accentPink],
  );
}
