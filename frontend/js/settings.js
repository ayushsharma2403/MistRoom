/**
 * Identity recovery phrase, peer blocking and stealth settings.
 */
import { state, $ } from './state.js';
import { appendSystemMessage, renderPeers } from './ui.js';
import { DB_NAME } from './outbox.js';
import { LOG_DB_NAME } from './harassment_log.js';
import { addTrustedAuthority, setMyBadge, getMyBadge } from './badges.js';

export const WORDLIST = [
  'alpha', 'beacon', 'cipher', 'delta', 'echo', 'falcon', 'ghost', 'harbor',
  'island', 'jungle', 'kestrel', 'lunar', 'matrix', 'nexus', 'orbit', 'plasma',
  'quantum', 'radar', 'shadow', 'timber', 'ultra', 'vortex', 'whisper', 'zenith'
];

export function generateRecoveryPhrase(passkey, peerId) {
  let hash = 0;
  const str = passkey + '_' + peerId;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const words = [];
  for (let i = 0; i < 12; i++) {
    const idx = Math.abs((hash ^ (i * 7919)) % WORDLIST.length);
    words.push(WORDLIST[idx]);
  }
  return words.join(' ');
}

export function blockPeer(peerId, peerName) {
  if (!peerId) return;
  state.blockedPeerIds.add(peerId);
  const handle = peerName || peerId;
  state.blockedPeersMap.set(peerId, handle);

  localStorage.setItem('mistroom_blocked_peers', JSON.stringify(Array.from(state.blockedPeerIds)));
  localStorage.setItem('mistroom_blocked_peers_map', JSON.stringify(Array.from(state.blockedPeersMap.entries())));

  appendSystemMessage(`🚫 Blocked peer: ${handle}. Their messages and calls are now silenced.`);
  renderPeers(state.currentPeersList);
  renderBlockedList();
}

export function unblockPeer(peerId) {
  state.blockedPeerIds.delete(peerId);
  state.blockedPeersMap.delete(peerId);

  localStorage.setItem('mistroom_blocked_peers', JSON.stringify(Array.from(state.blockedPeerIds)));
  localStorage.setItem('mistroom_blocked_peers_map', JSON.stringify(Array.from(state.blockedPeersMap.entries())));

  appendSystemMessage(`✅ Unblocked peer: ${peerId}.`);
  renderPeers(state.currentPeersList);
  renderBlockedList();
}

export function renderBlockedList() {
  const list = $('blocked-peers-list');
  if (!list) return;
  list.textContent = '';
  if (state.blockedPeerIds.size === 0) {
    const emptyLi = document.createElement('li');
    emptyLi.className = 'empty-hint';
    emptyLi.textContent = 'No peers blocked.';
    list.append(emptyLi);
    return;
  }
  state.blockedPeerIds.forEach(pId => {
    const li = document.createElement('li');
    li.className = 'blocked-item';
    li.style.display = 'flex';
    li.style.justifyContent = 'space-between';
    li.style.alignItems = 'center';
    li.style.padding = '6px 8px';

    const handle = state.blockedPeersMap.get(pId) || pId;
    const span = document.createElement('span');
    span.textContent = `${handle} (${pId.substring(0, 8)}...)`;
    span.style.fontSize = '12px';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-unblock';
    btn.textContent = 'Unblock';
    btn.addEventListener('click', () => unblockPeer(pId));

    li.append(span, btn);
    list.append(li);
  });
}

