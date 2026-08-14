import 'package:flutter/material.dart';
import 'screens/chat_screen.dart';
import 'screens/home_screen.dart';
import 'theme/app_theme.dart';

/// CloakRoom Application Shell.
class CloakRoomApp extends StatelessWidget {
  const CloakRoomApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'CloakRoom — Offline Mesh Chat',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.darkTheme,
      initialRoute: '/',
      onGenerateRoute: _onGenerateRoute,
    );
  }

  Route<dynamic>? _onGenerateRoute(RouteSettings settings) {
    final uri = Uri.parse(settings.name ?? '/');
    final segments = uri.pathSegments;

    // /chat/:roomCode
    if (segments.length == 2 && segments[0] == 'chat') {
      final roomCode = segments[1];
      return MaterialPageRoute(
        builder: (_) => ChatScreen(roomCode: roomCode),
        settings: settings,
      );
    }

    // Default: Home
    return MaterialPageRoute(
      builder: (_) => const HomeScreen(),
      settings: settings,
    );
  }
}
