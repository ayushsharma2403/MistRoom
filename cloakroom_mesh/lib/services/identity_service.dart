import 'package:uuid/uuid.dart';
import '../models/peer_identity.dart';

/// Service for generating and managing anonymous identities.
class IdentityService {
  static const _uuid = Uuid();
  
  PeerIdentity? _currentIdentity;

  /// Generate a new random peer ID and derive identity from it.
  PeerIdentity generateNewIdentity() {
    final peerId = _uuid.v4().substring(0, 8);
    _currentIdentity = PeerIdentity.generate(peerId);
    return _currentIdentity!;
  }

  /// Get or create the current session identity.
  PeerIdentity get currentIdentity {
    _currentIdentity ??= generateNewIdentity();
    return _currentIdentity!;
  }
}
