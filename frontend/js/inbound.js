/**
 * Central inbound message pipeline for all transport channels.
 */

export function createInbound(deps) {
  const { state, verifySignature, decryptEnvelope, render, now = () => Date.now() } = deps;
  const done = new Set();
  const inflight = new Map();

  function mapRoute(source, hops) {
    if (source === 'Relay') return 'Relay';
    if (source === 'BLE') return 'BLE';
    if (source === 'Serverless') return 'Serverless';
    if (source === 'P2P Direct') {
      const hopCount = Number(hops) || 0;
      if (hopCount > 0) {
        return `Mesh ${hopCount + 1}-Hop`;
      }
      return 'P2P Direct';
    }
    return source || 'Relay';
  }

  async function handleInboundMessage(msg, source) {
    // 1 drop if msg.id missing or sender in state.blockedPeerIds
    if (!msg || !msg.id) return false;
    if (msg.peer_id && state.blockedPeerIds && state.blockedPeerIds.has(msg.peer_id)) {
      return false;
    }
    if (msg.peer_id === state.myPeerId && state.messagesHistory && state.messagesHistory.some(m => m.id === msg.id)) {
      return false;
    }

    // 2 drop DM not addressed to me / room mismatch
    const isTargetedToMe = msg.target_peer === state.myPeerId;
    const isBroadcast = !msg.target_peer;

    if (msg.target_peer && !isTargetedToMe && msg.peer_id !== state.myPeerId) {
      return false;
    }
    if (isBroadcast && msg.room && msg.room !== state.currentRoom && !msg.sos) {
      return false;
    }

    // 3 in-flight map: if in done -> return false; if in inflight -> await it, then return false
    if (done.has(msg.id)) {
      return false;
    }
    if (inflight.has(msg.id)) {
      await inflight.get(msg.id);
      return false;
    }

    let resolvePromise;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    inflight.set(msg.id, promise);

    try {
      // 4 verifySignature; if false -> drop, return false (do NOT add id to done)
      if (verifySignature) {
        const isVerified = await verifySignature(msg);
        if (!isVerified) {
          return false;
        }
        msg.verified = true;
      }

      // 5 decryptEnvelope; if null -> msg.unreadable = true (set on msg itself)
      if (decryptEnvelope) {
        const decrypted = await decryptEnvelope(msg);
        if (decrypted !== null && decrypted !== undefined) {
          msg.text = decrypted;
        } else {
          msg.text = null;
          msg.unreadable = true;
        }
      }

      // 6 msg.route = source mapped to 'Relay'|'P2P Direct'|'BLE'|'Serverless' (mesh hops>0 -> Mesh ${hops+1}-Hop)
      msg.route = mapRoute(source, msg.hops);

      // 7 push to state.messagesHistory, call render(msg), add id to done, return true
      if (state.messagesHistory) {
        state.messagesHistory.push(msg);
      }
      if (render) {
        render(msg);
      }
      done.add(msg.id);
      return true;
    } finally {
      inflight.delete(msg.id);
      resolvePromise();
    }
  }

  return handleInboundMessage;
}
