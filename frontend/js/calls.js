/**
 * WebRTC Voice & Video Calling Engine (1-on-1 P2P Calls).
 */
import { state, $ } from './state.js';
import { RTC_CONFIG } from './mesh.js';
import { appendSystemMessage } from './ui.js';

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

export async function startCall(peer, isVideo = false) {
  if (!peer) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return alert('Voice/video calling requires camera/microphone access in your browser.');
  }

  state.currentCallPeer = peer;
  try {
    state.localMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideo ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
  } catch (err) {
    return alert(`Could not access media devices: ${err.message}`);
  }

  $('call-peer-title').textContent = `${isVideo ? '📹 Video' : '📞 Voice'} Call with ${peer.name}`;
  $('call-status-label').textContent = 'Calling...';
  $('call-audio-indicator').style.display = isVideo ? 'none' : 'flex';
  $('local-video').style.display = isVideo ? 'block' : 'none';
  $('remote-video').style.display = isVideo ? 'block' : 'none';
  $('local-video').srcObject = state.localMediaStream;
  $('call-modal').style.display = 'flex';

  state.activeCallPeerConnection = new RTCPeerConnection(RTC_CONFIG);
  state.localMediaStream.getTracks().forEach(track => {
    state.activeCallPeerConnection.addTrack(track, state.localMediaStream);
  });

  state.activeCallPeerConnection.ontrack = event => {
    $('call-status-label').textContent = 'Connected';
    const remoteStream = event.streams[0];
    $('remote-video').srcObject = remoteStream;
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
        isVideo,
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
  $('incoming-call-type').textContent = `Incoming ${data.isVideo ? 'video' : 'voice'} call...`;
  $('incoming-call-toast').style.display = 'flex';
}

export async function acceptIncomingCall() {
  $('incoming-call-toast').style.display = 'none';
  if (!state.pendingIncomingCall) return;

  const { peer_id, name, data } = state.pendingIncomingCall;
  state.currentCallPeer = { peer_id, name };
  const isVideo = !!data.isVideo;

  try {
    state.localMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideo ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
  } catch (err) {
    alert(`Could not access microphone/camera: ${err.message}`);
    declineIncomingCall();
    return;
  }

  $('call-peer-title').textContent = `${isVideo ? '📹 Video' : '📞 Voice'} Call with ${name}`;
  $('call-status-label').textContent = 'Connecting...';
  $('call-audio-indicator').style.display = isVideo ? 'none' : 'flex';
  $('local-video').style.display = isVideo ? 'block' : 'none';
  $('remote-video').style.display = isVideo ? 'block' : 'none';
  $('local-video').srcObject = state.localMediaStream;
  $('call-modal').style.display = 'flex';

  state.activeCallPeerConnection = new RTCPeerConnection(RTC_CONFIG);
  state.localMediaStream.getTracks().forEach(track => {
    state.activeCallPeerConnection.addTrack(track, state.localMediaStream);
  });

  state.activeCallPeerConnection.ontrack = event => {
    $('call-status-label').textContent = 'Connected';
    $('remote-video').srcObject = event.streams[0];
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
  $('local-video').srcObject = null;
  $('remote-video').srcObject = null;
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

export function toggleCam() {
  if (!state.localMediaStream) return;
  const videoTrack = state.localMediaStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    const btn = $('toggle-cam-btn');
    if (btn) btn.classList.toggle('off', !videoTrack.enabled);
  }
}
