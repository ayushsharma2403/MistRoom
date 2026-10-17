/**
 * Shared frontend application state for MistRoom.
 */
export const state = {
  ws: null,
  currentNickname: '',
  currentPasskey: 'mistroom-safe',
  currentRoom: 'global',
  activeDirectPeer: null, // { peer_id, name } or null
  cryptoKey: null,
  myPeerId: 'peer_' + Math.random().toString(36).substring(2, 9),
  messagesHistory: [],
  meshPeers: new Map(), // peerId -> { pc, dc }
  allDiscoveredRooms: ['global'],
  currentPeersList: [],
  forwardedMessageIds: new Set(),
  blockedPeerIds: new Set(JSON.parse(localStorage.getItem('mistroom_blocked_peers') || '[]')),
  isStealthMode: localStorage.getItem('mistroom_stealth') === 'true',
  activeIncomingFiles: new Map(),
  activeCallPeerConnection: null,
  localMediaStream: null,
  currentCallPeer: null,
  callTimerInterval: null,
  callSeconds: 0,
  pendingIncomingCall: null,
  dbInstance: null
};

export const $ = id => document.getElementById(id);