export function setupSettingsUI() {
  const settingsBtn = $('settings-toggle-btn');
  const settingsModal = $('settings-modal');
  const closeSettingsBtn = $('close-settings-btn');
  const recoveryDisplay = $('recovery-phrase-display');
  const showRecoveryBtn = $('show-recovery-btn');
  const copyRecoveryBtn = $('copy-recovery-btn');
  const stealthToggle = $('stealth-mode-toggle');
  const panicWipeBtn = $('panic-wipe-btn');
  const beaconToggle = $('beacon-mode-toggle');
  const customIceInput = $('custom-ice-input');

  if (settingsBtn && settingsModal) {
    settingsBtn.addEventListener('click', () => {
      settingsModal.style.display = 'flex';
      if (recoveryDisplay) {
        recoveryDisplay.textContent = '••••••••••••••••••••••••••••••••••••';
        recoveryDisplay.dataset.revealed = 'false';
      }
      if (showRecoveryBtn) showRecoveryBtn.style.display = 'inline-block';
      if (copyRecoveryBtn) copyRecoveryBtn.style.display = 'none';

      if (stealthToggle) stealthToggle.checked = state.isStealthMode;
      if (beaconToggle) beaconToggle.checked = state.beaconConsent === 'public';
      if (customIceInput) customIceInput.value = state.customIceServers || '';
      renderBlockedList();
    });
  }

  if (showRecoveryBtn && recoveryDisplay) {
    showRecoveryBtn.addEventListener('click', () => {
      if (!state.identity || !state.identity.phrase) {
        recoveryDisplay.textContent = 'No phrase available for this session.';
        return;
      }
      const words = state.identity.phrase.split(/\s+/);
      recoveryDisplay.textContent = '';
      const grid = document.createElement('div');
      grid.style.display = 'grid';
      grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
      grid.style.gap = '6px';
      grid.style.textAlign = 'left';

      words.forEach((w, idx) => {
        const item = document.createElement('div');
        item.style.fontSize = '12px';
        item.style.fontFamily = 'var(--font-mono)';
        item.style.background = 'rgba(255,255,255,0.06)';
        item.style.padding = '4px 6px';
        item.style.borderRadius = '4px';
        item.textContent = `${idx + 1}. ${w}`;
        grid.append(item);
      });

      recoveryDisplay.append(grid);
      recoveryDisplay.dataset.revealed = 'true';
      showRecoveryBtn.style.display = 'none';
      if (copyRecoveryBtn) copyRecoveryBtn.style.display = 'inline-block';
    });
  }

  if (customIceInput) {
    customIceInput.addEventListener('change', () => {
      state.customIceServers = customIceInput.value.trim();
      localStorage.setItem('mistroom_custom_ice', state.customIceServers);
      appendSystemMessage('⚙️ Custom STUN/TURN updated.');
    });
  }

  if (beaconToggle) {
    beaconToggle.addEventListener('change', () => {
      state.beaconConsent = beaconToggle.checked ? 'public' : 'room_only';
      localStorage.setItem('mistroom_beacon_consent', state.beaconConsent);
      appendSystemMessage(beaconToggle.checked
        ? '📢 Public emergency beacon broadcast enabled.'
        : '🔒 Emergency alerts restricted to current room only.');
    });
  }

  if (closeSettingsBtn && settingsModal) {
    closeSettingsBtn.addEventListener('click', () => {
      settingsModal.style.display = 'none';
    });
  }

  let clearClipboardTimer = null;
  if (copyRecoveryBtn) {
    copyRecoveryBtn.addEventListener('click', () => {
      if (!state.identity || !state.identity.phrase) return;
      navigator.clipboard.writeText(state.identity.phrase).then(() => {
        copyRecoveryBtn.textContent = 'Copied! (Clears in 60s)';
        setTimeout(() => { copyRecoveryBtn.textContent = 'Copy Seed Phrase'; }, 3000);

        if (clearClipboardTimer) clearTimeout(clearClipboardTimer);
        clearClipboardTimer = setTimeout(() => {
          try {
            navigator.clipboard.writeText('').catch(() => {});
          } catch (e) {}
        }, 60000);
      });
    });
  }

  if (stealthToggle) {
    stealthToggle.addEventListener('change', () => {
      state.isStealthMode = stealthToggle.checked;
      localStorage.setItem('mistroom_stealth', state.isStealthMode ? 'true' : 'false');
      appendSystemMessage(state.isStealthMode ? '👻 Ghost Stealth Mode enabled: You are hidden from public peer lists.' : '👁️ Ghost Mode disabled.');

      const ghostChip = $('ghost-chip');
      if (ghostChip) ghostChip.style.display = state.isStealthMode ? 'inline-flex' : 'none';

      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
          t: 'join',
          name: state.isStealthMode ? 'Ghost' : state.currentNickname,
          peer_id: state.myPeerId,
          room: state.currentRoom,
          ghost: state.isStealthMode
        }));
      }
    });
  }

  // Trusted Authority & Responder Badge Wiring
  const addAuthBtn = $('btn-add-auth');
  if (addAuthBtn) {
    addAuthBtn.addEventListener('click', () => {
      const name = ($('add-auth-name-input').value || '').trim();
      const pk = ($('add-auth-pk-input').value || '').trim();
      if (!pk) return;
      addTrustedAuthority(name, pk);
      $('add-auth-name-input').value = '';
      $('add-auth-pk-input').value = '';
      appendSystemMessage(`🏅 Trusted authority added: ${name || 'Authority'} (${pk.substring(0, 8)}...)`);
    });
  }

  const saveBadgeBtn = $('btn-save-badge');
  if (saveBadgeBtn) {
    saveBadgeBtn.addEventListener('click', () => {
      const val = ($('import-badge-input').value || '').trim();
      if (!val) return;
      try {
        const badge = JSON.parse(val);
        setMyBadge(badge);
        appendSystemMessage(`✓ Responder badge saved for role: ${badge.role}`);
      } catch (e) {
        alert('Invalid badge JSON');
      }
    });
  }

  if (panicWipeBtn) {
    panicWipeBtn.addEventListener('click', () => {
      const wipeLog = $('wipe-include-log-checkbox')?.checked;
      const warning = wipeLog
        ? '🚨 EMERGENCY WIPE INCLUDING INCIDENT EVIDENCE LOG: Are you absolutely sure? This will destroy all messages, encryption keys, AND your legal evidence log.'
        : '🚨 EMERGENCY WIPE: Are you sure? This will delete all encrypted outbox messages, recovery keys, and history. (Incident evidence log will be preserved).';

      if (confirm(warning)) {
        try { window.indexedDB.deleteDatabase(DB_NAME); } catch (e) {}
        if (wipeLog) {
          try { window.indexedDB.deleteDatabase(LOG_DB_NAME); } catch (e) {}
        }
        sessionStorage.clear();
        localStorage.clear();
        location.reload();
      }
    });
  }
}
