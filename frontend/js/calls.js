/**
 * WebRTC Voice Calling Engine (1-on-1 P2P Voice Calls).
 */
import { state, $ } from './state.js';
import { RTC_CONFIG } from './mesh.js';

export function startCallTimer() {
  stopCallTimer();
  state.callSeconds = 0;
  $('call-timer').textContent = '00:00';
  state.callTimerInterval = setInterval(() => {
    state.callSeconds++;
    const mins = String(Math.floor(state.callSeconds / 60)).padStart(2, '0');
    const secs = String(state.callSeconds % 60).padStart(2, '0');
    $('call-timer').textContent = `${mins}:${secs}`;
  }, 1000);
}

export function stopCallTimer() {
  if (state.callTimerInterval) {
    clearInterval(state.callTimerInterval);
    state.callTimerInterval = null;
  }
}

export async function startCall(peer) {
  if (!peer) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return alert('Voice calling requires microphone access in your browser.');
  }

  state.currentCallPeer = peer;
  try {
    state.localMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    return alert(`Could not access microphone: ${err.message}`);
  }

  $('call-peer-title').textContent = `📞 Voice Call with ${peer.name}`;
  $('call-status-label').textContent = 'Calling...';
  $('call-modal').style.display = 'flex';

  state.activeCallPeerConnection = new RTCPeerConnection(RTC_CONFIG);
  state.localMediaStream.getTracks().forEach(track => {
    state.activeCallPeerConnection.addTrack(track, state.localMediaStream);
  });

  state.activeCallPeerConnection.ontrack = event => {
    $('call-status-label').textContent = 'Connected';
    const remoteAudio = $('remote-audio');
    if (remoteAudio) {
      remoteAudio.srcObject = event.streams[0];
    }
    startCallTimer();
  };

  state.activeCallPeerConnection.onicecandidate = event => {
    if (event.candidate && state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({
        t: 'call_ice',
        target: peer.peer_id,
        data: event.candidate
      }));
    }
  };

  const offer = await state.activeCallPeerConnection.createOffer();
  await state.activeCallPeerConnection.setLocalDescription(offer);

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      t: 'call_invite',
      target: peer.peer_id,
      data: {
        offer,
        callerName: state.currentNickname
      }
    }));
  }
}

export async function handleIncomingCallInvite(senderPeerId, senderName, data) {
  state.pendingIncomingCall = {
    peer_id: senderPeerId,
    name: senderName,
    data
  };

  $('incoming-caller-name').textContent = senderName;
  $('incoming-call-type').textContent = 'Incoming voice call...';
  $('incoming-call-toast').style.display = 'flex';
}

export async function acceptIncomingCall() {
  $('incoming-call-toast').style.display = 'none';
  if (!state.pendingIncomingCall) return;

  const { peer_id, name, data } = state.pendingIncomingCall;
  state.currentCallPeer = { peer_id, name };

  try {
    state.localMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert(`Could not access microphone: ${err.message}`);
    declineIncomingCall();
    return;
  }

  $('call-peer-title').textContent = `📞 Voice Call with ${name}`;
  $('call-status-label').textContent = 'Connecting...';
  $('call-modal').style.display = 'flex';

  state.activeCallPeerConnection = new RTCPeerConnection(RTC_CONFIG);
  state.localMediaStream.getTracks().forEach(track => {
    state.activeCallPeerConnection.addTrack(track, state.localMediaStream);
  });

  state.activeCallPeerConnection.ontrack = event => {
    $('call-status-label').textContent = 'Connected';
    const remoteAudio = $('remote-audio');
    if (remoteAudio) {
      remoteAudio.srcObject = event.streams[0];
    }
    startCallTimer();
  };

  state.activeCallPeerConnection.onicecandidate = event => {
    if (event.candidate && state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({
        t: 'call_ice',
        target: peer_id,
        data: event.candidate
      }));
    }
  };

  await state.activeCallPeerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await state.activeCallPeerConnection.createAnswer();
  await state.activeCallPeerConnection.setLocalDescription(answer);

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      t: 'call_accept',
      target: peer_id,
      data: answer
    }));
  }
}

export function declineIncomingCall() {
  $('incoming-call-toast').style.display = 'none';
  if (state.pendingIncomingCall && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      t: 'call_decline',
      target: state.pendingIncomingCall.peer_id
    }));
  }
  state.pendingIncomingCall = null;
}

export function endCall(notifyRemote = true) {
  if (notifyRemote && state.currentCallPeer && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      t: 'call_hangup',
      target: state.currentCallPeer.peer_id
    }));
  }

  if (state.localMediaStream) {
    state.localMediaStream.getTracks().forEach(track => track.stop());
    state.localMediaStream = null;
  }

  if (state.activeCallPeerConnection) {
    try { state.activeCallPeerConnection.close(); } catch (e) {}
    state.activeCallPeerConnection = null;
  }

  stopCallTimer();
  $('call-modal').style.display = 'none';
  const remoteAudio = $('remote-audio');
  if (remoteAudio) remoteAudio.srcObject = null;
  state.currentCallPeer = null;
  state.pendingIncomingCall = null;
}

export function toggleMic() {
  if (!state.localMediaStream) return;
  const audioTrack = state.localMediaStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    const btn = $('toggle-mic-btn');
    if (btn) btn.classList.toggle('off', !audioTrack.enabled);
  }
}
