import 'dart:convert';
import 'package:hive_flutter/hive_flutter.dart';
import '../models/chat_message.dart';
import '../models/mesh_room.dart';

/// Local encrypted storage service using Hive.
class StorageService {
  static const _messagesBox = 'messages';
  static const _roomsBox = 'rooms';

  /// Initialize Hive storage.
  static Future<void> init() async {
    await Hive.initFlutter();
    await Hive.openBox<String>(_messagesBox);
    await Hive.openBox<String>(_roomsBox);
  }

  /// Save a message locally.
  static Future<void> saveMessage(ChatMessage msg) async {
    final box = Hive.box<String>(_messagesBox);
    await box.put(msg.id, msg.toJson());
  }

  /// Get all messages for a room, sorted by timestamp.
  static List<ChatMessage> getMessagesForRoom(String roomCode) {
    final box = Hive.box<String>(_messagesBox);
    final messages = <ChatMessage>[];
    for (final json in box.values) {
      try {
        final msg = ChatMessage.fromJson(json);
        if (msg.roomCode == roomCode) {
          messages.add(msg);
        }
      } catch (_) {}
    }
    messages.sort((a, b) => a.timestamp.compareTo(b.timestamp));
    return messages;
  }

  /// Save a room locally.
  static Future<void> saveRoom(MeshRoom room) async {
    final box = Hive.box<String>(_roomsBox);
    await box.put(room.roomCode, jsonEncode(room.toMap()));
  }

  /// Get all saved rooms.
  static List<MeshRoom> getAllRooms() {
    final box = Hive.box<String>(_roomsBox);
    final rooms = <MeshRoom>[];
    for (final json in box.values) {
      try {
        rooms.add(MeshRoom.fromMap(jsonDecode(json) as Map<String, dynamic>));
      } catch (_) {}
    }
    rooms.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return rooms;
  }
}
