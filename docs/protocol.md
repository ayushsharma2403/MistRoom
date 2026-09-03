# MistRoom — Binary Mesh Protocol Specification

> Version: 1.0-draft

## 1. Protocol Overview

MistRoom uses a compact binary protocol for all mesh communication. The protocol is transport-agnostic — the same envelope format is used over BLE, Wi-Fi Aware, WebSocket, and Nostr (base64-encoded for Nostr).

All payloads are encrypted before being placed in envelopes. Intermediate forwarding peers process only the routing header.

## 2. Packet Types

| Code | Type | Direction | Purpose |
|------|------|-----------|---------|
| `0x01` | `PEER_ANNOUNCE` | Broadcast | Announce presence and capabilities |
| `0x02` | `PEER_GONE` | Broadcast | Announce departure |
| `0x10` | `HANDSHAKE_INIT` | Directed | Begin key agreement |
| `0x11` | `HANDSHAKE_RESP` | Directed | Complete key agreement |
| `0x20` | `MESSAGE` | Directed | Encrypted text/system message |
| `0x21` | `MESSAGE_ACK` | Directed | Delivery acknowledgement |
| `0x22` | `READ_RECEIPT` | Directed | Read receipt |
| `0x30` | `TRANSFER_OFFER` | Directed | Propose file/voice transfer |
| `0x31` | `TRANSFER_ACCEPT` | Directed | Accept transfer |
| `0x32` | `TRANSFER_REJECT` | Directed | Reject transfer |
| `0x33` | `TRANSFER_CHUNK` | Directed | Encrypted chunk payload |
| `0x34` | `TRANSFER_CHUNK_ACK` | Directed | Chunk received OK |
| `0x35` | `TRANSFER_CHUNK_NACK` | Directed | Chunk rejected / retry |
| `0x36` | `TRANSFER_RESUME` | Directed | Request missing chunks |
| `0x37` | `TRANSFER_COMPLETE` | Directed | All chunks received, verified |
| `0x38` | `TRANSFER_CANCEL` | Directed | Cancel in-progress transfer |
| `0x40` | `CHANNEL_MESSAGE` | Group | Encrypted channel/group message |
| `0x41` | `CHANNEL_KEY_DIST` | Group | Sender key distribution |
| `0x50` | `ROUTE_REQUEST` | Broadcast | Query route to destination |
| `0x51` | `ROUTE_RESPONSE` | Directed | Route information |
| `0x60` | `SYNC_REQUEST` | Directed | Request missed messages |
| `0x61` | `SYNC_RESPONSE` | Directed | Deliver missed messages |

## 3. Envelope Format

All packets share a common binary envelope:

```
Offset  Size     Field                    Description
──────  ────     ─────                    ───────────
0       1        protocol_version         Protocol version (currently 0x01)
1       1        packet_type              See packet type table
2       2        flags                    Bitfield (see below)
4       16       packet_id                UUID v4, unique per packet
20      16       sender_fingerprint       SHA-256(sender_pubkey)[0:16]
36      16       recipient_fingerprint    Target device (or 0xFF..FF for broadcast)
52      16       routing_id              Conversation/channel blinded ID
68      1        message_type             Content type enum (see below)
69      8        created_at               Unix timestamp milliseconds (big-endian)
77      8        expires_at               Unix timestamp milliseconds (big-endian)
85      1        hop_count                Current hop count
86      1        max_hops                 Maximum allowed hops (TTL)
87      4        payload_length           Ciphertext length in bytes (big-endian)
91      12       nonce                    Encryption nonce
103     var      ciphertext               Encrypted payload (payload_length bytes)
103+N   16       auth_tag                 AES-GCM / Poly1305 authentication tag
119+N   64       signature                Ed25519 signature over bytes [0..119+N)
```

**Total header size**: 103 bytes (fixed) + variable payload + 80 bytes (tag + signature)

### 3.1 Flags Bitfield

```
Bit 0:  is_forwarded          - Set by relaying peers
Bit 1:  requires_ack          - Sender wants delivery ACK
Bit 2:  is_chunked            - Payload is part of chunked transfer
Bit 3:  is_compressed         - Payload is compressed before encryption
Bit 4:  is_ephemeral          - Do not persist (burn after read)
Bit 5:  is_group              - Group/channel message
Bit 6:  has_attachment_meta   - Payload contains attachment metadata
Bit 7:  priority_high         - High priority (skip low-priority queue)
Bits 8-15: reserved
```

### 3.2 Message Type Enum

| Code | Type |
|------|------|
| `0x00` | `TEXT` |
| `0x01` | `VOICE_NOTE` |
| `0x02` | `IMAGE` |
| `0x03` | `VIDEO` |
| `0x04` | `AUDIO` |
| `0x05` | `DOCUMENT` |
| `0x06` | `FILE` |
| `0x07` | `SYSTEM` |
| `0x08` | `CHANNEL_MESSAGE` |
| `0x09` | `KEY_EXCHANGE` |
| `0x0A` | `CONTACT_CARD` |

## 4. Handshake Protocol

Session establishment uses a simplified three-way handshake inspired by Noise XX:

