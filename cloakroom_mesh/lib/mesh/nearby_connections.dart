import 'dart:async';
import 'package:flutter/services.dart';

/// Flutter bridge to Android's Google Nearby Connections API.
///
/// Uses MethodChannel to communicate with the native Kotlin implementation.
/// Strategy: P2P_CLUSTER (many-to-many mesh).
class NearbyConnectionsBridge {
  static const _channel = MethodChannel('com.cloakroom/nearby');
  static const _eventChannel = EventChannel('com.cloakroom/nearby_events');

  StreamSubscription? _eventSubscription;

  // Callbacks
  void Function(String endpointId, String endpointName)? onEndpointFound;
  void Function(String endpointId)? onEndpointLost;
  void Function(String endpointId)? onConnectionInitiated;
  void Function(String endpointId)? onConnectionAccepted;
  void Function(String endpointId)? onDisconnected;
  void Function(String endpointId, String payload)? onPayloadReceived;

  /// Start advertising this device for discovery by nearby peers.
  Future<bool> startAdvertising(String serviceId, String displayName) async {
    try {
      final result = await _channel.invokeMethod<bool>('startAdvertising', {
        'serviceId': serviceId,
        'displayName': displayName,
      });
      return result ?? false;
    } catch (e) {
      return false;
    }
  }

  /// Start discovering nearby advertising devices.
  Future<bool> startDiscovery(String serviceId) async {
    try {
      final result = await _channel.invokeMethod<bool>('startDiscovery', {
        'serviceId': serviceId,
      });
      return result ?? false;
    } catch (e) {
      return false;
    }
  }

  /// Request connection to a discovered endpoint.
  Future<bool> requestConnection(
      String endpointId, String displayName) async {
    try {
      final result = await _channel.invokeMethod<bool>('requestConnection', {
        'endpointId': endpointId,
        'displayName': displayName,
      });
      return result ?? false;
    } catch (e) {
      return false;
    }
  }

  /// Accept an incoming connection request.
  Future<bool> acceptConnection(String endpointId) async {
    try {
      final result = await _channel.invokeMethod<bool>('acceptConnection', {
        'endpointId': endpointId,
      });
      return result ?? false;
    } catch (e) {
      return false;
    }
  }

  /// Send a payload to a connected endpoint.
  Future<bool> sendPayload(String endpointId, String payload) async {
    try {
      final result = await _channel.invokeMethod<bool>('sendPayload', {
        'endpointId': endpointId,
        'payload': payload,
      });
      return result ?? false;
    } catch (e) {
      return false;
    }
  }

  /// Broadcast a payload to all connected endpoints.
  Future<void> broadcastPayload(String payload) async {
    try {
      await _channel.invokeMethod('broadcastPayload', {
        'payload': payload,
      });
    } catch (e) {
      // Silently handle — some peers may have disconnected
    }
  }

  /// Disconnect from a specific endpoint.
  Future<void> disconnectFromEndpoint(String endpointId) async {
    try {
      await _channel.invokeMethod('disconnectFromEndpoint', {
        'endpointId': endpointId,
      });
    } catch (e) {
      // Ignore
    }
  }

  /// Stop all advertising, discovery, and connections.
  Future<void> stopAll() async {
    try {
      await _channel.invokeMethod('stopAll');
    } catch (e) {
      // Ignore
    }
  }

  /// Listen for events from the native side via EventChannel.
  void listenForEvents() {
    _eventSubscription =
        _eventChannel.receiveBroadcastStream().listen((event) {
      if (event is! Map) return;
      final data = Map<String, dynamic>.from(event);
      final type = data['type'] as String?;

      switch (type) {
        case 'endpointFound':
          onEndpointFound?.call(
            data['endpointId'] as String,
            data['endpointName'] as String? ?? '',
          );
          break;
        case 'endpointLost':
          onEndpointLost?.call(data['endpointId'] as String);
          break;
        case 'connectionInitiated':
          onConnectionInitiated?.call(data['endpointId'] as String);
          break;
        case 'connectionAccepted':
          onConnectionAccepted?.call(data['endpointId'] as String);
          break;
        case 'disconnected':
          onDisconnected?.call(data['endpointId'] as String);
          break;
        case 'payloadReceived':
          onPayloadReceived?.call(
            data['endpointId'] as String,
            data['payload'] as String? ?? '',
          );
          break;
      }
    });
  }

  /// Dispose resources.
  void dispose() {
    _eventSubscription?.cancel();
    stopAll();
  }
}
