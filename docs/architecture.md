# MistRoom — Architecture

> Decentralized Offline Mesh Messenger with Text, Voice & File Transfer

## 1. System Overview

MistRoom is a hybrid messaging platform composed of three cooperating layers:

| Layer | Technology | Role |
|-------|-----------|------|
| **Android Client** | Kotlin, Jetpack Compose, Room | UI, local crypto, mesh transport, offline queue |
| **Python Backend** | FastAPI, SQLAlchemy 2.x, Alembic | Optional Internet relay, key directory, metadata |
| **MySQL Database** | MySQL 8+ | Backend persistence for metadata only |

The Android client is self-sufficient for local mesh delivery. The backend enhances Internet-connected functionality but is never required for offline operation.

```
┌──────────────────────────────────────────────────────┐
│                   ANDROID CLIENT                      │
│                                                      │
│  ┌──────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │  UI  │→ │  Domain   │→ │  Crypto  │→ │Transport│ │
│  │Layer │  │  Layer    │  │  Layer   │  │  Layer  │ │
│  └──────┘  └──────────┘  └──────────┘  └────┬────┘ │
│                                              │      │
│         ┌────────────┬───────────┬───────────┤      │
│         ▼            ▼           ▼           ▼      │
│     ┌──────┐   ┌─────────┐ ┌────────┐ ┌─────────┐  │
│     │ BLE  │   │Wi-Fi    │ │WebSock │ │ Nostr   │  │
│     │Mesh  │   │Aware    │ │Relay   │ │Transport│  │
│     └──────┘   └─────────┘ └───┬────┘ └────┬────┘  │
│                                │           │        │
└────────────────────────────────┼───────────┼────────┘
                                 │           │
                    ┌────────────▼───────────▼────────┐
                    │       PYTHON BACKEND             │
                    │                                  │
                    │  ┌──────┐ ┌─────────┐ ┌───────┐ │
                    │  │ API  │ │Services │ │Workers│ │
                    │  └──┬───┘ └────┬────┘ └───┬───┘ │
                    │     └──────────┼──────────┘     │
                    │                ▼                 │
                    │         ┌────────────┐          │
                    │         │  MySQL 8+  │          │
                    │         └────────────┘          │
                    └─────────────────────────────────┘
```

## 2. Android Client Architecture

### 2.1 Clean Architecture Layers

```
┌─────────────────────────────────────────────┐
│              PRESENTATION                    │
│  Jetpack Compose UI + ViewModels            │
├─────────────────────────────────────────────┤
│              DOMAIN                          │
│  Use Cases, Entities, Repository Interfaces │
├─────────────────────────────────────────────┤
│              DATA                            │
│  Repository Implementations, DAOs, Network  │
├─────────────────────────────────────────────┤
│              TRANSPORT                       │
│  BLE, Wi-Fi Aware, WebSocket, Nostr, Tor   │
├─────────────────────────────────────────────┤
│              CRYPTO                          │
│  Identity, E2E Encryption, Key Management   │
└─────────────────────────────────────────────┘
```

### 2.2 Module Structure

