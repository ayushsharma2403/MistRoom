/**
 * MistRoom Application Root: wires ES modules, sets up event listeners.
 */
console.log('[DEBUG TOP] app.js script executing top-level');
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
  renderNeedsBoard, renderMeshTopology, renderBleNeighbors, updateBleHeaderChip
} from './js/ui.js';
import { BleTransport } from './js/ble/transport_ble.js';
import {
  startServerlessInitiator, processOfferAndCreateAnswer,
  processAnswerOnInitiator, confirmPairing, renderQrCodeTo,
  resetActiveBootstrap
} from './js/bootstrap.js';
import { router } from './js/transport.js';
import {
  startSafeWalk, extendSafeWalk, stopSafeWalk, triggerSafeWalkAlert
} from './js/safewalk.js';
import {
  addIncidentLogEntry, verifyIncidentLog, exportIncidentLogBundle, verifyExternalBundle
} from './js/harassment_log.js';

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

function initApp() {
  console.log('[DEBUG] initApp starting...');
  window.__ranInit = true;
  if (typeof window.RTCPeerConnection === 'undefined') {
    state.webrtcAvailable = false;
    const hideSelectors = [
      '#start-voice-call-btn',
      '#serverless-join-btn',
      '#menu-serverless-btn',
      '#tab-btn-mesh',
      '#panel-mesh',
      '#menu-mesh-btn',
      '#mesh-counter'
    ];
    hideSelectors.forEach(sel => {
      const el = document.querySelector(sel);
      if (el) el.classList.add('u-hidden');
    });
    appendSystemMessage('WebRTC is unavailable in this environment. P2P mesh and voice calls disabled; relay active.');
  } else {
    state.webrtcAvailable = true;
  }

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
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      toggleEyeBtn.setAttribute('title', isPassword ? 'Hide passkey' : 'Show passkey');
      toggleEyeBtn.innerHTML = isPassword
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
             <line x1="1" y1="1" x2="23" y2="23"></line>
           </svg>`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
             <circle cx="12" cy="12" r="3"></circle>
           </svg>`;
    });
  }

  // Privacy Policy and Cookies Modals
  const privacyModal = $('privacy-policy-modal');
  const cookiesModal = $('cookies-modal');
  $('btn-open-privacy')?.addEventListener('click', () => {
    if (privacyModal) privacyModal.style.display = 'flex';
  });
  $('close-privacy-btn')?.addEventListener('click', () => {
    if (privacyModal) privacyModal.style.display = 'none';
  });
  $('btn-open-cookies')?.addEventListener('click', () => {
    if (cookiesModal) cookiesModal.style.display = 'flex';
  });
  $('close-cookies-btn')?.addEventListener('click', () => {
    if (cookiesModal) cookiesModal.style.display = 'none';
  });

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
    const jm = $('join-modal');
    if (jm && !state.cryptoKey) jm.style.display = 'none';
    if (serverlessModal) {
      serverlessModal.classList.remove('u-c8be1ccb');
      serverlessModal.classList.remove('is-hidden');
      serverlessModal.style.display = 'flex';
    }
    $('sl-initiator-view').style.display = 'none';
    $('sl-responder-view').style.display = 'none';
    $('sl-verify-view').style.display = 'none';
    $('serverless-role-select').style.display = 'flex';
  }

  if (serverlessJoinBtn) serverlessJoinBtn.addEventListener('click', openServerlessModal);
  if (closeServerlessBtn) closeServerlessBtn.addEventListener('click', () => {
    resetActiveBootstrap();
    if (serverlessModal) {
      serverlessModal.classList.add('u-c8be1ccb');
      serverlessModal.style.display = 'none';
    }
    const jm = $('join-modal');
    if (jm && !state.cryptoKey) jm.style.display = 'flex';
  });

  // Step 1: Start (Initiator)
  $('btn-sl-start')?.addEventListener('click', async () => {
    $('serverless-role-select').style.display = 'none';
    $('sl-initiator-view').style.display = 'block';
    $('sl-pairing-code-badge').textContent = 'Waiting for the other device...';
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
    $('sl-pairing-code-badge').textContent = 'Waiting for the other device...';
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
      // Show code on verify screen immediately as soon as the answer exists
      $('sl-pairing-code-badge').textContent = pairingCode;
      const verifyHint = $('sl-verify-view')?.querySelector('.settings-hint');
      if (verifyHint) {
        verifyHint.textContent = 'Show this answer to the other device, then compare the code.';
      }
      $('sl-verify-view').style.display = 'block';
    } catch (e) {
      alert('Failed to process offer: ' + e.message);
    }
  });

  // Confirmation of match
  $('btn-sl-confirm')?.addEventListener('click', async () => {
    // If not joined yet, derive encryption key using the shared passkey
    if (!state.cryptoKey) {
      const passkeyVal = ($('sl-passkey-input')?.value || '').trim();
      const errorEl = $('sl-passkey-error');
      if (passkeyVal.length < 8) {
        if (errorEl) errorEl.style.display = 'block';
        return;
      }
      if (errorEl) errorEl.style.display = 'none';

      confirmPairing();
      if (serverlessModal) serverlessModal.style.display = 'none';

      state.currentNickname = state.currentNickname || 'OfflinePeer';
      state.currentRoom = 'offline-mesh';
      state.cryptoKey = await deriveEncryptionKey(passkeyVal, state.currentRoom);
      $('join-modal').style.display = 'none';
      $('active-room-badge').textContent = '#offline-mesh';
      $('status-dot').className = 'status-dot online';
      $('status-text').textContent = 'P2P Direct';
    } else {
      confirmPairing();
      if (serverlessModal) serverlessModal.style.display = 'none';
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

  // Safe Walk Setup & Handlers
  const safewalkBtn = $('safewalk-btn');
  const safewalkModal = $('safewalk-modal');
  const closeSafewalkBtn = $('close-safewalk-btn');
  const startSafewalkBtn = $('btn-start-safewalk');

  if (safewalkBtn) {
    safewalkBtn.addEventListener('click', () => {
      if (composerPlusDropdown) composerPlusDropdown.style.display = 'none';
      if (safewalkModal) safewalkModal.style.display = 'flex';
    });
  }
  if (closeSafewalkBtn) {
    closeSafewalkBtn.addEventListener('click', () => {
      if (safewalkModal) safewalkModal.style.display = 'none';
    });
  }
  if (startSafewalkBtn) {
    startSafewalkBtn.addEventListener('click', () => {
      const dur = parseInt($('safewalk-duration')?.value || '10', 10);
      const note = ($('safewalk-destination')?.value || '').trim();
      startSafeWalk(dur, note);
      if (safewalkModal) safewalkModal.style.display = 'none';
    });
  }

  $('btn-safewalk-safe')?.addEventListener('click', () => {
    stopSafeWalk();
    appendSystemMessage('✅ Safe walk finished: Checked in safely.');
  });

  $('btn-safewalk-extend')?.addEventListener('click', () => {
    extendSafeWalk(5);
  });

  // Duress trigger on long-press of Safe Walk chip
  const safewalkChip = $('safewalk-chip');
  if (safewalkChip) {
    let pressTimer = null;
    safewalkChip.addEventListener('pointerdown', () => {
      pressTimer = setTimeout(() => {
        triggerSafeWalkAlert();
        appendSystemMessage('🚨 DURESS SOS TRIGGERED manually from Safe Walk chip!');
      }, 1500);
    });
    safewalkChip.addEventListener('pointerup', () => {
      if (pressTimer) clearTimeout(pressTimer);
    });
    safewalkChip.addEventListener('pointercancel', () => {
      if (pressTimer) clearTimeout(pressTimer);
    });
  }

  // Incident Harassment Log Handlers
  const incidentLogBtn = $('incident-log-btn');
  const incidentModal = $('incident-log-modal');
  const closeIncidentBtn = $('close-incident-btn');
  const incidentForm = $('incident-form');

  if (incidentLogBtn) {
    incidentLogBtn.addEventListener('click', () => {
      if (composerPlusDropdown) composerPlusDropdown.style.display = 'none';
      if (incidentModal) incidentModal.style.display = 'flex';
    });
  }
  if (closeIncidentBtn) {
    closeIncidentBtn.addEventListener('click', () => {
      if (incidentModal) incidentModal.style.display = 'none';
    });
  }
  if (incidentForm) {
    incidentForm.addEventListener('submit', async e => {
      e.preventDefault();
      const cat = $('incident-cat')?.value || 'other';
      const text = ($('incident-text')?.value || '').trim();
      const photoFile = $('incident-photo')?.files?.[0] || null;

      if (!text && !photoFile) return;

      let lat = null, lon = null;
      if (navigator.geolocation) {
        await new Promise(res => {
          navigator.geolocation.getCurrentPosition(
            p => { lat = p.coords.latitude; lon = p.coords.longitude; res(); },
            () => res(),
            { timeout: 3000 }
          );
        });
      }

      await addIncidentLogEntry({ text, cat, lat, lon, photoBlob: photoFile });
      $('incident-text').value = '';
      if ($('incident-photo')) $('incident-photo').value = '';
      if (incidentModal) incidentModal.style.display = 'none';
      appendSystemMessage('🔒 Incident securely recorded & signed in tamper-evident chain.');
    });
  }

  $('btn-verify-log')?.addEventListener('click', async () => {
    const res = await verifyIncidentLog();
    const resultDiv = $('incident-verify-result');
    if (resultDiv) {
      resultDiv.style.display = 'block';
      if (res.ok) {
        resultDiv.style.color = '#34d399';
        resultDiv.textContent = `✓ Chain valid: All ${res.count} entries verified cryptographically.`;
      } else {
        resultDiv.style.color = '#ef4444';
        resultDiv.textContent = `✗ Integrity broken at entry #${res.brokenIndex}: ${res.reason}`;
      }
    }
  });

  $('btn-export-log')?.addEventListener('click', async () => {
    const bundle = await exportIncidentLogBundle();
    const jsonStr = JSON.stringify(bundle, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `incident_evidence_bundle_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    appendSystemMessage('📦 Incident evidence bundle exported.');
  });

  const btnVerifyExternal = $('btn-verify-external-evidence');
  const importEvidenceFileInput = $('import-evidence-file');

  async function handleVerifyExternalFile() {
    const file = importEvidenceFileInput?.files?.[0];
    const resultDiv = $('incident-verify-result');
    if (!file) {
      if (resultDiv) {
        resultDiv.style.display = 'block';
        resultDiv.style.color = '#ef4444';
        resultDiv.textContent = 'Please select a JSON evidence file first.';
      }
      return;
    }
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const res = await verifyExternalBundle(bundle);
      if (resultDiv) {
        resultDiv.style.display = 'block';
        if (res.ok) {
          resultDiv.style.color = '#34d399';
          resultDiv.textContent = `✓ External Bundle Valid: All ${res.count} entries verified (Creator: ${res.creatorPeerId || 'Unknown'}).`;
        } else {
          resultDiv.style.color = '#ef4444';
          resultDiv.textContent = `✗ External Bundle Invalid: ${res.reason}`;
        }
      }
    } catch (err) {
      if (resultDiv) {
        resultDiv.style.display = 'block';
        resultDiv.style.color = '#ef4444';
        resultDiv.textContent = `✗ Error reading file: ${err.message}`;
      }
    }
  }

  if (btnVerifyExternal) btnVerifyExternal.addEventListener('click', handleVerifyExternalFile);
  if (importEvidenceFileInput) importEvidenceFileInput.addEventListener('change', handleVerifyExternalFile);


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
      const publicBtn = $('btn-consent-beacon');
      const roomBtn = $('btn-consent-room-only');
      if (!modal || !publicBtn || !roomBtn) {
        console.error('Consent modal elements missing from DOM');
        throw new Error('Consent modal elements missing from DOM');
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
  const panelPeers = $('panel-peers');
  const panelNeeds = $('panel-needs');
  const panelMesh = $('panel-mesh');

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

  // Initialize and register BleTransport
  const bleTransport = new BleTransport();
  state.bleTransport = bleTransport;
  router.registerTransport(bleTransport);

  // Setup BLE settings toggle
  const bleToggle = $('ble-mesh-toggle');
  const bleStatus = $('ble-mesh-status');
  const bleNeighborCount = $('ble-neighbor-count');
  const bleErrorBanner = $('ble-error-banner');
  const bleErrorDesc = $('ble-error-desc');

  async function updateBleUI() {
    updateBleHeaderChip(bleTransport);
    renderBleNeighbors(bleTransport);
    if (bleNeighborCount) bleNeighborCount.textContent = `${bleTransport.neighbors.size}`;
    if (bleStatus) bleStatus.textContent = bleTransport.connectedDevices.size > 0 ? `Active (${bleTransport.connectedDevices.size} connected)` : (bleToggle?.checked ? 'Scanning/Standby' : 'Inactive');
  }

  if (bleToggle) {
    bleToggle.checked = localStorage.getItem('mistroom_ble_enabled') === 'true';
    bleToggle.addEventListener('change', async () => {
      const enabled = bleToggle.checked;
      localStorage.setItem('mistroom_ble_enabled', enabled ? 'true' : 'false');
      if (enabled) {
        if (!bleTransport.capabilities.available) {
          if (bleErrorBanner) {
            bleErrorBanner.style.display = 'block';
            if (bleErrorDesc) bleErrorDesc.textContent = 'Native BLE support unavailable in standard web browser. Please install the Android APK.';
          }
          appendSystemMessage('⚠️ BLE Mesh requires the MistRoom native Android app or Capacitor container.');
          bleToggle.checked = false;
          return;
        }
        const started = await bleTransport.start();
        if (!started) {
          if (bleErrorBanner) {
            bleErrorBanner.style.display = 'block';
            if (bleErrorDesc) bleErrorDesc.textContent = 'Bluetooth permissions or adapter is turned off.';
          }
          appendSystemMessage('❌ Failed to start BLE mesh. Please enable Bluetooth and location permissions.');
          bleToggle.checked = false;
        } else {
          if (bleErrorBanner) bleErrorBanner.style.display = 'none';
          appendSystemMessage('📶 BLE Mesh active: scanning and advertising.');
        }
      } else {
        await bleTransport.stop();
        appendSystemMessage('📶 BLE Mesh stopped.');
      }
      updateBleUI();
    });

    if (bleToggle.checked && bleTransport.capabilities.available) {
      bleTransport.start().then(() => updateBleUI()).catch(() => {});
    }
  }

  // Periodic UI update for BLE neighbors and metrics
  setInterval(updateBleUI, 4000);

  // BLE Diagnostics Modal Wiring
  const bleDiagModal = $('ble-diag-modal');
  const openBleDiagBtn = $('btn-open-ble-diag');
  const closeBleDiagBtn = $('close-ble-diag-btn');
  const bleHeaderChip = $('ble-header-chip');
  const fixPermissionsBtn = $('btn-fix-ble-permissions');
  const exportBleLogBtn = $('btn-export-ble-log');

  function openBleDiagnostics() {
    if (!bleDiagModal) return;
    bleDiagModal.style.display = 'flex';
    $('ble-metric-tx').textContent = bleTransport.metrics.packetsTx;
    $('ble-metric-rx').textContent = bleTransport.metrics.packetsRx;
    $('ble-metric-dropped').textContent = bleTransport.metrics.packetsDropped;
    $('ble-metric-dup').textContent = bleTransport.metrics.packetsDup;
    $('ble-metric-frag-tx').textContent = bleTransport.metrics.fragmentsTx;
    $('ble-metric-frag-rx').textContent = bleTransport.metrics.fragmentsRx;
    $('ble-metric-hops').textContent = bleTransport.avgHopCount;
    $('ble-metric-queue').textContent = bleTransport.queue.length;
    $('ble-metric-conn').textContent = `${bleTransport.connectedDevices.size} / 4`;
    $('ble-metric-ratelimit').textContent = bleTransport.metrics.rateLimited;
    $('ble-metric-sigfail').textContent = bleTransport.metrics.sigFailed;

    if (!bleTransport.capabilities.available && bleErrorBanner) {
      bleErrorBanner.style.display = 'block';
      if (bleErrorDesc) bleErrorDesc.textContent = 'Native BLE adapter unavailable. Running in web simulation mode.';
    }
  }

  if (openBleDiagBtn) openBleDiagBtn.addEventListener('click', openBleDiagnostics);
  if (bleHeaderChip) bleHeaderChip.addEventListener('click', openBleDiagnostics);
  if (closeBleDiagBtn) {
    closeBleDiagBtn.addEventListener('click', () => {
      if (bleDiagModal) bleDiagModal.style.display = 'none';
    });
  }

  if (fixPermissionsBtn) {
    fixPermissionsBtn.addEventListener('click', async () => {
      try {
        const ok = await bleTransport.plugin.requestPermissions();
        if (ok) {
          if (bleErrorBanner) bleErrorBanner.style.display = 'none';
          appendSystemMessage('✓ BLE Permissions granted.');
        } else {
          alert('Bluetooth permissions or Bluetooth adapter disabled on device.');
        }
      } catch (e) {
        alert('Permission request failed: ' + e.message);
      }
    });
  }

  if (exportBleLogBtn) {
    exportBleLogBtn.addEventListener('click', () => {
      const logData = bleTransport.exportDiagnosticLog();
      const blob = new Blob([logData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mistroom_ble_diagnostics_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // Safe-walk native alarm listener (Requirement 7)
  window.addEventListener('mistroom:native_alarm', async ev => {
    console.log('Native exact alarm fired for safe-walk:', ev.detail);
    triggerSafeWalkAlert(true);
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

