/**
 * MistRoom Application Root: wires ES modules, sets up event listeners.
 */
import { state, $ } from './js/state.js';
import { deriveEncryptionKey, getOrCreateIdentity } from './js/crypto.js';
import { initIndexedDB, flushOfflineOutbox } from './js/outbox.js';
import { initTriageRules } from './js/triage.js';
import { connectWebSocket } from './js/ws.js';
import { sendEncryptedFile } from './js/files.js';
import {
  startCall, acceptIncomingCall, declineIncomingCall,
  endCall, toggleMic
} from './js/calls.js';
import { setupSettingsUI } from './js/settings.js';
import {
  sendMessage, sendPublicBeacon, appendSystemMessage, closeDirectChat,
  renderPeers, renderAvailableRooms, updateBeaconBanner, renderBeaconListModal,
  renderNeedsBoard, renderMeshTopology
} from './js/ui.js';

export function switchRoom(newRoom) {
  if (!newRoom) return;
  const targetRoom = newRoom.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'global';
  if (targetRoom === state.currentRoom) return;

  // Clear active direct chat on room switch
  closeDirectChat();

  // Send switch_room frame to server; UI updates (badge, peers, key re-derivation) occur on 'history' event
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ t: 'switch_room', room: targetRoom }));
  }
}

async function handleJoin() {
  const nameInput = $('nickname-input');
  const passInput = $('passkey-input');
  const roomInput = $('room-input');
  const passError = $('passkey-error');

  const nickname = (nameInput.value || '').trim();
  const passkey = (passInput.value || '').trim();
  const room = (roomInput.value || '').trim().toLowerCase() || 'global';

  if (!nickname) {
    nameInput.focus();
    return;
  }

  // Passkey is required, minimum 8 characters
  if (!passkey || passkey.length < 8) {
    if (passError) {
      passError.style.display = 'block';
    }
    passInput.focus();
    return;
  } else {
    if (passError) {
      passError.style.display = 'none';
    }
  }

  state.currentNickname = nickname;
  state.currentPasskey = passkey;
  state.currentRoom = room;

  // Initialize or fetch persistent Ed25519 identity from IndexedDB
  const identity = await getOrCreateIdentity();
  state.identity = identity;
  state.myPeerId = identity.peerId;

  $('active-room-badge').textContent = `#${state.currentRoom}`;
  state.cryptoKey = await deriveEncryptionKey(state.currentPasskey, state.currentRoom);

  $('join-modal').style.display = 'none';
  connectWebSocket(switchRoom);
}

