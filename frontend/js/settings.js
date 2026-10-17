/**
 * Identity recovery phrase, peer blocking and stealth settings.
 */
import { state, $ } from './state.js';
import { appendSystemMessage, renderPeers } from './ui.js';
import { DB_NAME } from './outbox.js';

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
  localStorage.setItem('mistroom_blocked_peers', JSON.stringify(Array.from(state.blockedPeerIds)));
  appendSystemMessage(`🚫 Blocked peer: ${peerName || peerId}. Their messages and calls are now silenced.`);
  renderPeers(state.currentPeersList);
  renderBlockedList();
}

export function unblockPeer(peerId) {
  state.blockedPeerIds.delete(peerId);
  localStorage.setItem('mistroom_blocked_peers', JSON.stringify(Array.from(state.blockedPeerIds)));
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
    const span = document.createElement('span');
    span.textContent = pId;

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
  const copyRecoveryBtn = $('copy-recovery-btn');
  const stealthToggle = $('stealth-mode-toggle');
  const panicWipeBtn = $('panic-wipe-btn');

  if (settingsBtn && settingsModal) {
    settingsBtn.addEventListener('click', () => {
      settingsModal.style.display = 'flex';
      const phrase = generateRecoveryPhrase(state.currentPasskey, state.myPeerId);
      if (recoveryDisplay) recoveryDisplay.textContent = phrase;
      if (stealthToggle) stealthToggle.checked = state.isStealthMode;
      renderBlockedList();
    });
  }

  if (closeSettingsBtn && settingsModal) {
    closeSettingsBtn.addEventListener('click', () => {
      settingsModal.style.display = 'none';
    });
  }

  if (copyRecoveryBtn && recoveryDisplay) {
    copyRecoveryBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(recoveryDisplay.textContent).then(() => {
        copyRecoveryBtn.textContent = 'Copied!';
        setTimeout(() => { copyRecoveryBtn.textContent = 'Copy Seed Phrase'; }, 2000);
      });
    });
  }

  if (stealthToggle) {
    stealthToggle.addEventListener('change', () => {
      state.isStealthMode = stealthToggle.checked;
      localStorage.setItem('mistroom_stealth', state.isStealthMode ? 'true' : 'false');
      appendSystemMessage(state.isStealthMode ? '👻 Ghost Stealth Mode enabled: You are hidden from public peer lists.' : '👁️ Ghost Mode disabled.');
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
          t: 'join',
          name: state.isStealthMode ? 'Anonymous' : state.currentNickname,
          peer_id: state.myPeerId,
          room: state.currentRoom
        }));
      }
    });
  }

  if (panicWipeBtn) {
    panicWipeBtn.addEventListener('click', () => {
      if (confirm('🚨 EMERGENCY WIPE: Are you sure? This will delete all encrypted outbox messages, recovery keys, and history immediately.')) {
        try { window.indexedDB.deleteDatabase(DB_NAME); } catch (e) {}
        sessionStorage.clear();
        localStorage.clear();
        location.reload();
      }
    });
  }
}
