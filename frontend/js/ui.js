/**
 * UI Rendering and DOM Interactions for MistRoom.
 * Zero innerHTML with network/user data. Verified signatures and v2 envelopes.
 */
import { state, $ } from './state.js';
import { triageText } from './triage.js';
import {
  encryptEnvelope, signMessageEnvelope, bytesToBase64, signResolveNeed
} from './crypto.js';
import { queueOfflineMessage } from './outbox.js';
import { blockPeer, unblockPeer } from './settings.js';
import { isSafePreviewMime } from './files.js';

export function resolveNeed(id) {
  state.openNeeds.delete(id);
  renderNeedsBoard();

  if (state.identity && state.ws && state.ws.readyState === WebSocket.OPEN) {
    const pkB64 = bytesToBase64(state.identity.pubKey);
    const sigB64 = signResolveNeed(id);
    state.ws.send(JSON.stringify({
      t: 'need_resolved',
      id,
      pk: pkB64,
      sig: sigB64
    }));
  }
}

export const CATEGORY_LABELS = {
  sos: '🚨 SOS',
  women_safety: '🛡️ SAFETY ALERT',
  medical: '🏥 Medical',
  water: '💧 Water',
  shelter: '⛺ Shelter',
  general: ''
};

export const CATEGORY_COLORS = {
  sos: '#ef4444',
  women_safety: '#a855f7',
  medical: '#dc2626', // red
  water: '#2563eb',   // blue
  shelter: '#ea580c', // orange
  general: 'rgba(255,255,255,0.2)'
};

export function getStatusText(msg) {
  if (msg.status === 'queued') return '🕒 Queued';
  if (msg.is_dm) {
    return msg.status === 'delivered' ? '✓ Delivered' : '⬆️ Sent';
  }
  // Room message: Delivered n/m
  const expected = msg.expected_peers || 0;
  const acksSet = state.messageAcks.get(msg.id) || new Set();
  const ackCount = acksSet.size;
  if (expected > 0) {
    return `✓ Delivered ${ackCount}/${expected}`;
  }
  return msg.status === 'delivered' ? '✓ Delivered' : '⬆️ Sent';
}