```
android/
├── app/                          # Application entry, DI, navigation
├── core/
│   ├── crypto/                   # Identity, key agreement, encrypt/decrypt
│   │   ├── identity/             # Ed25519 device keys, Android Keystore
│   │   ├── session/              # X25519 key agreement, session keys
│   │   ├── cipher/               # AES-256-GCM / ChaCha20-Poly1305
│   │   └── hash/                 # SHA-256 content integrity
│   ├── database/                 # Room database, DAOs, entities, migrations
│   ├── domain/                   # Entities, use cases, repository interfaces
│   │   ├── model/                # Message, Conversation, Contact, etc.
│   │   └── usecase/              # Send, receive, queue, verify, etc.
│   ├── mesh/                     # Application-layer mesh networking
│   │   ├── packet/               # Binary envelope, serialization
│   │   ├── routing/              # TTL, hop limit, dedup, route selection
│   │   ├── queue/                # Outbox, forwarding queue, priority
│   │   └── discovery/            # Peer discovery aggregation
│   ├── network/                  # Internet transport abstraction
│   │   ├── websocket/            # Backend relay client
│   │   └── api/                  # REST API client (Retrofit/Ktor)
│   ├── transport/                # Unified transport interface
│   │   ├── api/                  # MeshTransport interface
│   │   ├── ble/                  # BLE GATT server + client
│   │   ├── wifi/                 # Wi-Fi Aware publish/subscribe
│   │   ├── nostr/                # Nostr NIP-04/NIP-44 encrypted events
│   │   └── tor/                  # Optional Tor proxy
│   └── transfer/                 # Chunked file/voice/media transfer
│       ├── chunk/                # Chunk splitting, integrity, reassembly
│       ├── scheduler/            # Priority queue, bandwidth adaptation
│       └── resume/               # Resumable transfer state machine
├── feature/
│   ├── auth/                     # Onboarding, identity setup
│   ├── chat/                     # One-to-one messaging UI
│   ├── contacts/                 # Contact management, verification
│   ├── files/                    # File picker, transfer progress
│   ├── groups/                   # Group/channel management
│   ├── voicenote/                # Recording, playback, waveform
│   └── settings/                 # Privacy, transport, battery settings
└── di/                           # Hilt dependency injection modules
```

### 2.3 Key Interfaces

```kotlin
// Unified transport abstraction
interface MeshTransport {
    val type: TransportType
    val capabilities: TransportCapabilities
    val state: StateFlow<TransportState>
    val incomingPackets: Flow<MeshPacket>
    val discoveredPeers: Flow<Set<PeerInfo>>

    suspend fun start()
    suspend fun stop()
    suspend fun send(packet: MeshPacket, peer: PeerInfo): SendResult
}

data class TransportCapabilities(
    val maxPayloadSize: Int,
    val recommendedChunkSize: Int,
    val estimatedBandwidth: Long,     // bytes/sec
    val estimatedLatency: Long,       // ms
    val supportsResume: Boolean,
    val supportsMulticast: Boolean
)

// Transport manager selects best transport per message
interface TransportManager {
    val availableTransports: StateFlow<Set<TransportType>>
    val connectedPeers: StateFlow<Map<PeerInfo, Set<TransportType>>>

    suspend fun send(envelope: EncryptedEnvelope, routing: RoutingInfo): DeliveryResult
    fun incomingEnvelopes(): Flow<ReceivedEnvelope>
    suspend fun negotiateTransport(peer: PeerInfo, transferSize: Long): TransportType
}
```

## 3. Python Backend Architecture

### 3.1 Module Structure

```
backend/
├── app/
│   ├── api/
│   │   ├── v1/
│   │   │   ├── devices.py        # Device registration, key rotation
│   │   │   ├── envelopes.py      # Encrypted message relay
│   │   │   ├── attachments.py    # Chunk upload/download coordination
│   │   │   ├── relays.py         # Relay registry
│   │   │   └── admin.py          # Admin endpoints (RBAC protected)
│   │   └── deps.py               # Dependency injection
│   ├── core/
│   │   ├── config.py             # Settings via pydantic-settings
│   │   ├── security.py           # Auth, rate limiting, RBAC
│   │   └── logging.py            # Structured logging, redaction
│   ├── db/
│   │   ├── session.py            # SQLAlchemy async session factory
│   │   └── base.py               # Declarative base
│   ├── models/                   # SQLAlchemy ORM models
│   │   ├── device.py
│   │   ├── envelope.py
│   │   ├── attachment.py
│   │   ├── relay.py
│   │   └── audit.py
│   ├── repositories/             # Data access layer
│   ├── schemas/                  # Pydantic request/response models
│   ├── services/                 # Business logic
│   │   ├── device_service.py
│   │   ├── envelope_service.py
│   │   ├── attachment_service.py
│   │   └── relay_service.py
│   ├── transports/               # Server-side transport adapters
│   │   ├── websocket_relay.py
│   │   └── nostr_adapter.py
│   ├── workers/                  # Background tasks
│   │   ├── cleanup.py            # Expired envelope/chunk cleanup
│   │   └── metrics.py            # Observability
│   └── main.py                   # FastAPI application factory
├── alembic/
│   ├── env.py
│   └── versions/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── conftest.py
├── pyproject.toml
└── Dockerfile
```