document.addEventListener('DOMContentLoaded', () => {
  initIndexedDB();
  initTriageRules();

  window.addEventListener('online', () => {
    appendSystemMessage('🌐 Network reconnected. Flushing offline outbox...');
    flushOfflineOutbox();
  });

  const closeDmBtn = $('close-dm-btn');
  if (closeDmBtn) {
    closeDmBtn.addEventListener('click', closeDirectChat);
  }

  fetch('/api/info')
    .then(res => res.json())
    .then(data => {
      const urlText = data.url || `${location.protocol}//${location.host}`;
      const sideDisplay = $('lan-url-display-sidebar');
      if (sideDisplay) sideDisplay.textContent = urlText;
    })
    .catch(() => {
      const fallback = `${location.protocol}//${location.host}`;
      const sideDisplay = $('lan-url-display-sidebar');
      if (sideDisplay) sideDisplay.textContent = fallback;
    });

  setTimeout(() => {
    const ni = $('nickname-input');
    if (ni) {
      ni.focus();
      ni.select?.();
    }
  }, 100);

  $('join-btn').addEventListener('click', () => handleJoin());

  $('nickname-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleJoin();
    }
  });

  $('passkey-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleJoin();
    }
  });

  const toggleEyeBtn = $('toggle-eye');
  if (toggleEyeBtn) {
    toggleEyeBtn.addEventListener('click', () => {
      const input = $('passkey-input');
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  }

  const quickRoomBtn = $('quick-room-btn');
  if (quickRoomBtn) {
    quickRoomBtn.addEventListener('click', () => {
      const val = $('quick-room-input').value.trim();
      if (val) {
        switchRoom(val);
        $('quick-room-input').value = '';
      }
    });

    $('quick-room-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        quickRoomBtn.click();
      }
    });
  }

  const attachFileBtn = $('attach-file-btn');
  const fileInput = $('file-input');
  if (attachFileBtn && fileInput) {
    attachFileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) {
        sendEncryptedFile(file);
        fileInput.value = '';
      }
    });
  }

  const startVoiceCallBtn = $('start-voice-call-btn');
  if (startVoiceCallBtn) {
    startVoiceCallBtn.addEventListener('click', () => {
      if (!state.activeDirectPeer) return alert('Select a peer to start a call.');
      startCall(state.activeDirectPeer);
    });
  }

  const acceptCallBtn = $('accept-call-btn');
  const declineCallBtn = $('decline-call-btn');
  const hangupCallBtn = $('hangup-call-btn');
  const toggleMicBtn = $('toggle-mic-btn');

  if (acceptCallBtn) acceptCallBtn.addEventListener('click', acceptIncomingCall);
  if (declineCallBtn) declineCallBtn.addEventListener('click', declineIncomingCall);
  if (hangupCallBtn) hangupCallBtn.addEventListener('click', () => endCall(true));
  if (toggleMicBtn) toggleMicBtn.addEventListener('click', toggleMic);

  $('composer-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('message-input');
    sendMessage(input.value.trim());
    input.value = '';
  });

  async function promptBeaconConsentIfNeeded() {
    if (state.beaconConsent) return state.beaconConsent;
    return new Promise(resolve => {
      const modal = $('beacon-consent-modal');
      const publicBtn = $('beacon-consent-public-btn');
      const roomBtn = $('beacon-consent-room-btn');
      if (!modal || !publicBtn || !roomBtn) {
        return resolve('room_only');
      }

      modal.style.display = 'flex';

      const handleChoice = choice => {
        modal.style.display = 'none';
        state.beaconConsent = choice;
        localStorage.setItem('mistroom_beacon_consent', choice);
        publicBtn.removeEventListener('click', onPublic);
        roomBtn.removeEventListener('click', onRoom);
        resolve(choice);
      };

      const onPublic = () => handleChoice('public');
      const onRoom = () => handleChoice('room_only');

      publicBtn.addEventListener('click', onPublic);
      roomBtn.addEventListener('click', onRoom);
    });
  }

  const womenSafetyBtn = $('women-safety-btn');
  if (womenSafetyBtn) {
    womenSafetyBtn.addEventListener('click', async () => {
      const input = $('message-input');
      const customNote = input.value.trim();
      input.value = '';

      const consent = await promptBeaconConsentIfNeeded();

      let coords = null;
      if (navigator.geolocation) {
        appendSystemMessage('🛡️ Women Safety Alert: Acquiring live coordinates (max 3s)...');
        try {
          coords = await new Promise(resolve => {
            let timedOut = false;
            const timer = setTimeout(() => {
              timedOut = true;
              appendSystemMessage('⚠️ GPS fix timed out after 3 seconds. Sending alert without coordinates.');
              resolve(null);
            }, 3000);

            navigator.geolocation.getCurrentPosition(
              pos => {
                if (!timedOut) {
                  clearTimeout(timer);
                  resolve({
                    lat: pos.coords.latitude,
                    lon: pos.coords.longitude,
                    accuracy: pos.coords.accuracy
                  });
                }
              },
              err => {
                if (!timedOut) {
                  clearTimeout(timer);
                  appendSystemMessage(`⚠️ GPS error: ${err.message}. Sending without coordinates.`);
                  resolve(null);
                }
              },
              { timeout: 3000, enableHighAccuracy: true }
            );
          });
        } catch (e) {
          coords = null;
        }
      }

      const locSuffix = coords
        ? `📍 [Location: ${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)} ±${Math.round(coords.accuracy)}m]`
        : '📍 [Location: Unavailable]';
      const alertText = `EMERGENCY WOMEN SAFETY DISTRESS: I feel unsafe / need assistance! ${locSuffix} ${customNote ? '(' + customNote + ')' : ''}`;

      // Send room message with explicit category 'women_safety'
      await sendMessage(alertText, 'women_safety');

      // If user consented to public beacon, send beacon event
      if (consent === 'public') {
        const shortNote = `Women Safety: ${customNote || 'Distress alert'}`;
        await sendPublicBeacon('women_safety', 3, shortNote, coords);
      }
    });
  }

  $('sos-btn').addEventListener('click', async () => {
    const input = $('message-input');
    const text = input.value.trim();
    input.value = '';

    const consent = await promptBeaconConsentIfNeeded();
    const alertText = `SOS! I need immediate help. ${text}`;

    // Send room message with explicit category 'sos'
    await sendMessage(alertText, 'sos');

    // If user consented to public beacon, send beacon event
    if (consent === 'public') {
      const shortNote = `SOS Emergency: ${text || 'Need help immediately'}`;
      await sendPublicBeacon('sos', 3, shortNote, null);
    }
  });

  // Beacon Banner & Modal clicks
  const beaconBanner = $('beacon-banner');
  if (beaconBanner) {
    beaconBanner.addEventListener('click', () => {
      renderBeaconListModal();
      const modal = $('beacon-list-modal');
      if (modal) modal.style.display = 'flex';
    });
  }

  const closeBeaconListBtn = $('close-beacon-list-btn');
  if (closeBeaconListBtn) {
    closeBeaconListBtn.addEventListener('click', () => {
      const modal = $('beacon-list-modal');
      if (modal) modal.style.display = 'none';
    });
  }

  // Sidebar Tab Switching (Peers / Needs / Mesh)
  const tabBtnPeers = $('tab-btn-peers');
  const tabBtnNeeds = $('tab-btn-needs');
  const tabBtnMesh = $('tab-btn-mesh');
  const panelPeers = $('tab-panel-peers');
  const panelNeeds = $('tab-panel-needs');
  const panelMesh = $('tab-panel-mesh');

  function selectTab(activeTab) {
    if (tabBtnPeers) tabBtnPeers.classList.toggle('active', activeTab === 'peers');
    if (tabBtnNeeds) tabBtnNeeds.classList.toggle('active', activeTab === 'needs');
    if (tabBtnMesh) tabBtnMesh.classList.toggle('active', activeTab === 'mesh');

    if (panelPeers) panelPeers.style.display = activeTab === 'peers' ? 'block' : 'none';
    if (panelNeeds) {
      panelNeeds.style.display = activeTab === 'needs' ? 'block' : 'none';
      if (activeTab === 'needs') renderNeedsBoard();
    }
    if (panelMesh) {
      panelMesh.style.display = activeTab === 'mesh' ? 'block' : 'none';
      if (activeTab === 'mesh') renderMeshTopology();
    }
  }

  if (tabBtnPeers) tabBtnPeers.addEventListener('click', () => selectTab('peers'));
  if (tabBtnNeeds) tabBtnNeeds.addEventListener('click', () => selectTab('needs'));
  if (tabBtnMesh) tabBtnMesh.addEventListener('click', () => selectTab('mesh'));

  $('gps-btn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      return appendSystemMessage('Geolocation is not supported by your device.');
    }
    appendSystemMessage('📡 Querying GPS coordinates (max 3s)...');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const coords = `📍 [Location: ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)} ±${Math.round(pos.coords.accuracy)}m] `;
        const input = $('message-input');
        input.value = coords + input.value;
        input.focus();
      },
      err => {
        appendSystemMessage(`⚠️ Geolocation error: ${err.message}`);
      },
      { timeout: 3000, enableHighAccuracy: true }
    );
  });

  const logoutBtn = $('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      for (const [, peer] of state.meshPeers) {
        try {
          if (peer.dc) peer.dc.close();
          if (peer.pc) peer.pc.close();
        } catch (e) {}
      }
      state.meshPeers.clear();

      if (state.ws) {
        state.ws.onclose = null;
        try { state.ws.close(); } catch (e) {}
        state.ws = null;
      }

      state.currentNickname = '';
      state.currentPasskey = '';
      state.currentRoom = 'global';
      state.cryptoKey = null;
      state.messagesHistory.length = 0;
      state.currentPeersList = [];

      $('messages-list').textContent = '';
      $('peers-list').textContent = '';
      $('available-rooms-list').textContent = '';
      $('status-dot').className = 'status-dot';
      $('status-text').textContent = 'Disconnected';
      $('mesh-counter').textContent = 'Mesh: 0 P2P';
      $('peer-count').textContent = '0';
      $('active-room-badge').textContent = '#global';

      $('nickname-input').value = '';
      $('passkey-input').value = '';
      $('room-input').value = '';
      $('join-modal').style.display = 'flex';
      setTimeout(() => $('nickname-input').focus(), 100);
    });
  }

  setupSettingsUI();

  $('toggle-peers-btn').addEventListener('click', () => {
    const sb = $('peers-sidebar');
    sb.style.display = sb.style.display === 'flex' ? '' : 'flex';
  });
});
