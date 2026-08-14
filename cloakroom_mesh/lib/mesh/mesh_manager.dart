import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:uuid/uuid.dart';

import '../crypto/e2e_crypto.dart';
import '../models/chat_message.dart';
import '../models/peer_identity.dart';
import 'bridgefy_transport.dart';
import 'flood_relay.dart';
import 'nearby_connections.dart';
import 'multipeer_connectivity.dart';

const _serviceId = 'com.cloakroom.mesh';
const _uuid = Uuid();

/// Unified Mesh Manager — Orchestrates transport, encryption, and relay.
///
/// Transport priority:
///   1. Bridgefy SDK (if API key available — multi-hop out of the box)
///   2. Native Nearby Connections (Android) / MultipeerConnectivity (iOS)
///      + custom TTL+Message-ID flooding for multi-hop
class MeshManager {
  final E2ECrypto _crypto = E2ECrypto();
  final FloodRelay _floodRelay = FloodRelay();
  final BridgefyTransport _bridgefy = BridgefyTransport();

  // Platform-specific native bridges
  NearbyConnectionsBridge? _nearbyBridge;
  MultipeerConnectivityBridge? _multipeerBridge;

  String? _myPeerId;
  PeerIdentity? _myIdentity;
  String? _currentRoomCode;
  bool _isRunning = false;
  bool _useBridgefy = false;

  // Connected peers: endpointId/peerId -> PeerIdentity
  final Map<String, PeerIdentity> _connectedPeers = {};

  // Callbacks
  void Function(ChatMessage message)? onMessageReceived;
  void Function(ChatMessage systemMessage)? onSystemMessage;
  void Function(List<PeerIdentity> peers)? onPeersChanged;
  void Function(String peerId, bool isTyping)? onTypingChanged;
  void Function(PeerIdentity identity)? onIdentityAssigned;

  PeerIdentity? get myIdentity => _myIdentity;
  String? get myPeerId => _myPeerId;
  bool get isRunning => _isRunning;
  List<PeerIdentity> get connectedPeers => _connectedPeers.values.toList();
  int get peerCount => _connectedPeers.length + 1; // include self

  /// Initialize the mesh manager.
  Future<void> init() async {
    await _crypto.init();
    _myPeerId = _uuid.v4().substring(0, 8);
    _myIdentity = PeerIdentity.generate(_myPeerId!);
    onIdentityAssigned?.call(_myIdentity!);
  }

  /// Start the mesh network for a room.
  Future<bool> startMesh(String roomCode) async {
    _currentRoomCode = roomCode;
    _floodRelay.reset();

    // Try Bridgefy first
    _useBridgefy = await _bridgefy.initialize('');
    if (_useBridgefy) {
      final started = await _bridgefy.start();
      if (started) {
        _bridgefy.onMessageReceived = _onBridgefyMessage;
        _bridgefy.onPeerConnected = _onBridgefyPeerConnected;
        _bridgefy.onPeerDisconnected = _onBridgefyPeerDisconnected;
        _isRunning = true;
        return true;
      }
    }

    // Fallback to native transport + custom flooding
    try {
      if (Platform.isAndroid) {
        _nearbyBridge = NearbyConnectionsBridge();
        _setupNearbyCallbacks();
        _nearbyBridge!.listenForEvents();
        await _nearbyBridge!.startAdvertising(
            _serviceId, _myIdentity?.alias ?? 'CloakPeer');
        await _nearbyBridge!.startDiscovery(_serviceId);
      } else if (Platform.isIOS) {
        _multipeerBridge = MultipeerConnectivityBridge();
        _setupMultipeerCallbacks();
        _multipeerBridge!.listenForEvents();
        await _multipeerBridge!.startMesh(_myIdentity?.alias ?? 'CloakPeer');
      }
      _isRunning = true;
      return true;
    } catch (e) {
      _isRunning = false;
      return false;
    }
  }

  /// Send an encrypted chat message to all mesh peers.
  Future<void> sendMessage(String text) async {
    if (_myIdentity == null || _currentRoomCode == null) return;

    final msgId = _uuid.v4();

    // Build the message
    final msg = ChatMessage(
      id: msgId,
      roomCode: _currentRoomCode!,
      text: text,
      senderId: _myPeerId!,
      senderName: _myIdentity!.alias,
      senderAvatar: _myIdentity!.avatar,
      senderColor: _myIdentity!.color,
      isEncrypted: true,
    );

    // Build the mesh payload (encrypted text for each peer individually)
    final encryptedPayloads =
        await _crypto.encryptForAll(text, _currentRoomCode!);

    final meshPayload = jsonEncode({
      'action': 'chat_message',
      'msgId': msgId,
      'roomCode': _currentRoomCode,
      'senderId': _myPeerId,
      'senderName': _myIdentity!.alias,
      'senderAvatar': _myIdentity!.avatar,
      'senderColor': _myIdentity!.color,
      'timestamp': msg.timestamp.toIso8601String(),
      // For peers without shared secret, include a display indicator
      'encryptedPayloads': encryptedPayloads,
      // Plaintext omitted — E2E encrypted
    });

    // Wrap in flood relay envelope for multi-hop
    final envelope = _floodRelay.createFloodEnvelope(
      messageId: msgId,
      payload: meshPayload,
      originPeerId: _myPeerId!,
      roomCode: _currentRoomCode!,
    );

    // Broadcast across mesh
    await _broadcastRaw(envelope);

    // Deliver locally (sender sees own message immediately)
    onMessageReceived?.call(msg);
  }