### 3.2 FastAPI Application Design

```python
# Conceptual application factory
def create_app() -> FastAPI:
    app = FastAPI(
        title="MistRoom Relay API",
        version="0.1.0",
        description="Optional Internet relay for MistRoom mesh messenger"
    )
    # Middleware: CORS, rate limiting, request ID
    # Routers: v1 devices, envelopes, attachments, relays, admin
    # Events: startup DB pool, shutdown cleanup
    # WebSocket: relay endpoint
    return app
```

## 4. MySQL Database Schema

### 4.1 Core Tables

| Table | Purpose | Encrypted? |
|-------|---------|-----------|
| `devices` | Device registration, public identity | Public metadata |
| `device_public_keys` | Ed25519 / X25519 public keys | Public keys only |
| `contacts` | Server-assisted contact lookup | Hashed identifiers |
| `conversations` | Conversation metadata | Blinded IDs |
| `conversation_members` | Membership records | Device fingerprints |
| `message_envelopes` | Encrypted relay queue | Ciphertext only |
| `attachment_metadata` | Chunk transfer coordination | Encrypted metadata |
| `attachment_chunks` | Encrypted blob references | Ciphertext only |
| `delivery_receipts` | Ack/delivery state | Encrypted receipt |
| `relay_endpoints` | Relay registry | Public metadata |
| `push_tokens` | Optional push registration | Encrypted tokens |
| `audit_events` | Security audit trail | Hashed details |
| `rate_limit_events` | Abuse prevention | IP/fingerprint hash |
| `blocked_devices` | Block list | Fingerprints |
| `feature_flags` | Server feature toggles | Public |

### 4.2 Key Principle

The backend **never** stores:
- Plaintext messages
- Decrypted attachments
- Private keys
- Recovery phrases
- Unencrypted voice notes
- Original filenames (only encrypted metadata blobs)

## 5. Cryptographic Design

### 5.1 Identity

```
First Launch
     │
     ├── Generate Ed25519 long-term signing key pair
     │      └── Store private key in Android Keystore
     │
     ├── Generate X25519 static key pair (for key agreement)
     │      └── Store private key in Android Keystore
     │
     ├── Derive device fingerprint = SHA-256(Ed25519_public_key)[0..16]
     │
     └── User selects display name (separate from crypto identity)
```

### 5.2 Session Establishment

```
Alice                              Bob
  │                                 │
  ├── X25519 ephemeral key ────────►│
  │                                 │
  │◄──── X25519 ephemeral key ──────┤
  │                                 │
  ├── ECDH(Alice_ephemeral,         │
  │        Bob_static)              │
  │   ECDH(Alice_static,            │
  │        Bob_ephemeral)           │
  │   ECDH(Alice_ephemeral,         │
  │        Bob_ephemeral)           │
  │                                 │
  ├── HKDF → session_key ──────────►│
  │                                 │
  │   All messages encrypted with   │
  │   AES-256-GCM or ChaCha20-Poly │
  │   using session key + unique    │
  │   per-message nonce             │
  └─────────────────────────────────┘
```

### 5.3 Message Encryption

```
Plaintext Message
       │
       ▼
Generate random 12-byte nonce
       │
       ▼
AES-256-GCM Encrypt(session_key, nonce, plaintext, AAD=header)
       │
       ▼
Ciphertext + Auth Tag
       │
       ▼
Sign(Ed25519_private, ciphertext || nonce || header)
       │
       ▼
Encrypted Envelope ready for transport
```

### 5.4 Group Encryption

```
Group Creator
     │
     ├── Generate random sender key
     │
     ├── Encrypt sender key for each member using pairwise session
     │
     ├── Distribute encrypted sender key
     │
     └── Group messages encrypted with sender key (AES-256-GCM)

On membership change:
     └── Rotate sender key, redistribute to remaining members
```

### 5.5 File Encryption

