/**
 * Serverless P2P WebRTC Bootstrapper via QR codes and text exchange.
 * Supports manual copy-paste text and camera QR scanning (BarcodeDetector or jsQR fallback).
 * Performs SDP compression, payload chunking, Ed25519 identity verification,
 * and 6-digit SAS pairing code verification derived from sha256(offerSDP + answerSDP).
 */
import { state, $ } from './state.js';
import {
  bytesToBase64, base64ToBytes, derivePeerIdFromPk,
  signGenericSig, verifyGenericSig, sha256, bytesToHex, deriveRoomKey
} from './crypto.js';
import { attachDataChannelEvents } from './mesh.js';
import { appendSystemMessage, updateSOSBanner } from './ui.js';

// Base64url utilities
export function toBase64Url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return atob(b64);
}

// Compress SDP by stripping unneeded lines
export function minifySdp(sdp) {
  return sdp
    .split('\r\n')
    .filter(line => !line.startsWith('a=extmap:') && !line.startsWith('a=rtcp-fb:'))
    .join('\r\n');
}

// Compute 6-digit confirmation code from offer + answer SDP
export function computePairingCode(offerSdp, answerSdp) {
  const combined = new TextEncoder().encode(offerSdp + answerSdp);
  const hash = sha256(combined);
  // Take last 4 bytes as uint32 % 1000000
  const view = new DataView(hash.buffer, hash.byteOffset, hash.byteLength);
  const num = view.getUint32(0, false) % 1000000;
  return num.toString().padStart(6, '0');
}

// Chunking for QR frames: payload split into k of n frames if > 1000 chars
export function splitPayloadIntoFrames(payloadStr, maxChunk = 800) {
  if (payloadStr.length <= maxChunk) {
    return [payloadStr];
  }
  const chunks = [];
  for (let i = 0; i < payloadStr.length; i += maxChunk) {
    chunks.push(payloadStr.slice(i, i + maxChunk));
  }
  const total = chunks.length;
  return chunks.map((chunk, idx) => `MIST:${idx + 1}:${total}:${chunk}`);
}

export class FrameReassembler {
  constructor() {
    this.frames = new Map();
    this.total = 0;
  }

  feed(text) {
    if (!text.startsWith('MIST:')) {
      return text; // single unchunked frame
    }
    const parts = text.split(':');
    if (parts.length < 4) return null;
    const k = parseInt(parts[1], 10);
    const n = parseInt(parts[2], 10);
    const data = parts.slice(3).join(':');

    this.total = n;
    this.frames.set(k, data);

    if (this.frames.size === this.total) {
      let combined = '';
      for (let i = 1; i <= this.total; i++) {
        combined += this.frames.get(i) || '';
      }
      return combined;
    }
    return null;
  }
}

// Render QR code to an HTML container using vendored qrcode library
export function renderQrCodeTo(containerEl, text) {
  containerEl.textContent = '';
  if (typeof window.qrcode === 'function') {
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      const imgTag = qr.createImgTag(4, 8);
      const parser = new DOMParser();
      const doc = parser.parseFromString(imgTag, 'text/html');
      const img = doc.querySelector('img');
      if (img) {
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
        img.style.borderRadius = '8px';
        containerEl.appendChild(img);
        return;
      }
    } catch (err) {
      console.warn('Local QR render error:', err);
    }
  }
  // Fallback to text
  const pre = document.createElement('pre');
  pre.style.fontSize = '10px';
  pre.style.wordBreak = 'break-all';
  pre.textContent = text;
  containerEl.appendChild(pre);
}

// Active bootstrap session state
let activeBootstrap = null;

export function getActiveBootstrap() {
  return activeBootstrap;
}

export function resetActiveBootstrap() {
  if (activeBootstrap && activeBootstrap.pc) {
    try { activeBootstrap.pc.close(); } catch (e) {}
  }
  activeBootstrap = null;
}

/**
 * Step 1: Device A starts session (Initiator: creates offer)
 */
export async function startServerlessInitiator() {
  resetActiveBootstrap();

  const pc = new RTCPeerConnection({ iceServers: [] });
  const dc = pc.createDataChannel('mistmesh');

  activeBootstrap = {
    role: 'initiator',
    pc,
    dc,
    remotePeerId: null,
    remotePk: null,
    offerSdp: null,
    answerSdp: null,
    pairingCode: null,
    trusted: false
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering to complete (host candidates only, max 3s)
  await new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const checkState = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', checkState);
    setTimeout(resolve, 3000);
  });

  const rawSdp = pc.localDescription.sdp;
  const sdp = minifySdp(rawSdp);
  activeBootstrap.offerSdp = sdp;

  const pkB64 = state.identity ? bytesToBase64(state.identity.pubKey) : '';
  const myPeerId = state.myPeerId;
  const sigB64 = signGenericSig(`OFFER:${sdp}`);

  const offerPayload = {
    role: 'offer',
    sdp,
    peer_id: myPeerId,
    pk: pkB64,
    sig: sigB64
  };

  const jsonStr = JSON.stringify(offerPayload);
  const encodedStr = toBase64Url(jsonStr);

  return { encodedStr, offerPayload };
}

