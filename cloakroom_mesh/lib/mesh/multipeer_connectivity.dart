import 'dart:async';
import 'package:flutter/services.dart';

/// Flutter bridge to iOS MultipeerConnectivity framework.
///
/// Uses MethodChannel to communicate with the native Swift implementation.
/// Service type: 'cloakroom-mesh'.
class MultipeerConnectivityBridge {
  static const _channel = MethodChannel('com.cloakroom/multipeer');
  static const _eventChannel = EventChannel('com.cloakroom/multipeer_events');

  StreamSubscription? _eventSubscription;

  // Callbacks
  void Function(String peerId, String displayName)? onPeerFound;
  void Function(String peerId)? onPeerLost;
  void Function(String peerId)? onPeerConnected;
  void Function(String peerId)? onPeerDisconnected;
  void Function(String peerId, String payload)? onDataReceived;

  /// Start browsing for nearby peers and advertising self.
  Future<bool> startMesh(String displayName) async {
    try {
      final result = await _channel.invokeMethod<bool>('startMesh', {
        'displayName': displayName,
      });
      return result ?? false;
    } catch (e) {
      return false;
    }
  }

  /// Invite a discovered peer to join the session.
  Future<bool> invitePeer(String peerId) async {
    try {
      final result = await _channel.invokeMethod<bool>('invitePeer', {
        'peerId': peerId,
      });
      return result ?? false;
    } catch (e) {
      return false;
    }
  }

  /// Send data to a specific connected peer.
  Future<bool> sendData(String peerId, String payload) async {
    try {
      final result = await _channel.invokeMethod<bool>('sendData', {
        'peerId': peerId,
        'payload': payload,
      });
      return result ?? false;
    } catch (e) {
      return false;
    }
  }

  /// Broadcast data to all connected peers.
  Future<void> broadcastData(String payload) async {
    try {
      await _channel.invokeMethod('broadcastData', {
        'payload': payload,
      });
    } catch (e) {
      // Ignore
    }
  }

  /// Stop the mesh session.
  Future<void> stopMesh() async {
    try {
      await _channel.invokeMethod('stopMesh');
    } catch (e) {
      // Ignore
    }
  }

  /// Listen for events from the native Swift side.
  void listenForEvents() {
    _eventSubscription =
        _eventChannel.receiveBroadcastStream().listen((event) {
      if (event is! Map) return;
      final data = Map<String, dynamic>.from(event);
      final type = data['type'] as String?;

      switch (type) {
        case 'peerFound':
          onPeerFound?.call(
            data['peerId'] as String,
            data['displayName'] as String? ?? '',
          );
          break;
        case 'peerLost':
          onPeerLost?.call(data['peerId'] as String);
          break;
        case 'peerConnected':
          onPeerConnected?.call(data['peerId'] as String);
          break;
        case 'peerDisconnected':
          onPeerDisconnected?.call(data['peerId'] as String);
          break;
        case 'dataReceived':
          onDataReceived?.call(
            data['peerId'] as String,
            data['payload'] as String? ?? '',
          );
          break;
      }
    });
  }

  /// Dispose resources.
  void dispose() {
    _eventSubscription?.cancel();
    stopMesh();
  }
}
