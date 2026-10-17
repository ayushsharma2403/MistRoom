/**
 * MistRoom Application Root: wires ES modules, sets up event listeners.
 */
import { state, $ } from './js/state.js';
import {
  deriveEncryptionKey, getOrCreateIdentity, restoreIdentityFromPhrase
} from './js/crypto.js';
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
import {
  startServerlessInitiator, processOfferAndCreateAnswer,
  processAnswerOnInitiator, confirmPairing, renderQrCodeTo,
  resetActiveBootstrap
} from './js/bootstrap.js';
import { router } from './js/transport.js';

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

  const ghostChip = $('ghost-chip');
  if (ghostChip) ghostChip.style.display = state.isStealthMode ? 'inline-flex' : 'none';

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

  // Restore from recovery phrase modal
  const restorePhraseBtn = $('restore-phrase-btn');
  const restoreModal = $('restore-modal');
  const closeRestoreBtn = $('close-restore-btn');
  const submitRestoreBtn = $('submit-restore-btn');
  const restoreInput = $('restore-phrase-input');
  const restoreError = $('restore-error');

  if (restorePhraseBtn && restoreModal) {
    restorePhraseBtn.addEventListener('click', () => {
      restoreModal.style.display = 'flex';
      if (restoreError) restoreError.style.display = 'none';
      if (restoreInput) {
        restoreInput.value = '';
        setTimeout(() => restoreInput.focus(), 50);
      }
    });
  }

  if (closeRestoreBtn && restoreModal) {
    closeRestoreBtn.addEventListener('click', () => {
      restoreModal.style.display = 'none';
    });
  }

  if (submitRestoreBtn && restoreInput) {
    submitRestoreBtn.addEventListener('click', async () => {
      const phrase = restoreInput.value.trim();
      try {
        const identity = await restoreIdentityFromPhrase(phrase);
        state.identity = identity;
        state.myPeerId = identity.peerId;
        restoreModal.style.display = 'none';
        appendSystemMessage(`✅ Successfully restored identity (Peer ID: ${identity.peerId}). You can now enter the mesh.`);
      } catch (err) {
        if (restoreError) {
          restoreError.style.display = 'block';
          restoreError.textContent = err.message || 'Invalid 12-word recovery phrase.';
        }
      }
    });
  }

  // Header ⋯ dropdown menu
  const headerMoreBtn = $('header-more-btn');
  const headerDropdownMenu = $('header-dropdown-menu');
  if (headerMoreBtn && headerDropdownMenu) {
    headerMoreBtn.addEventListener('click', e => {
      e.stopPropagation();
      const isVisible = headerDropdownMenu.style.display === 'flex';
      headerDropdownMenu.style.display = isVisible ? 'none' : 'flex';
    });

    document.addEventListener('click', e => {
      if (!headerMoreBtn.contains(e.target) && !headerDropdownMenu.contains(e.target)) {
        headerDropdownMenu.style.display = 'none';
      }
    });

    const menuSettingsBtn = $('menu-settings-btn');
    if (menuSettingsBtn) {
      menuSettingsBtn.addEventListener('click', () => {
        headerDropdownMenu.style.display = 'none';
        const modal = $('settings-modal');
        if (modal) {
          $('settings-toggle-btn')?.click();
        }
      });
    }

    const menuNeedsBtn = $('menu-needs-btn');
    if (menuNeedsBtn) {
      menuNeedsBtn.addEventListener('click', () => {
        headerDropdownMenu.style.display = 'none';
        const sb = $('peers-sidebar');
        if (sb) sb.style.display = 'flex';
        $('tab-btn-needs')?.click();
      });
    }

    const menuMeshBtn = $('menu-mesh-btn');
    if (menuMeshBtn) {
      menuMeshBtn.addEventListener('click', () => {
        headerDropdownMenu.style.display = 'none';
        const sb = $('peers-sidebar');
        if (sb) sb.style.display = 'flex';
        $('tab-btn-mesh')?.click();
      });
    }

    const menuServerlessBtn = $('menu-serverless-btn');
    if (menuServerlessBtn) {
      menuServerlessBtn.addEventListener('click', () => {
        headerDropdownMenu.style.display = 'none';
        $('serverless-join-btn')?.click();
      });
    }

    const menuLogoutBtn = $('menu-logout-btn');
    if (menuLogoutBtn) {
      menuLogoutBtn.addEventListener('click', () => {
        headerDropdownMenu.style.display = 'none';
        $('logout-btn')?.click();
      });
    }
  }

  // Serverless P2P Offline Pairing Modal Wiring
  const serverlessModal = $('serverless-modal');
  const serverlessJoinBtn = $('serverless-join-btn');
  const closeServerlessBtn = $('close-serverless-btn');

  function openServerlessModal() {
    if (!state.identity) {
      getOrCreateIdentity().then(id => {
        state.identity = id;
        state.myPeerId = id.peerId;
      });
    }
    if (serverlessModal) serverlessModal.style.display = 'flex';
    $('sl-initiator-view').style.display = 'none';
    $('sl-responder-view').style.display = 'none';
    $('sl-verify-view').style.display = 'none';
    $('serverless-role-select').style.display = 'flex';
  }

  if (serverlessJoinBtn) serverlessJoinBtn.addEventListener('click', openServerlessModal);
  if (closeServerlessBtn) closeServerlessBtn.addEventListener('click', () => {
    resetActiveBootstrap();
    if (serverlessModal) serverlessModal.style.display = 'none';
  });

  // Step 1: Start (Initiator)
  $('btn-sl-start')?.addEventListener('click', async () => {
    $('serverless-role-select').style.display = 'none';
    $('sl-initiator-view').style.display = 'block';
    const qrContainer = $('sl-offer-qr');
    qrContainer.textContent = 'Generating offer...';
    try {
      const { encodedStr } = await startServerlessInitiator();
      renderQrCodeTo(qrContainer, encodedStr);
      $('btn-copy-offer').onclick = () => {
        navigator.clipboard?.writeText(encodedStr);
        appendSystemMessage('Offer text copied to clipboard.');
      };
    } catch (e) {
      qrContainer.textContent = 'Error: ' + e.message;
    }
  });

  // Accept Answer on Initiator
  $('btn-submit-answer')?.addEventListener('click', async () => {
    const val = ($('sl-answer-input').value || '').trim();
    if (!val) return;
    try {
      const { pairingCode } = await processAnswerOnInitiator(val);
      $('sl-initiator-view').style.display = 'none';
      $('sl-verify-view').style.display = 'block';
      $('sl-pairing-code-badge').textContent = pairingCode;
    } catch (e) {
      alert('Failed to process answer: ' + e.message);
    }
  });

  // Step 2: Join (Responder)
  $('btn-sl-join')?.addEventListener('click', () => {
    $('serverless-role-select').style.display = 'none';
    $('sl-responder-view').style.display = 'block';
  });

  // Generate Answer on Responder
  $('btn-submit-offer')?.addEventListener('click', async () => {
    const val = ($('sl-offer-input').value || '').trim();
    if (!val) return;
    try {
      const { encodedStr, pairingCode } = await processOfferAndCreateAnswer(val);
      $('sl-answer-display-box').style.display = 'block';
      const qrContainer = $('sl-answer-qr');
      renderQrCodeTo(qrContainer, encodedStr);
      $('btn-copy-answer').onclick = () => {
        navigator.clipboard?.writeText(encodedStr);
        appendSystemMessage('Answer text copied to clipboard.');
      };
      // Show verify screen with code
      setTimeout(() => {
        $('sl-responder-view').style.display = 'none';
        $('sl-verify-view').style.display = 'block';
        $('sl-pairing-code-badge').textContent = pairingCode;
      }, 4000);
    } catch (e) {
      alert('Failed to process offer: ' + e.message);
    }
  });

  // Confirmation of match
  $('btn-sl-confirm')?.addEventListener('click', async () => {
    confirmPairing();
    if (serverlessModal) serverlessModal.style.display = 'none';
    // If not joined yet, unlock the chat interface in serverless room
    if (!state.cryptoKey) {
      state.currentNickname = state.currentNickname || 'OfflinePeer';
      state.currentRoom = 'offline-mesh';
      state.cryptoKey = await deriveEncryptionKey('serverless-mesh-key', state.currentRoom);
      $('join-modal').style.display = 'none';
      $('active-room-badge').textContent = '#offline-mesh';
      $('status-dot').className = 'status-dot online';
      $('status-text').textContent = 'P2P Direct';
    }
  });

  $('btn-sl-cancel')?.addEventListener('click', () => {
    resetActiveBootstrap();
    if (serverlessModal) serverlessModal.style.display = 'none';
    appendSystemMessage('⚠️ P2P pairing cancelled due to security code mismatch.');
  });


  // Composer Plus (+) menu
  const composerPlusBtn = $('composer-plus-btn');
  const composerPlusDropdown = $('composer-plus-dropdown');
  if (composerPlusBtn && composerPlusDropdown) {
    composerPlusBtn.addEventListener('click', e => {
      e.stopPropagation();
      const isVisible = composerPlusDropdown.style.display === 'flex';
      composerPlusDropdown.style.display = isVisible ? 'none' : 'flex';
    });

    document.addEventListener('click', e => {
      if (!composerPlusBtn.contains(e.target) && !composerPlusDropdown.contains(e.target)) {
        composerPlusDropdown.style.display = 'none';
      }
    });
  }

  const attachFileBtn = $('attach-file-btn');
  const fileInput = $('file-input');
  if (attachFileBtn && fileInput) {
    attachFileBtn.addEventListener('click', () => {
      if (composerPlusDropdown) composerPlusDropdown.style.display = 'none';
      fileInput.click();
    });
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
      if (composerPlusDropdown) composerPlusDropdown.style.display = 'none';

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
    if (composerPlusDropdown) composerPlusDropdown.style.display = 'none';
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
      // 4. Logout: reset everything: activeDirectPeer, DM banner, SOS banner, mesh peers, call state, in-memory keys, message list, outbox in-memory references.
      closeDirectChat();
      endCall(false);

      const sosBanner = $('sos-banner');
      if (sosBanner) sosBanner.style.display = 'none';

      const beaconBanner = $('beacon-banner');
      if (beaconBanner) beaconBanner.style.display = 'none';

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

      state.activeDirectPeer = null;
      state.currentNickname = '';
      state.currentPasskey = '';
      state.currentRoom = 'global';
      state.cryptoKey = null;
      state.messagesHistory.length = 0;
      state.currentPeersList = [];
      state.activeBeacons.clear();
      state.openNeeds.clear();
      state.messageAcks.clear();

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

  // Service Worker registration with update prompt
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              appendSystemMessage('Update available. Reload to apply newest version.');
            }
          });
        });
      } catch (err) {
        console.warn('[SW] Registration failed:', err);
      }
    });
  }
});