/**
 * Step 2: Device B processes Offer and generates Answer
 */
export async function processOfferAndCreateAnswer(offerText) {
  resetActiveBootstrap();

  let offerObj;
  try {
    const jsonStr = fromBase64Url(offerText.trim());
    offerObj = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error('Invalid Offer payload format');
  }

  if (offerObj.role !== 'offer' || !offerObj.sdp || !offerObj.pk || !offerObj.sig) {
    throw new Error('Offer missing required fields');
  }

  // Verify identity signature
  const valid = verifyGenericSig(`OFFER:${offerObj.sdp}`, offerObj.sig, offerObj.pk);
  if (!valid) {
    throw new Error('Offer signature verification failed');
  }

  const remotePeerId = derivePeerIdFromPk(base64ToBytes(offerObj.pk));
  if (offerObj.peer_id && offerObj.peer_id !== remotePeerId) {
    throw new Error('Offer Peer ID mismatch');
  }

  const pc = new RTCPeerConnection({ iceServers: [] });
  activeBootstrap = {
    role: 'responder',
    pc,
    dc: null,
    remotePeerId,
    remotePk: offerObj.pk,
    offerSdp: offerObj.sdp,
    answerSdp: null,
    pairingCode: null,
    trusted: false
  };

  pc.ondatachannel = event => {
    activeBootstrap.dc = event.channel;
    setupBootstrapDataChannel(event.channel, remotePeerId);
  };

  await pc.setRemoteDescription({ type: 'offer', sdp: offerObj.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  // Wait for ICE gathering
  await new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const checkState = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', checkState);
    setTimeout(resolve, 3000);
  });

  const rawAnswerSdp = pc.localDescription.sdp;
  const answerSdp = minifySdp(rawAnswerSdp);
  activeBootstrap.answerSdp = answerSdp;

  const pairingCode = computePairingCode(offerObj.sdp, answerSdp);
  activeBootstrap.pairingCode = pairingCode;

  const pkB64 = state.identity ? bytesToBase64(state.identity.pubKey) : '';
  const myPeerId = state.myPeerId;
  const sigB64 = signGenericSig(`ANSWER:${answerSdp}`);

  const answerPayload = {
    role: 'answer',
    sdp: answerSdp,
    peer_id: myPeerId,
    pk: pkB64,
    sig: sigB64
  };

  const jsonStr = JSON.stringify(answerPayload);
  const encodedStr = toBase64Url(jsonStr);

  return { encodedStr, pairingCode, remotePeerId };
}

/**
 * Step 3: Device A receives Answer
 */
export async function processAnswerOnInitiator(answerText) {
  if (!activeBootstrap || activeBootstrap.role !== 'initiator') {
    throw new Error('No active initiator session found');
  }

  let answerObj;
  try {
    const jsonStr = fromBase64Url(answerText.trim());
    answerObj = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error('Invalid Answer payload format');
  }

  if (answerObj.role !== 'answer' || !answerObj.sdp || !answerObj.pk || !answerObj.sig) {
    throw new Error('Answer missing required fields');
  }

  // Verify identity signature
  const valid = verifyGenericSig(`ANSWER:${answerObj.sdp}`, answerObj.sig, answerObj.pk);
  if (!valid) {
    throw new Error('Answer signature verification failed');
  }

  const remotePeerId = derivePeerIdFromPk(base64ToBytes(answerObj.pk));
  if (answerObj.peer_id && answerObj.peer_id !== remotePeerId) {
    throw new Error('Answer Peer ID mismatch');
  }

  activeBootstrap.remotePeerId = remotePeerId;
  activeBootstrap.remotePk = answerObj.pk;
  activeBootstrap.answerSdp = answerObj.sdp;

  const pairingCode = computePairingCode(activeBootstrap.offerSdp, answerObj.sdp);
  activeBootstrap.pairingCode = pairingCode;

  await activeBootstrap.pc.setRemoteDescription({ type: 'answer', sdp: answerObj.sdp });
  setupBootstrapDataChannel(activeBootstrap.dc, remotePeerId);

  return { pairingCode, remotePeerId };
}

/**
 * Confirm pairing codes match
 */
export function confirmPairing() {
  if (!activeBootstrap) return false;
  activeBootstrap.trusted = true;

  // Add to state.meshPeers as an active peer
  state.meshPeers.set(activeBootstrap.remotePeerId, {
    pc: activeBootstrap.pc,
    dc: activeBootstrap.dc
  });

  appendSystemMessage(`P2P mesh channel trusted and connected with peer ${activeBootstrap.remotePeerId}`);
  return true;
}

function setupBootstrapDataChannel(dc, targetPeerId) {
  if (!dc) return;
  attachDataChannelEvents(dc, targetPeerId);
}