```
Alice                                    Bob
  │                                       │
  │── HANDSHAKE_INIT ────────────────────►│
  │   {                                   │
  │     alice_ephemeral_public,           │
  │     alice_static_public (encrypted),  │
  │     proof_of_identity                 │
  │   }                                   │
  │                                       │
  │◄── HANDSHAKE_RESP ───────────────────│
  │   {                                   │
  │     bob_ephemeral_public,             │
  │     bob_static_public (encrypted),    │
  │     proof_of_identity,                │
  │     encrypted_payload (optional)      │
  │   }                                   │
  │                                       │
  │   Both derive:                        │
  │   session_key = HKDF(                 │
  │     ECDH(a_eph, b_static) ||          │
  │     ECDH(a_static, b_eph) ||          │
  │     ECDH(a_eph, b_eph)               │
  │   )                                   │
  │                                       │
  │── Encrypted messages ────────────────►│
  │◄── Encrypted messages ────────────────│
```

## 5. Chunk Transfer Sub-Protocol

### 5.1 Transfer Offer

```
Plaintext fields (inside encrypted envelope payload):
  transfer_id:     16 bytes UUID
  file_type:       1 byte (message_type enum)
  total_size:      8 bytes (original encrypted size)
  chunk_size:      4 bytes
  chunk_count:     4 bytes
  file_hash:       32 bytes (SHA-256 of encrypted content)
  metadata_blob:   variable (encrypted filename, mime, etc.)
```

### 5.2 Transfer Chunk

```
Plaintext fields (inside encrypted envelope payload):
  transfer_id:     16 bytes UUID
  chunk_index:     4 bytes (0-indexed)
  chunk_hash:      32 bytes (SHA-256 of this chunk)
  chunk_data:      variable (encrypted chunk content)
```

### 5.3 Transfer Resume

```
Plaintext fields:
  transfer_id:     16 bytes UUID
  received_bitmap: variable (bitfield of received chunk indices)
  last_received:   4 bytes (highest contiguous chunk index)
```

### 5.4 Transfer Complete

```
Plaintext fields:
  transfer_id:     16 bytes UUID
  final_hash:      32 bytes (SHA-256 of reassembled encrypted content)
  status:          1 byte (OK / HASH_MISMATCH / INCOMPLETE)
```

## 6. Peer Announcement

```
Plaintext fields (signed but not encrypted):
  device_fingerprint:  16 bytes
  display_name:        variable (max 64 bytes UTF-8)
  protocol_version:    1 byte
  capabilities:        2 bytes bitfield
  supported_transports: 1 byte bitfield
  battery_level:       1 byte (0-100)
  relay_willingness:   1 byte (0=none, 1=text, 2=text+voice, 3=all)
  timestamp:           8 bytes
  signature:           64 bytes
```

### Capabilities Bitfield

```
Bit 0: supports_ble
Bit 1: supports_wifi_aware
Bit 2: supports_websocket
Bit 3: supports_nostr
Bit 4: supports_tor
Bit 5: supports_file_transfer
Bit 6: supports_voice_notes
Bit 7: supports_groups
```

## 7. Deduplication

Each device maintains a bounded LRU cache:

```
Map<PacketID, ExpirationTimestamp>
```

- **Max entries**: 10,000 per device
- **Default TTL**: 1 hour
- **Eviction**: LRU when capacity exceeded
- **On receive**: if packet_id exists → discard; else insert and process

## 8. Routing Rules

1. **Direct delivery**: If recipient is a directly connected peer, deliver immediately
2. **Known route**: If routing table has a path to recipient, forward via next hop
3. **Broadcast forward**: If no known route and TTL > 0, forward to all connected peers except sender
4. **Store**: If no connected peers can reach recipient, persist in store-and-forward queue
5. **Expire**: Discard if `expires_at < now` or `hop_count >= max_hops`
6. **Rate limit**: Per-peer, per-minute forwarding limits to prevent flooding

## 9. Delivery Acknowledgement

```
ACK payload:
  original_packet_id:   16 bytes
  ack_timestamp:        8 bytes
  ack_type:             1 byte (DELIVERED / READ / FAILED)
```

ACKs follow the same envelope format and are routed back to the original sender. ACKs do NOT require ACKs (prevents ACK storms).

## 10. BLE MTU and Fragmentation

BLE has limited MTU (typically 20-517 bytes after negotiation). Large mesh packets are fragmented at the BLE layer:

```
BLE Fragment Header:
  fragment_sequence:  2 bytes
  total_fragments:    2 bytes
  fragment_offset:    4 bytes
  mesh_packet_id:     16 bytes (first fragment only, for reassembly)
  fragment_data:      variable (up to MTU - header_size)
```

Fragments are reassembled into complete mesh packets before protocol processing.

## 11. Protocol Versioning

- `protocol_version` field in every packet
- Unknown packet types are silently discarded (not forwarded)
- Version mismatch: respond with `PEER_ANNOUNCE` containing supported version
- Capability negotiation via `HANDSHAKE_INIT`/`HANDSHAKE_RESP`

## 12. Security Considerations

- All payload content is encrypted before envelope construction
- Envelope signature covers the entire packet except the signature itself
- Forwarding peers validate signature but cannot read payload
- Replay protection via packet_id dedup + expiration timestamps
- Hop count prevents infinite routing loops
- Per-peer rate limits prevent flooding
- Invalid signatures cause immediate packet discard (no error response to attacker)