```
Original File
     │
     ▼
Generate random file_key (256-bit)
     │
     ▼
Stream-encrypt: AES-256-GCM(file_key, chunk_nonce_i, chunk_i)
     │
     ▼
SHA-256 each encrypted chunk → chunk_hash_i
     │
     ▼
SHA-256 over all chunk hashes → file_integrity_hash
     │
     ▼
Attachment metadata = Encrypt(session_key, {
    filename, mime_type, size, chunk_count,
    chunk_hashes[], file_key, file_integrity_hash
})
     │
     ▼
Only metadata + encrypted chunks leave the device
```

## 6. Mesh Transport Design

### 6.1 Application-Layer Mesh

BLE is **not** a native mesh on Android. MistRoom implements a delay-tolerant application-layer mesh:

```
┌──────┐    BLE    ┌──────┐    BLE    ┌──────┐
│ Alice │◄────────►│  Bob │◄────────►│Carol │
└──────┘           └──────┘           └──────┘
                       │ Wi-Fi Aware
                   ┌───▼───┐
                   │ David │
                   └───────┘
```

### 6.2 Mesh Packet Envelope

```
┌──────────────────────────────────────────┐
│ Protocol Version         (1 byte)        │
│ Packet Type              (1 byte)        │
│ Flags                    (2 bytes)       │
│ Packet ID                (16 bytes UUID) │
│ Sender Fingerprint       (16 bytes)      │
│ Recipient Fingerprint    (16 bytes)      │
│ Conversation/Routing ID  (16 bytes)      │
│ Message Type             (1 byte)        │
│ Created Timestamp        (8 bytes)       │
│ Expiration Timestamp     (8 bytes)       │
│ Hop Count                (1 byte)        │
│ Max Hops / TTL           (1 byte)        │
│ Payload Length            (4 bytes)       │
│ Chunk Metadata           (variable)      │
│ Nonce                    (12 bytes)      │
│ Ciphertext               (variable)      │
│ Auth Tag                 (16 bytes)      │
│ Signature                (64 bytes)      │
└──────────────────────────────────────────┘
```

### 6.3 Routing Algorithm

```
On packet received:
    │
    ├── Check packet ID in dedup cache
    │       ├── SEEN → discard
    │       └── NEW  → continue
    │
    ├── Validate: TTL > 0, timestamp not expired, signature valid
    │
    ├── Decrement hop count, increment hop count
    │
    ├── Is recipient == this device?
    │       ├── YES → deliver locally
    │       └── NO  → check forwarding policy
    │                    ├── RELAY DISABLED → discard
    │                    ├── RELAY ENABLED  → check priority & quotas
    │                    │                    ├── QUOTA OK → enqueue for forward
    │                    │                    └── QUOTA EXCEEDED → discard
    │                    └── STORE-FORWARD  → persist for later delivery
    │
    └── Add packet ID to dedup cache with expiration
```

### 6.4 Store-and-Forward Priority

| Priority | Content Types |
|----------|--------------|
| CRITICAL | Delivery receipts, key exchange |
| HIGH | Text messages, system messages |
| MEDIUM | Voice notes, small images |
| LOW | Documents, large images |
| BULK | Videos, large files |

Large transfers never block high-priority messages.

## 7. Chunked Transfer Protocol

### 7.1 State Machine

```
IDLE
  │ initiate transfer
  ▼
OFFERED ──────────► REJECTED
  │ accepted              │
  ▼                       ▼
ACCEPTED               (end)
  │
  ▼
PREPARING
  │ encryption + chunking
  ▼
ENCRYPTING
  │
  ▼
TRANSFERRING ◄──── RESUMING
  │     │              ▲
  │     │ interrupted   │
  │     ▼              │
  │   PAUSED ──────────┘
  │
  ▼
VERIFYING
  │ hash match?
  ├── YES
  ▼
COMPLETED

Failures at any stage → FAILED
User cancellation     → CANCELLED
Time exceeded         → EXPIRED
```

### 7.2 Chunk Sizing by Transport

| Transport | Recommended Chunk Size | Max Payload |
|-----------|----------------------|-------------|
| BLE | 512 bytes | ~512 bytes (MTU dependent) |
| Wi-Fi Aware | 64 KB | ~256 KB |
| WebSocket | 256 KB | ~1 MB |
| Nostr | 32 KB (base64 encoded) | Relay-dependent |

