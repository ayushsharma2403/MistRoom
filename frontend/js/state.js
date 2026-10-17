/**
 * Shared frontend application state for MistRoom.
 */
const safeGetItem = key => (typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null);

export const state = {
  ws: null,
  currentNickname: '',
  currentPasskey: '',
  currentRoom: 'global',
  activeDirectPeer: null, // { peer_id, name } or null
  cryptoKey: null, // 32-byte Uint8Array room key
  identity: null, // { privKey, pubKey, peerId }
  myPeerId: '', // derived from Ed25519 pubKey
  messagesHistory: [],
  meshPeers: new Map(), // peerId -> { pc, dc }
  allDiscoveredRooms: ['global'],
  currentPeersList: [],
  forwardedMessageIds: new Set(),
  blockedPeerIds: new Set(JSON.parse(safeGetItem('mistroom_blocked_peers') || '[]')),
  blockedPeersMap: new Map(JSON.parse(safeGetItem('mistroom_blocked_peers_map') || '[]')), // peerId -> handle
  isStealthMode: safeGetItem('mistroom_stealth') === 'true',
  customIceServers: safeGetItem('mistroom_custom_ice') || '',
  activeIncomingFiles: new Map(),
  activeCallPeerConnection: null,
  localMediaStream: null,
  currentCallPeer: null,
  callTimerInterval: null,
  callSeconds: 0,
  pendingIncomingCall: null,
  pendingCallIceCandidates: [], // Buffer for ICE candidates arriving before PC ready
  dbInstance: null,
  activeBeacons: new Map(), // beaconId -> beaconRecord
  beaconConsent: safeGetItem('mistroom_beacon_consent'), // 'beacon' | 'room_only' | null
  messageAcks: new Map(), // msgId -> Set of peerIds who acked
  openNeeds: new Map() // msgId -> needRecord
};

export const $ = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);