  /// Broadcast typing status to all peers.
  Future<void> sendTypingStatus(bool isTyping) async {
    if (_myPeerId == null) return;

    final payload = jsonEncode({
      'action': 'typing',
      'senderId': _myPeerId,
      'alias': _myIdentity?.alias ?? '',
      'isTyping': isTyping,
    });

    // Typing uses simple broadcast, no flood relay needed (ephemeral)
    await _broadcastRaw(payload);
  }

  /// Stop the mesh network.
  Future<void> stopMesh() async {
    _isRunning = false;
    _connectedPeers.clear();

    if (_useBridgefy) {
      _bridgefy.dispose();
    }
    _nearbyBridge?.dispose();
    _multipeerBridge?.dispose();

    _crypto.dispose();
    _floodRelay.reset();
  }

  // --- Internal transport methods ---

  Future<void> _broadcastRaw(String data) async {
    if (_useBridgefy) {
      await _bridgefy.broadcast(data);
    } else if (_nearbyBridge != null) {
      await _nearbyBridge!.broadcastPayload(data);
    } else if (_multipeerBridge != null) {
      await _multipeerBridge!.broadcastData(data);
    }
  }

  Future<void> _sendToPeer(String endpointId, String data) async {
    if (_useBridgefy) {
      await _bridgefy.sendDirect(endpointId, data);
    } else if (_nearbyBridge != null) {
      await _nearbyBridge!.sendPayload(endpointId, data);
    } else if (_multipeerBridge != null) {
      await _multipeerBridge!.sendData(endpointId, data);
    }
  }

  // --- Nearby Connections callbacks (Android) ---

  void _setupNearbyCallbacks() {
    _nearbyBridge!.onEndpointFound = (endpointId, name) {
      _nearbyBridge!.requestConnection(endpointId, _myIdentity?.alias ?? '');
    };

    _nearbyBridge!.onConnectionInitiated = (endpointId) {
      _nearbyBridge!.acceptConnection(endpointId);
    };

    _nearbyBridge!.onConnectionAccepted = (endpointId) {
      _onPeerConnected(endpointId);
    };

    _nearbyBridge!.onDisconnected = (endpointId) {
      _onPeerDisconnected(endpointId);
    };

    _nearbyBridge!.onPayloadReceived = (endpointId, payload) {
      _onRawPayloadReceived(endpointId, payload);
    };
  }

  // --- MultipeerConnectivity callbacks (iOS) ---

  void _setupMultipeerCallbacks() {
    _multipeerBridge!.onPeerFound = (peerId, name) {
      _multipeerBridge!.invitePeer(peerId);
    };

    _multipeerBridge!.onPeerConnected = (peerId) {
      _onPeerConnected(peerId);
    };

    _multipeerBridge!.onPeerDisconnected = (peerId) {
      _onPeerDisconnected(peerId);
    };

    _multipeerBridge!.onDataReceived = (peerId, payload) {
      _onRawPayloadReceived(peerId, payload);
    };
  }

  // --- Bridgefy callbacks ---

  void _onBridgefyMessage(String senderId, String payload) {
    _onRawPayloadReceived(senderId, payload);
  }

  void _onBridgefyPeerConnected(String senderId) {
    _onPeerConnected(senderId);
  }

  void _onBridgefyPeerDisconnected(String senderId) {
    _onPeerDisconnected(senderId);
  }

  // --- Shared peer lifecycle ---

  void _onPeerConnected(String endpointId) {
    // Generate identity for the peer
    final peerIdentity = PeerIdentity.generate(endpointId);
    _connectedPeers[endpointId] = peerIdentity;

    onSystemMessage?.call(ChatMessage.system(
      roomCode: _currentRoomCode ?? '',
      text: '${peerIdentity.avatar} ${peerIdentity.alias} joined the mesh',
    ));

    _notifyPeersChanged();

    // Exchange public keys for E2E encryption
    _exchangePublicKey(endpointId);
  }