## 8. Voice Note Pipeline

```
Microphone (PCM)
     │
     ▼
Opus Encoder (configurable bitrate)
     │
     ▼
OGG/Opus Container
     │
     ▼
Generate file_key
     │
     ▼
AES-256-GCM Stream Encrypt
     │
     ▼
Chunk (transport-appropriate size)
     │
     ▼
Transfer via best available transport

Recipient:
     │
     ▼
Receive chunks → track completion
     │
     ▼
Reassemble encrypted stream
     │
     ▼
Verify SHA-256 integrity
     │
     ▼
AES-256-GCM Decrypt
     │
     ▼
OGG/Opus Playback
```

### Voice Quality Profiles

| Profile | Bitrate | Use Case |
|---------|---------|----------|
| Low | ~12 kbps | BLE-only, battery saver |
| Balanced | ~24 kbps | Default |
| High | ~48 kbps | Wi-Fi Aware available |

## 9. BLE GATT Design

```
Service: MistRoom Mesh (custom UUID)
│
├── Characteristic: Packet Write (WRITE, WRITE_NO_RESPONSE)
│   └── Client writes mesh packets to peer
│
├── Characteristic: Packet Indicate (INDICATE)
│   └── Server indicates incoming mesh packets to client
│
├── Characteristic: Peer Info (READ)
│   └── Device fingerprint, protocol version, capabilities
│
└── Characteristic: MTU Negotiation (READ)
    └── Negotiated MTU for optimal chunk sizing
```

**BLE Lifecycle:**
1. Advertise service UUID
2. Scan for service UUID
3. Connect and negotiate MTU
4. Exchange peer info
5. Send/receive packets via write/indicate
6. Manage connection pool (max ~5 concurrent)
7. Handle disconnection and reconnection
8. Adaptive scan intervals based on battery state

## 10. Transport Selection Algorithm

```python
def select_transport(message, peer, available_transports, battery_level):
    scores = {}
    for transport in available_transports:
        score = 0
        cap = transport.capabilities

        # Bandwidth fit
        if message.size <= cap.recommended_chunk_size:
            score += 30
        elif message.size <= cap.max_payload_size * 100:
            score += 20

        # Latency preference for small messages
        if message.priority >= HIGH and cap.estimated_latency < 100:
            score += 25

        # Battery awareness
        if battery_level < 20:
            if transport.type == BLE:
                score += 15  # BLE is lower power
            elif transport.type == WIFI_AWARE:
                score -= 10

        # Direct connectivity bonus
        if peer in transport.connected_peers:
            score += 20

        # Resume support for large transfers
        if message.size > 1_000_000 and cap.supports_resume:
            score += 15

        scores[transport] = score

    return max(scores, key=scores.get)
```

## 11. Security Invariants

1. **No plaintext ever leaves the device** — all content encrypted before any transmission
2. **No private keys leave Android Keystore** — signing/decryption happens in-place
3. **Intermediate peers see only ciphertext** — no metadata exposure to relays
4. **Nonces are never reused** — random 12-byte nonce per encryption operation
5. **All packets are authenticated** — Ed25519 signature on every envelope
6. **Duplicate packets are discarded** — bounded dedup cache per device
7. **TTL prevents infinite relay** — packets die after max hops
8. **File integrity is verified end-to-end** — SHA-256 on chunks and whole file
9. **Backend never sees plaintext** — server stores only encrypted envelopes
10. **Key rotation on group membership change** — forward secrecy for groups

## 12. Deployment Architecture

```
┌─────────────────────────────────────────────┐
│              Docker Compose                  │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ FastAPI   │  │ MySQL 8  │  │  Redis    │ │
│  │ Backend   │  │          │  │ (optional)│ │
│  │ :8000     │  │ :3306    │  │ :6379     │ │
│  └─────┬────┘  └──────────┘  └───────────┘ │
│        │                                     │
│  ┌─────▼────┐                               │
│  │  Nginx   │                               │
│  │ Reverse  │                               │
│  │ Proxy    │                               │
│  │ :80/:443 │                               │
│  └──────────┘                               │
└─────────────────────────────────────────────┘
```
