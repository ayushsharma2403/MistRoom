/**
 * MistRoom Application Root: wires ES modules, sets up event listeners.
 */
import { state, $ } from './js/state.js';
import { deriveEncryptionKey } from './js/crypto.js';
import { initIndexedDB, flushOfflineOutbox } from './js/outbox.js';
import {
  sendMessage, appendSystemMessage, closeDirectChat,
  renderPeers, renderAvailableRooms
} from './js/ui.js';
import { sendEncryptedFile } from './js/files.js';
import {
  startCall, acceptIncomingCall, declineIncomingCall,
  endCall, toggleMic
} from './js/calls.js';
import { setupSettingsUI } from './js/settings.js';
import { connectWebSocket } from './js/ws.js';

export function switchRoom(newRoom) {
  if (!newRoom) return;
  state.currentRoom = newRoom.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'global';
  $('active-room-badge').textContent = `#${state.currentRoom}`;

  appendSystemMessage(`Switched to room: #${state.currentRoom}`);

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ t: 'switch_room', room: state.currentRoom }));
  }
}

async function handleJoin() {
  const nameInput = $('nickname-input');
  const passInput = $('passkey-input');
  const roomInput = $('room-input');

  const nickname = (nameInput.value || '').trim();
  const passkey = (passInput.value || '').trim() || 'default-mesh-pass';
  const room = (roomInput.value || '').trim().toLowerCase() || 'global';

  if (!nickname) {
    nameInput.focus();
    return;
  }

  state.currentNickname = nickname;
  state.currentPasskey = passkey;
  state.currentRoom = room;

  $('active-room-badge').textContent = `#${state.currentRoom}`;
  state.cryptoKey = await deriveEncryptionKey(state.currentPasskey);

  $('join-modal').style.display = 'none';
  connectWebSocket(switchRoom);
}

document.addEventListener('DOMContentLoaded', () => {
  initIndexedDB();

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

  const womenSafetyBtn = $('women-safety-btn');
  if (womenSafetyBtn) {
    womenSafetyBtn.addEventListener('click', () => {
      const input = $('message-input');
      const customNote = input.value.trim();
      input.value = '';

      if (navigator.geolocation) {
        appendSystemMessage('🛡️ Women Safety Alert: Acquiring live coordinates...');
        navigator.geolocation.getCurrentPosition(
          pos => {
            const coords = `📍 [Location: ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}]`;
            const alertText = `EMERGENCY WOMEN SAFETY DISTRESS: I feel unsafe / need assistance! ${coords} ${customNote ? '(' + customNote + ')' : ''}`;
            sendMessage(alertText, true);
          },
          () => {
            sendMessage(`EMERGENCY WOMEN SAFETY DISTRESS: I feel unsafe / need immediate assistance! ${customNote ? '(' + customNote + ')' : ''}`, true);
          },
          { timeout: 6000, enableHighAccuracy: true }
        );
      } else {
        sendMessage(`EMERGENCY WOMEN SAFETY DISTRESS: I feel unsafe / need immediate assistance! ${customNote ? '(' + customNote + ')' : ''}`, true);
      }
    });
  }

  $('sos-btn').addEventListener('click', () => {
    const input = $('message-input');
    const text = input.value.trim();
    sendMessage('SOS! I need immediate help. ' + text, true);
    input.value = '';
  });

  $('gps-btn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      return appendSystemMessage('Geolocation is not supported by your device.');
    }
    appendSystemMessage('📡 Querying GPS coordinates...');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const coords = `📍 [Location: ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}] `;
        const input = $('message-input');
        input.value = coords + input.value;
        input.focus();
      },
      err => {
        appendSystemMessage(`⚠️ Geolocation error: ${err.message}`);
      },
      { timeout: 8000, enableHighAccuracy: true }
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