export function updateMessageStatus(mid, status, fromPeer = null) {
  if (fromPeer) {
    if (!state.messageAcks.has(mid)) state.messageAcks.set(mid, new Set());
    state.messageAcks.get(mid).add(fromPeer);
  }
  const msgObj = state.messagesHistory.find(m => m.id === mid);
  if (msgObj) msgObj.status = status;

  const el = $(`status_${mid}`);
  if (el && msgObj) {
    el.className = `msg-status-ack ${status}`;
    el.textContent = getStatusText(msgObj);
  }
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

export function updateBeaconBanner() {
  const banner = $('beacon-banner');
  const textEl = $('beacon-banner-text');
  const countEl = $('beacon-banner-count');
  if (!banner || !textEl || !countEl) return;

  const beacons = Array.from(state.activeBeacons.values());
  if (beacons.length === 0) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'flex';
  const latest = beacons[beacons.length - 1];
  textEl.textContent = `${latest.handle || 'Citizen'}: ${latest.short_text || ''}`;

  const moreCount = beacons.length - 1;
  countEl.textContent = moreCount > 0 ? `+${moreCount} more` : 'Active';
}

export function renderBeaconListModal() {
  const container = $('active-beacons-container');
  if (!container) return;
  container.textContent = '';

  const beacons = Array.from(state.activeBeacons.values()).reverse();
  if (beacons.length === 0) {
    const empty = document.createElement('div');
    empty.style.color = '#94a3b8';
    empty.textContent = 'No active emergency beacons.';
    container.append(empty);
    return;
  }

  for (const b of beacons) {
    const card = document.createElement('div');
    card.style.background = 'rgba(255,255,255,0.05)';
    card.style.padding = '12px';
    card.style.borderRadius = '8px';
    card.style.borderLeft = `4px solid ${CATEGORY_COLORS[b.cat] || '#ef4444'}`;

    const hdr = document.createElement('div');
    hdr.style.display = 'flex';
    hdr.style.justifyContent = 'space-between';
    hdr.style.marginBottom = '6px';

    const sender = document.createElement('strong');
    sender.textContent = b.handle || 'Citizen';

    const badge = document.createElement('span');
    badge.style.fontSize = '11px';
    badge.style.color = CATEGORY_COLORS[b.cat] || '#ef4444';
    badge.textContent = `${CATEGORY_LABELS[b.cat] || b.cat} (Prio ${b.prio})`;

    hdr.append(sender, badge);

    const txt = document.createElement('div');
    txt.style.color = '#f8fafc';
    txt.textContent = b.short_text;

    card.append(hdr, txt);

    if (b.lat && b.lon) {
      const loc = document.createElement('div');
      loc.style.fontSize = '11px';
      loc.style.color = '#38bdf8';
      loc.style.marginTop = '4px';
      loc.textContent = `📍 Location: ${b.lat.toFixed(5)}, ${b.lon.toFixed(5)} ${b.accuracy ? `(±${Math.round(b.accuracy)}m)` : ''}`;
      card.append(loc);
    }

    container.append(card);
  }
}

export function renderNeedsBoard() {
  const list = $('needs-board-list');
  const counter = $('needs-counter');
  if (!list) return;
  list.textContent = '';

  const needs = Array.from(state.openNeeds.values())
    .sort((a, b) => (b.prio - a.prio) || (b.ts - a.ts));

  if (counter) counter.textContent = `${needs.length} open`;

  if (needs.length === 0) {
    const empty = document.createElement('div');
    empty.style.color = '#94a3b8';
    empty.style.fontSize = '12px';
    empty.style.padding = '8px';
    empty.textContent = 'No open needs recorded yet.';
    list.append(empty);
    return;
  }

  for (const item of needs) {
    const card = document.createElement('div');
    card.style.background = 'rgba(255,255,255,0.06)';
    card.style.padding = '10px';
    card.style.borderRadius = '8px';
    card.style.borderLeft = `3px solid ${CATEGORY_COLORS[item.cat] || '#94a3b8'}`;

    const top = document.createElement('div');
    top.style.display = 'flex';
    top.style.justifyContent = 'space-between';
    top.style.fontSize = '12px';

    const nameSpan = document.createElement('strong');
    nameSpan.textContent = item.from;

    const catBadge = document.createElement('span');
    catBadge.style.color = CATEGORY_COLORS[item.cat] || '#fff';
    catBadge.textContent = `${CATEGORY_LABELS[item.cat] || item.cat} P${item.prio}`;

    top.append(nameSpan, catBadge);

    const msgTxt = document.createElement('div');
    msgTxt.style.fontSize = '12px';
    msgTxt.style.margin = '4px 0';
    msgTxt.textContent = item.text;

    const vitalsRow = document.createElement('div');
    vitalsRow.style.fontSize = '11px';
    vitalsRow.style.color = '#94a3b8';
    const parts = [];
    if (item.vitals?.victims_count) parts.push(`👥 ${item.vitals.victims_count} victims`);
    if (item.vitals?.blood_type) parts.push(`🩸 Blood: ${item.vitals.blood_type}`);
    if (item.vitals?.urgency === 'critical') parts.push(`⚡ Critical`);
    if (item.vitals?.has_location_hint) parts.push(`📍 Location hint`);
    vitalsRow.textContent = parts.join(' • ') || 'Emergency request';

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '6px';
    btnRow.style.marginTop = '8px';

    const helpBtn = document.createElement('button');
    helpBtn.type = 'button';
    helpBtn.className = 'btn-action-sm';
    helpBtn.textContent = 'I can help';
    helpBtn.style.padding = '4px 8px';
    helpBtn.style.fontSize = '11px';
    helpBtn.addEventListener('click', () => {
      // Open DM with requester
      state.activeDirectPeer = { peer_id: item.peer_id, name: item.from };
      $('dm-banner').style.display = 'flex';
      $('dm-peer-name').textContent = item.from;
      $('message-input').focus();
    });
    btnRow.append(helpBtn);

    // If I am requester, show "Resolved" button
    if (item.peer_id === state.myPeerId) {
      const resolveBtn = document.createElement('button');
      resolveBtn.type = 'button';
      resolveBtn.className = 'btn-action-sm';
      resolveBtn.textContent = 'Resolved';
      resolveBtn.style.padding = '4px 8px';
      resolveBtn.style.fontSize = '11px';
      resolveBtn.style.background = 'rgba(34,197,94,0.3)';
      resolveBtn.addEventListener('click', () => {
        resolveNeed(item.id);
      });
      btnRow.append(resolveBtn);
    }

    card.append(top, msgTxt, vitalsRow, btnRow);
    list.append(card);
  }
}

export function renderMeshTopology() {
  const list = $('mesh-topology-list');
  const countEl = $('mesh-topo-count');
  if (!list) return;
  list.textContent = '';

  const peers = Array.from(state.meshPeers.entries());
  if (countEl) countEl.textContent = `${peers.length + 1} nodes`;

  // Self
  const selfLi = document.createElement('li');
  selfLi.style.fontSize = '12px';
  selfLi.style.padding = '6px 8px';
  selfLi.style.background = 'rgba(255,255,255,0.05)';
  selfLi.style.borderRadius = '6px';
  selfLi.textContent = `📍 You (${state.currentNickname || 'Self'}) • Direct local node`;
  list.append(selfLi);

  for (const [pId, p] of peers) {
    const li = document.createElement('li');
    li.style.fontSize = '12px';
    li.style.padding = '6px 8px';
    li.style.background = 'rgba(255,255,255,0.03)';
    li.style.borderRadius = '6px';
    const isOpen = p.dc && p.dc.readyState === 'open';
    li.textContent = `🔗 ${pId.substring(0, 8)}... • ${isOpen ? 'P2P WebRTC (1-hop)' : 'Relay Hub (2-hop)'}`;
    list.append(li);
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

  if (msg.verified) {
    const verifiedDot = document.createElement('span');
    verifiedDot.className = 'verified-dot';
    verifiedDot.title = 'Cryptographically Verified Signature';
    verifiedDot.textContent = '🟢';
    meta.append(verifiedDot);
  }

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
    badge.style.background = CATEGORY_COLORS[msg.cat] || 'rgba(255,255,255,0.15)';
    badge.style.color = '#fff';
    badge.style.padding = '2px 6px';
    badge.style.borderRadius = '4px';
    badge.style.fontSize = '10px';
    badge.style.fontWeight = '600';
    badge.textContent = `${CATEGORY_LABELS[msg.cat]} ${msg.prio ? `(P${msg.prio})` : ''}`;
    meta.append(badge);

    // If actionable emergency need, add to openNeeds board
    if (['medical', 'water', 'shelter', 'sos', 'women_safety'].includes(msg.cat) && msg.text && !msg.unreadable) {
      state.openNeeds.set(msg.id, {
        id: msg.id,
        from: msg.from,
        peer_id: msg.peer_id,
        cat: msg.cat,
        prio: msg.prio || 1,
        text: msg.text,
        vitals: msg.vitals || {},
        ts: msg.ts || Date.now()
      });
      renderNeedsBoard();
    }
  }

  const textNode = document.createElement('div');
  textNode.className = 'msg-text';
  if (msg.unreadable) {
    textNode.style.color = '#94A3B8';
    textNode.style.fontStyle = 'italic';
    textNode.textContent = '[unreadable message]';
  } else {
    textNode.textContent = msg.text || '';
  }

  if (msg.text || msg.unreadable) bubble.append(meta, textNode);
  if (msg.file) {
    const isImage = isSafePreviewMime(msg.file.type);
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
    fileCard.setAttribute('download', msg.file.name);
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

export async function sendPublicBeacon(cat, prio, shortText, coords = null) {
  const bid = 'b_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const ts = Date.now();
  const beaconPayload = {
    t: 'beacon',
    id: bid,
    cat,
    prio,
    short_text: (shortText || '').substring(0, 140),
    lat: coords ? coords.lat : null,
    lon: coords ? coords.lon : null,
    accuracy: coords ? coords.accuracy : null,
    handle: state.isStealthMode ? 'Anonymous' : state.currentNickname,
    ts
  };

  // Broadcast to P2P mesh
  for (const [, peer] of state.meshPeers) {
    if (peer.dc && peer.dc.readyState === 'open') {
      try { peer.dc.send(JSON.stringify(beaconPayload)); } catch (e) {}
    }
  }

  // Broadcast to server relay
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(beaconPayload));
  }

  state.activeBeacons.set(bid, beaconPayload);
  updateBeaconBanner();
  renderBeaconListModal();
}

export async function sendMessage(rawText, explicitCat = null) {
  if (!rawText || !state.cryptoKey) return;
  const triage = explicitCat
    ? { cat: explicitCat, prio: 3, vitals: {} }
    : triageText(rawText);

  const mid = 'm_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const ts = Date.now();
  const envelope = encryptEnvelope(rawText, state.cryptoKey);

  const pkB64 = state.identity ? bytesToBase64(state.identity.pubKey) : '';
  const sigB64 = signMessageEnvelope(state.currentRoom, mid, ts, envelope.n, envelope.c);

  const payload = {
    t: 'msg',
    id: mid,
    room: state.currentRoom,
    envelope,
    sig: sigB64,
    pk: pkB64,
    cat: triage.cat,
    prio: triage.prio,
    ts
  };

  if (state.activeDirectPeer) {
    payload.target_peer = state.activeDirectPeer.peer_id;
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
    id: mid,
    from: state.currentNickname,
    peer_id: state.myPeerId,
    room: state.currentRoom,
    target_peer: payload.target_peer,
    is_dm: !!payload.target_peer,
    text: rawText,
    cat: triage.cat,
    prio: triage.prio,
    ts,
    status: initialStatus,
    verified: true,
    expected_peers: state.currentPeersList.filter(p => p.peer_id !== state.myPeerId).length,
    route: p2pCount > 0 ? (state.activeDirectPeer ? 'P2P Direct' : `P2P Mesh (${p2pCount})`) : (sentViaRelay ? 'Relay' : 'Offline Outbox')
  };
  state.messagesHistory.push(localMessage);
  appendMessageToUI(localMessage);
  updateSOSBanner();
}
