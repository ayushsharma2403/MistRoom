const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

export class PeerMeshManager {
  constructor(groupId, peerId, callbacks) {
    this.groupId = groupId;
    this.peerId = peerId;
    this.callbacks = callbacks || {};

    this.signalingWs = null;
    this.myIdentity = null;

    // targetPeerId -> { pc: RTCPeerConnection, dc: RTCDataChannel, info: dict }
    this.peers = {};
  }

  connect() {
    const wsUrl = `ws://127.0.0.1:8000/ws/${this.groupId}`;
    this.signalingWs = new WebSocket(wsUrl);

    this.signalingWs.onopen = () => {
      console.log(`[P2P Mesh] Connected to Signaling Server for group ${this.groupId}`);
      this.sendSignaling({
        type: 'join',
        peerId: this.peerId
      });
    };

    this.signalingWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleSignalingMessage(data);
      } catch (err) {
        console.error('[Signaling Parse Error]', err);
      }
    };

    this.signalingWs.onclose = () => {
      console.log('[P2P Mesh] Signaling WebSocket disconnected.');
    };

    this.signalingWs.onerror = (err) => {
      console.error('[P2P Mesh Signaling Error]', err);
    };
  }

  sendSignaling(payload) {
    if (this.signalingWs && this.signalingWs.readyState === WebSocket.OPEN) {
      this.signalingWs.send(JSON.stringify(payload));
    }
  }

  async handleSignalingMessage(data) {
    switch (data.type) {
      case 'joined_ack':
        this.myIdentity = data.identity;
        if (this.callbacks.onAck) this.callbacks.onAck(data.identity);

        // Initiate P2P connection to all existing peers in room
        if (data.existingPeers && Array.isArray(data.existingPeers)) {
          for (const peer of data.existingPeers) {
            if (peer.peerId !== this.peerId) {
              await this.initiatePeerConnection(peer.peerId, peer, true);
            }
          }
        }
        this.notifyMeshState();
        break;

      case 'peer_joined':
        console.log(`[P2P Mesh] Peer ${data.newPeer.alias} joined signaling channel`);
        // Peer will initiate offer to us, or we prepare slot
        this.notifyMeshState();
        break;

      case 'signal_offer':
        await this.handleOffer(data.fromPeerId, data.fromPeerInfo, data.offer);
        break;

      case 'signal_answer':
        await this.handleAnswer(data.fromPeerId, data.answer);
        break;

      case 'signal_ice':
        await this.handleIceCandidate(data.fromPeerId, data.candidate);
        break;

      case 'peer_left':
        this.closePeer(data.peerId);
        if (this.callbacks.onSystemMessage) {
          this.callbacks.onSystemMessage({
            id: 'sys_' + Date.now(),
            text: `${data.peerInfo?.avatar || '🚪'} ${data.peerInfo?.alias || 'Peer'} disconnected from mesh`,
            isSystem: true
          });
        }
        this.notifyMeshState();
        break;

      default:
        break;
    }
  }

  // WebRTC Peer Connection Setup
  async initiatePeerConnection(targetPeerId, targetPeerInfo, isInitiator) {
    if (this.peers[targetPeerId]) return;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.peers[targetPeerId] = {
      pc,
      dc: null,
      info: targetPeerInfo,
      isConnected: false
    };

    // Handle ICE Candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignaling({
          type: 'signal_ice',
          targetPeerId,
          candidate: event.candidate
        });
      }
    };

    if (isInitiator) {
      // Create DataChannel if initiator
      const dc = pc.createDataChannel('cloakroom-mesh-channel');
      this.setupDataChannel(targetPeerId, dc);
      this.peers[targetPeerId].dc = dc;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.sendSignaling({
        type: 'signal_offer',
        targetPeerId,
        offer
      });
    } else {
      // Wait for incoming DataChannel
      pc.ondatachannel = (event) => {
        const dc = event.channel;
        this.setupDataChannel(targetPeerId, dc);
        this.peers[targetPeerId].dc = dc;
      };
    }
  }

  async handleOffer(fromPeerId, fromPeerInfo, offer) {
    await this.initiatePeerConnection(fromPeerId, fromPeerInfo, false);
    const peerData = this.peers[fromPeerId];

    await peerData.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerData.pc.createAnswer();
    await peerData.pc.setLocalDescription(answer);

    this.sendSignaling({
      type: 'signal_answer',
      targetPeerId: fromPeerId,
      answer
    });
  }

  async handleAnswer(fromPeerId, answer) {
    const peerData = this.peers[fromPeerId];
    if (peerData && peerData.pc) {
      await peerData.pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  async handleIceCandidate(fromPeerId, candidate) {
    const peerData = this.peers[fromPeerId];
    if (peerData && peerData.pc) {
      try {
        await peerData.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error('[ICE Error]', e);
      }
    }
  }

  setupDataChannel(peerId, dc) {
    dc.onopen = () => {
      console.log(`[P2P Mesh] DataChannel OPEN with Peer ${peerId}`);
      if (this.peers[peerId]) {
        this.peers[peerId].isConnected = true;
      }
      this.notifyMeshState();

      if (this.callbacks.onSystemMessage && this.peers[peerId]?.info) {
        const info = this.peers[peerId].info;
        this.callbacks.onSystemMessage({
          id: 'sys_' + Date.now(),
          text: `${info.avatar} ${info.alias} connected directly via P2P Mesh`,
          isSystem: true
        });
      }
    };

    dc.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleP2PEvent(data);
      } catch (e) {
        console.error('[P2P Message Error]', e);
      }
    };

    dc.onclose = () => {
      console.log(`[P2P Mesh] DataChannel CLOSED with Peer ${peerId}`);
      this.closePeer(peerId);
      this.notifyMeshState();
    };
  }

  handleP2PEvent(data) {
    switch (data.type) {
      case 'p2p_chat':
        if (this.callbacks.onMessage) this.callbacks.onMessage(data.message);
        break;
      case 'p2p_typing':
        if (this.callbacks.onTyping) this.callbacks.onTyping(data);
        break;
      default:
        break;
    }
  }

  broadcastP2P(messagePayload) {
    const p2pEvent = JSON.stringify({
      type: 'p2p_chat',
      message: messagePayload
    });

    let sentDirectlyCount = 0;
    for (const [peerId, peerData] of Object.entries(this.peers)) {
      if (peerData.dc && peerData.dc.readyState === 'open') {
        peerData.dc.send(p2pEvent);
        sentDirectlyCount++;
      }
    }

    // Backup: store message in server DB for history persistence
    this.sendSignaling({
      type: 'store_message',
      message: messagePayload
    });

    return sentDirectlyCount;
  }

  sendP2PTyping(isTyping) {
    const payload = JSON.stringify({
      type: 'p2p_typing',
      peerId: this.peerId,
      alias: this.myIdentity?.alias || 'Peer',
      isTyping
    });

    for (const peerData of Object.values(this.peers)) {
      if (peerData.dc && peerData.dc.readyState === 'open') {
        peerData.dc.send(payload);
      }
    }
  }

  closePeer(peerId) {
    if (this.peers[peerId]) {
      if (this.peers[peerId].dc) this.peers[peerId].dc.close();
      if (this.peers[peerId].pc) this.peers[peerId].pc.close();
      delete this.peers[peerId];
    }
  }

  notifyMeshState() {
    const connectedPeers = Object.values(this.peers)
      .filter((p) => p.isConnected)
      .map((p) => p.info);

    if (this.myIdentity) {
      connectedPeers.unshift(this.myIdentity);
    }

    if (this.callbacks.onState) {
      this.callbacks.onState({
        peers: connectedPeers,
        peerCount: connectedPeers.length
      });
    }
  }

  disconnect() {
    for (const peerId of Object.keys(this.peers)) {
      this.closePeer(peerId);
    }
    if (this.signalingWs) {
      this.signalingWs.close();
    }
  }
}
