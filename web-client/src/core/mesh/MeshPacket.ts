// MeshPacket.ts
// Binary packet format for multi-hop offline mesh routing
//
// Wire format (all big-endian):
// [1]  version     uint8   = 0x01
// [1]  flags       uint8   bit 0 = encrypted, bit 1 = signed
// [1]  ttl         uint8   initial=7, decremented per hop
// [1]  hop_count   uint8   incremented per hop
// [4]  seq         uint32  monotonic sender sequence number
// [32] packet_id   bytes   SHA-256(srcFp + seq + timestamp) — dedup key
// [32] src_fp      bytes   sender fingerprint (public key hash)
// [32] dst_fp      bytes   recipient fingerprint (or FF..FF for broadcast)
// [4]  payload_len uint32
// [N]  payload     bytes   AES-256-GCM ciphertext (IV prepended)
// [64] signature   bytes   Ed25519 signature over all preceding bytes

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const BROADCAST_FP = new Uint8Array(32).fill(0xff);
export const MESH_VERSION = 0x01;
export const DEFAULT_TTL = 7;

export interface MeshPacket {
  version: number;
  flags: number;        // bit 0: encrypted, bit 1: signed
  ttl: number;
  hopCount: number;
  seq: number;
  packetId: string;     // hex — used as dedup key
  srcFp: Uint8Array;    // 32 bytes
  dstFp: Uint8Array;    // 32 bytes
  payload: Uint8Array;  // encrypted ciphertext
  signature?: Uint8Array; // 64 bytes Ed25519
}

let _seqCounter = 0;

/** Build and serialize a MeshPacket */
export function buildPacket(
  srcFp: Uint8Array,
  dstFp: Uint8Array,
  payload: Uint8Array,
  opts: { encrypted?: boolean; ttl?: number } = {}
): MeshPacket {
  const seq = ++_seqCounter;
  const ts = Date.now();

  // Dedup ID: hash of sender + seq + timestamp
  const idInput = new Uint8Array(32 + 4 + 8);
  idInput.set(srcFp, 0);
  new DataView(idInput.buffer).setUint32(32, seq, false);
  new DataView(idInput.buffer).setBigUint64(36, BigInt(ts), false);
  const packetId = bytesToHex(sha256(idInput));

  const flags = (opts.encrypted ? 0x01 : 0x00) | 0x02; // always mark for signing
  const ttl = opts.ttl ?? DEFAULT_TTL;

  return { version: MESH_VERSION, flags, ttl, hopCount: 0, seq, packetId, srcFp, dstFp, payload };
}

/** Serialize a MeshPacket to a Uint8Array for transmission */
export function serialize(pkt: MeshPacket): Uint8Array {
  const SIG_LEN = pkt.signature ? 64 : 0;
  const buf = new Uint8Array(1 + 1 + 1 + 1 + 4 + 32 + 32 + 32 + 4 + pkt.payload.length + SIG_LEN);
  const view = new DataView(buf.buffer);
  let off = 0;

  buf[off++] = pkt.version;
  buf[off++] = pkt.flags;
  buf[off++] = pkt.ttl;
  buf[off++] = pkt.hopCount;
  view.setUint32(off, pkt.seq, false); off += 4;

  // packetId as raw bytes (decode hex → bytes)
  const idBytes = hexToBytes(pkt.packetId);
  buf.set(idBytes, off); off += 32;
  buf.set(pkt.srcFp, off); off += 32;
  buf.set(pkt.dstFp, off); off += 32;

  view.setUint32(off, pkt.payload.length, false); off += 4;
  buf.set(pkt.payload, off); off += pkt.payload.length;

  if (pkt.signature) { buf.set(pkt.signature, off); }
  return buf;
}

/** Deserialize a Uint8Array into a MeshPacket */
export function deserialize(data: Uint8Array): MeshPacket {
  const view = new DataView(data.buffer, data.byteOffset);
  let off = 0;

  const version = data[off++];
  const flags = data[off++];
  const ttl = data[off++];
  const hopCount = data[off++];
  const seq = view.getUint32(off, false); off += 4;

  const packetId = bytesToHex(data.slice(off, off + 32)); off += 32;
  const srcFp = data.slice(off, off + 32); off += 32;
  const dstFp = data.slice(off, off + 32); off += 32;

  const payloadLen = view.getUint32(off, false); off += 4;
  const payload = data.slice(off, off + payloadLen); off += payloadLen;

  const signature = off < data.length ? data.slice(off, off + 64) : undefined;

  return { version, flags, ttl, hopCount, seq, packetId, srcFp, dstFp, payload, signature };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Returns true if packet has exceeded its hop limit */
export function isExpired(pkt: MeshPacket): boolean {
  return pkt.ttl <= 0;
}

/** Return a forwarded copy with decremented TTL and incremented hop count */
export function forward(pkt: MeshPacket): MeshPacket {
  return { ...pkt, ttl: pkt.ttl - 1, hopCount: pkt.hopCount + 1 };
}
