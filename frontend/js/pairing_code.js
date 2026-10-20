/**
 * Pairing code derivation for serverless QR bootstrap.
 * code = first 6 digits (mod 10^6, zero-padded) of sha256(canon(offerSDP) + canon(answerSDP))
 * canon = trim + normalize line endings to \n
 */
import { sha256 } from '../vendor/noble-crypto.js';

export function canon(sdp) {
  if (!sdp || typeof sdp !== 'string') return '';
  // Trim + normalize line endings (\r\n or \r -> \n)
  return sdp.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function computePairingCode(offerSdp, answerSdp) {
  const canonOffer = canon(offerSdp);
  const canonAnswer = canon(answerSdp);
  const combined = new TextEncoder().encode(canonOffer + canonAnswer);
  const hash = sha256(combined);

  // Take first 4 bytes as Big-Endian uint32 % 10^6, zero-padded to 6 digits
  const view = new DataView(hash.buffer, hash.byteOffset, hash.byteLength);
  const num = view.getUint32(0, false) % 1000000;
  return num.toString().padStart(6, '0');
}