  void _onPeerDisconnected(String endpointId) {
    final peer = _connectedPeers.remove(endpointId);
    _crypto.removePeer(endpointId);

    if (peer != null) {
      onSystemMessage?.call(ChatMessage.system(
        roomCode: _currentRoomCode ?? '',
        text: '${peer.avatar} ${peer.alias} left the mesh',
      ));
    }

    _notifyPeersChanged();
  }

  void _notifyPeersChanged() {
    final allPeers = <PeerIdentity>[];
    if (_myIdentity != null) allPeers.add(_myIdentity!);
    allPeers.addAll(_connectedPeers.values);
    onPeersChanged?.call(allPeers);
  }

  // --- E2E Key Exchange ---

  Future<void> _exchangePublicKey(String endpointId) async {
    final pubKeyBytes = await _crypto.getPublicKeyBytes();
    final keyExchangePayload = jsonEncode({
      'action': 'key_exchange',
      'senderId': _myPeerId,
      'publicKey': base64Encode(pubKeyBytes),
    });
    await _sendToPeer(endpointId, keyExchangePayload);
  }

  // --- Incoming payload processing ---

  void _onRawPayloadReceived(String endpointId, String rawPayload) {
    // Check if this is a flood relay envelope
    final floodResult = _floodRelay.processIncoming(rawPayload);

    if (floodResult.isDuplicate) return; // Drop duplicate

    // If should relay further, rebroadcast to all peers
    if (floodResult.shouldRelay && floodResult.relayEnvelope != null) {
      _broadcastRaw(floodResult.relayEnvelope!);
    }

    // Process the actual payload
    final payloadStr = floodResult.payload ?? rawPayload;
    _processPayload(endpointId, payloadStr);
  }

  void _processPayload(String endpointId, String payloadStr) {
    try {
      final data = jsonDecode(payloadStr) as Map<String, dynamic>;
      final action = data['action'] as String?;

      switch (action) {
        case 'key_exchange':
          _handleKeyExchange(endpointId, data);
          break;
        case 'chat_message':
          _handleChatMessage(endpointId, data);
          break;
        case 'typing':
          _handleTyping(data);
          break;
        default:
          break;
      }
    } catch (e) {
      // Malformed payload — ignore
    }
  }

  Future<void> _handleKeyExchange(
      String endpointId, Map<String, dynamic> data) async {
    final pubKeyB64 = data['publicKey'] as String?;
    if (pubKeyB64 == null) return;

    final pubKeyBytes = base64Decode(pubKeyB64);
    await _crypto.deriveSharedSecret(endpointId, Uint8List.fromList(pubKeyBytes));

    // Update peer identity with actual senderId if provided
    final senderId = data['senderId'] as String?;
    if (senderId != null && senderId != endpointId) {
      final identity = _connectedPeers[endpointId];
      if (identity != null) {
        _connectedPeers[endpointId] = PeerIdentity.generate(senderId);
        _notifyPeersChanged();
      }
    }
  }

  Future<void> _handleChatMessage(
      String endpointId, Map<String, dynamic> data) async {
    final senderId = data['senderId'] as String? ?? endpointId;
    final encPayloads = data['encryptedPayloads'] as Map<String, dynamic>?;

    String? plaintext;

    // Try to decrypt the message addressed to us
    if (encPayloads != null && encPayloads.containsKey(endpointId)) {
      final myPayload = encPayloads[endpointId] as Map<String, dynamic>;
      plaintext = await _crypto.decrypt(
        endpointId,
        myPayload['ciphertext'] as String,
        myPayload['iv'] as String,
        myPayload['tag'] as String,
        _currentRoomCode ?? '',
      );
    }

    // Fallback: if we can't decrypt, show encrypted indicator
    final msg = ChatMessage(
      id: data['msgId'] as String? ?? _uuid.v4(),
      roomCode: data['roomCode'] as String? ?? _currentRoomCode ?? '',
      text: plaintext ?? '[🔒 Encrypted Message]',
      senderId: senderId,
      senderName: data['senderName'] as String? ?? 'Anonymous',
      senderAvatar: data['senderAvatar'] as String? ?? '👾',
      senderColor: data['senderColor'] as String? ?? '#a855f7',
      timestamp: DateTime.tryParse(data['timestamp'] as String? ?? ''),
      isEncrypted: true,
    );

    onMessageReceived?.call(msg);
  }

  void _handleTyping(Map<String, dynamic> data) {
    final senderId = data['senderId'] as String?;
    final isTyping = data['isTyping'] as bool? ?? false;
    if (senderId != null && senderId != _myPeerId) {
      onTypingChanged?.call(senderId, isTyping);
    }
  }
}
