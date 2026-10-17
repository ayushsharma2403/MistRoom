/**
 * UI Rendering and DOM Interactions for MistRoom.
 */
import { state, $ } from './state.js';
import { triageText } from './triage.js';
import { encryptMessage, deriveEncryptionKey } from './crypto.js';
import { queueOfflineMessage } from './outbox.js';
import { blockPeer, unblockPeer } from './settings.js';

export const CATEGORY_LABELS = {
  sos: '🚨 SOS',
  women_safety: '🛡️ SAFETY ALERT',
  general: ''
};

export function getStatusIcon(status) {
  switch (status) {
    case 'queued': return '🕒 Queued';
    case 'delivered': return '✓ Delivered';
    case 'sent':
    default:
      return '⬆️ Sent';
  }
}

export function updateMessageStatus(mid, status) {
  const el = $(`status_${mid}`);
  if (el) {
    el.className = `msg-status-ack ${status}`;
    el.textContent = getStatusIcon(status);
  }
  const msgObj = state.messagesHistory.find(m => m.id === mid);
  if (msgObj) msgObj.status = status;
}

export function updateSOSBanner() {
  const latestEmergency = state.messagesHistory
    .filter(m => m.cat === 'sos' || m.cat === 'women_safety')
    .slice(-1)[0];
  const banner = $('sos-banner');
  if (latestEmergency) {
    banner.style.display = 'block';
    if (latestEmergency.cat === 'women_safety') {
      banner.style.background = 'linear-gradient(135deg, #7928CA, #FF0080)';
      banner.textContent = `🛡️ SAFETY DISTRESS from ${latestEmergency.from}: ${(latestEmergency.text || '').substring(0, 80)}`;
    } else {
      banner.style.background = '';
      banner.textContent = `🚨 SOS from ${latestEmergency.from}: ${(latestEmergency.text || '').substring(0, 80)}`;
    }
  } else {
    banner.style.display = 'none';
  }
}

export function appendSystemMessage(text) {
  const list = $('messages-list');
  const sys = document.createElement('div');
  sys.className = 'system-msg';
  sys.textContent = text;
  list.append(sys);
  list.scrollTop = list.scrollHeight;
}

export function appendMessageToUI(msg, autoScroll = true) {
  const list = $('messages-list');
  const bubble = document.createElement('div');
  const isMe = msg.from === state.currentNickname || msg.peer_id === state.myPeerId;
  const isDM = !!msg.target_peer || !!msg.is_dm;

  bubble.id = `bubble_${msg.id}`;
  const catClass = msg.cat ? `cat-${msg.cat}` : '';
  bubble.className = `msg-bubble ${catClass} ${isMe ? 'me' : ''} ${isDM ? 'is-dm' : ''}`;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const sender = document.createElement('span');
  sender.className = 'msg-sender';
  sender.textContent = isMe ? 'You' : msg.from;

  const time = document.createElement('span');
  time.textContent = new Date(msg.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  meta.append(sender, time);

  if (isDM) {
    const dmTag = document.createElement('span');
    dmTag.className = 'dm-tag';
    dmTag.textContent = '🔒 Direct';
    meta.append(dmTag);
  }

  if (msg.route) {
    const route = document.createElement('span');
    route.className = 'route-tag';
    route.textContent = msg.route;
    meta.append(route);
  }

  if (CATEGORY_LABELS[msg.cat]) {
    const badge = document.createElement('span');
    badge.className = 'cat-badge';
    badge.textContent = CATEGORY_LABELS[msg.cat];
    meta.append(badge);
  }

  const textNode = document.createElement('div');
  textNode.className = 'msg-text';
  textNode.textContent = msg.text || '';
  if (msg.text) bubble.append(meta, textNode);
  else bubble.append(meta);

  if (msg.file) {
    const isImage = (msg.file.type || '').startsWith('image/');
    if (isImage && msg.file.url) {
      const img = document.createElement('img');
      img.src = msg.file.url;
      img.alt = msg.file.name;
      img.className = 'file-image-preview';
      img.addEventListener('click', () => window.open(msg.file.url, '_blank'));
      bubble.append(img);
    }

    const fileCard = document.createElement('a');
    fileCard.className = 'file-card';
    fileCard.href = msg.file.url || '#';
    fileCard.download = msg.file.name;
    fileCard.target = '_blank';

    const cardIcon = document.createElement('div');
    cardIcon.className = 'file-card-icon';
    cardIcon.textContent = isImage ? '🖼️' : '📄';

    const cardInfo = document.createElement('div');
    cardInfo.className = 'file-card-info';

    const cardName = document.createElement('div');
    cardName.className = 'file-card-name';
    cardName.title = msg.file.name;
    cardName.textContent = msg.file.name;

    const cardSize = document.createElement('div');
    cardSize.className = 'file-card-size';
    cardSize.textContent = `${(msg.file.size / 1024).toFixed(1)} KB • Encrypted P2P`;

    cardInfo.append(cardName, cardSize);

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'file-card-btn';
    downloadBtn.textContent = 'Download';

    fileCard.append(cardIcon, cardInfo, downloadBtn);
    bubble.append(fileCard);
  }

  if (isMe) {
    const footerMeta = document.createElement('div');
    footerMeta.className = 'msg-footer-meta';
    const statusSpan = document.createElement('span');
    statusSpan.id = `status_${msg.id}`;
    statusSpan.className = `msg-status-ack ${msg.status || 'sent'}`;
    statusSpan.textContent = getStatusIcon(msg.status || 'sent');
    footerMeta.append(statusSpan);
    bubble.append(footerMeta);
  }

  list.append(bubble);
  if (autoScroll) list.scrollTop = list.scrollHeight;
}

export function renderPeers(peers) {
  $('peer-count').textContent = peers.length;
  const list = $('peers-list');
  list.textContent = '';

  peers.forEach(p => {
    const li = document.createElement('li');
    const isMe = p.peer_id === state.myPeerId || p.name === state.currentNickname;
    const isP2P = state.meshPeers.has(p.peer_id) && state.meshPeers.get(p.peer_id).dc?.readyState === 'open';
    const isCurrentDM = state.activeDirectPeer && state.activeDirectPeer.peer_id === p.peer_id;
    const isBlocked = state.blockedPeerIds.has(p.peer_id);

    li.className = isMe ? '' : 'peer-item-interactive';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name;
    li.append(nameSpan);

    if (!isMe) {
      if (isBlocked) {
        const blockedTag = document.createElement('strong');
        blockedTag.style.color = '#DC2626';
        blockedTag.textContent = ' (Blocked)';
        nameSpan.append(blockedTag);
      }
      if (isCurrentDM) {
        const dmBadge = document.createElement('span');
        dmBadge.className = 'badge-mini';
        dmBadge.style.background = '#3A86FF';
        dmBadge.textContent = 'Chatting';
        li.append(dmBadge);
      }
      if (isP2P) {
        const p2pTag = document.createElement('span');
        p2pTag.className = 'route-tag';
        p2pTag.textContent = 'P2P';
        li.append(p2pTag);
      }

      const blockBtn = document.createElement('button');
      blockBtn.type = 'button';
      blockBtn.className = 'btn-unblock';
      blockBtn.style.marginLeft = 'auto';
      blockBtn.textContent = isBlocked ? 'Unblock' : 'Block';
      blockBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (isBlocked) unblockPeer(p.peer_id);
        else blockPeer(p.peer_id, p.name);
      });
      li.append(blockBtn);

      li.addEventListener('click', () => {
        if (!isBlocked) startDirectChat(p);
      });
    }
    list.append(li);
  });
}

export function startDirectChat(peer) {
  state.activeDirectPeer = peer;
  const dmBanner = $('dm-banner');
  if (dmBanner) {
    dmBanner.style.display = 'flex';
    $('dm-peer-name').textContent = peer.name;
  }
  const input = $('message-input');
  if (input) {
    input.placeholder = `Direct message to ${peer.name}...`;
    input.focus();
  }
  appendSystemMessage(`🔒 Started 1-on-1 Direct Encrypted Chat with ${peer.name}. Messages will be delivered directly to this peer.`);
  renderPeers(state.currentPeersList);
}

export function closeDirectChat() {
  state.activeDirectPeer = null;
  const dmBanner = $('dm-banner');
  if (dmBanner) dmBanner.style.display = 'none';
  const input = $('message-input');
  if (input) {
    input.placeholder = 'Type message...';
    input.focus();
  }
  appendSystemMessage(`Returned to channel #${state.currentRoom}.`);
  renderPeers(state.currentPeersList);
}

export function renderAvailableRooms(rooms, switchRoomCb) {
  const container = $('available-rooms-list');
  if (!container) return;
  container.textContent = '';
  rooms.forEach(rm => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = `#${rm}`;
    li.append(span);

    if (rm === state.currentRoom) {
      const activeSpan = document.createElement('span');
      activeSpan.className = 'badge-mini';
      activeSpan.textContent = 'Active';
      li.append(activeSpan);
    }

    li.addEventListener('click', () => switchRoomCb(rm));
    container.append(li);
  });
}

export async function sendMessage(rawText, isSOS = false) {
  if (!rawText) return;
  const triage = isSOS ? { cat: 'sos', prio: 3 } : triageText(rawText);

  const effectiveSOS = isSOS || triage.cat === 'sos' || triage.cat === 'women_safety';
  const mid = 'm_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const encrypted = await encryptMessage(rawText);

  const payload = {
    t: 'msg',
    id: mid,
    from: state.currentNickname,
    peer_id: state.myPeerId,
    room: state.currentRoom,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    cat: triage.cat,
    prio: triage.prio,
    sos: effectiveSOS,
    ts: Date.now(),
    ttl: 3,
    hops: 0
  };

  if (state.activeDirectPeer) {
    payload.target_peer = state.activeDirectPeer.peer_id;
    payload.is_dm = true;
  }

  let p2pCount = 0;
  if (state.activeDirectPeer) {
    const targetPeer = state.meshPeers.get(state.activeDirectPeer.peer_id);
    if (targetPeer && targetPeer.dc && targetPeer.dc.readyState === 'open') {
      try {
        targetPeer.dc.send(JSON.stringify(payload));
        p2pCount = 1;
      } catch (e) { }
    }
  } else {
    for (const [, peer] of state.meshPeers) {
      if (peer.dc && peer.dc.readyState === 'open') {
        try {
          peer.dc.send(JSON.stringify(payload));
          p2pCount++;
        } catch (e) { }
      }
    }
  }

  let sentViaRelay = false;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
    sentViaRelay = true;
  }

  let initialStatus = 'sent';
  if (!sentViaRelay && p2pCount === 0) {
    initialStatus = 'queued';
    queueOfflineMessage(payload);
    appendSystemMessage('📦 Message queued in offline outbox. Will auto-relay when connected.');
  }

  const localMessage = {
    ...payload,
    text: rawText,
    status: initialStatus,
    route: p2pCount > 0 ? (state.activeDirectPeer ? 'P2P Direct' : `P2P Mesh (${p2pCount})`) : (sentViaRelay ? 'Relay' : 'Offline Outbox')
  };
  state.messagesHistory.push(localMessage);
  appendMessageToUI(localMessage);
  updateSOSBanner();
}
