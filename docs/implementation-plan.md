# MistRoom — Implementation Plan

> Decentralized Offline Mesh Messenger  
> Last updated: 2026-09-03

## 1. Current Repository State

### What Exists
- Git repository at `github.com/ayushsharma2403/MistRoom`
- Empty `backend/` and `frontend/` directories
- `.gitignore` covering node_modules, .venv, .env, build artifacts, IDE files
- `.vscode/settings.json` with git warning suppression

### Available Tooling (Windows 10/11 dev machine)
- **Python**: 3.11.9 (primary), 3.14.3 (secondary)
- **Java**: 1.8.0_481 (needs JDK 17+ for modern Android Gradle)
- **Node**: v24.14.0
- **Docker**: 29.5.3
- **Docker Compose**: v5.1.4
- **MySQL**: Not installed locally (will use Docker)
- **Android CLI**: Not installed (install via skill)
- **Gradle**: Not installed globally (use Gradle wrapper)

### What Is Missing (Everything)
- Android project
- Python backend
- MySQL schema
- Docker infrastructure
- All application code
- All tests
- All documentation beyond what was just created

## 2. Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Android language | Kotlin + Jetpack Compose | Modern, official, type-safe |
| Android architecture | Clean Architecture + MVVM | Testable, maintainable |
| Android DI | Hilt | Official, well-supported |
| Android DB | Room | Official SQLite ORM |
| Backend framework | FastAPI (Python 3.11+) | Async, auto-docs, Pydantic |
| Backend ORM | SQLAlchemy 2.x (async) | Mature, typed, migration support |
| Database | MySQL 8+ (Docker) | As specified in requirements |
| Migrations | Alembic | Standard for SQLAlchemy |
| Crypto (Android) | Tink + BouncyCastle | Google-backed, audited |
| Crypto (Backend) | PyNaCl + cryptography | Audited NaCl bindings |
| E2E Encryption | AES-256-GCM | Authenticated, hardware-accelerated |
| Identity keys | Ed25519 (signing), X25519 (agreement) | Standard, fast, compact |
| Key storage | Android Keystore | Hardware-backed when available |
| BLE | Android BLE API (BluetoothGatt) | Native, no third-party SDK |
| Wi-Fi Aware | Android Wi-Fi Aware API | Native, availability varies |
| Audio codec | Opus via MediaCodec | Efficient, high quality |
| Binary protocol | Custom compact envelope | Bandwidth-efficient for BLE |
| Transport abstraction | Interface + implementations | Pluggable transport layer |
| Containerization | Docker Compose | Local dev + deployment |

## 3. Risks and Platform Limitations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| BLE MTU limits (20-517 bytes) | Slow large transfers | App-layer fragmentation; prefer Wi-Fi Aware for large files |
| BLE max ~5-7 connections | Limited mesh size | Connection pooling; scan/connect cycling |
| Wi-Fi Aware not on all devices | Feature unavailable | Runtime detection; graceful fallback to BLE |
| Android background restrictions | Services killed | WorkManager + foreground service notification |
| JDK 8 on dev machine | Cannot build Android | Need JDK 17+ installation |
| No Android SDK installed | Cannot build | Need SDK installation or use Docker-based build |
| Opus codec support varies | Some devices lack hardware Opus | Software decoder fallback via libopus |
| BLE mesh is app-layer only | Not true hardware mesh | Document clearly; implement delay-tolerant design |
| Key exchange without server | Bootstrap problem | QR code + BLE direct exchange |
| Large file over BLE | Very slow | Transfer scheduler with time estimates; prefer Wi-Fi Aware |

## 4. Phased Delivery Plan

---

### Phase 0: Infrastructure & Design ← CURRENT

**Goal:** Repository skeleton, Docker dev stack, CI basics, all design documents.

**Deliverables:**
- [x] `docs/architecture.md`
- [x] `docs/protocol.md`
- [x] `docs/threat-model.md`
- [x] `docs/api.md`
- [x] `docs/implementation-plan.md` (this document)
- [ ] Docker Compose (FastAPI + MySQL + Redis)
- [ ] Backend project skeleton (FastAPI, SQLAlchemy, Alembic)
- [ ] MySQL schema + initial Alembic migration
- [ ] Backend health/ready endpoints working
- [ ] `.env.example` with all configuration variables
- [ ] `README.md` with setup instructions
- [ ] `.gitignore` updated for Android + Python + Docker

**Android setup deferred:** JDK 17+ and Android SDK are not currently installed. The Android project skeleton will be created after verifying the development environment or documenting the required setup.

**Estimated effort:** This session

---

### Phase 1: Secure Core & Basic Chat (Backend-first)

**Goal:** Working backend with device registration, key directory, encrypted envelope relay, and database persistence.

**Backend:**
- [ ] Device registration endpoint
- [ ] Device public-key lookup endpoint
- [ ] Key rotation endpoint
- [ ] Encrypted envelope submission
- [ ] Pending envelope retrieval
- [ ] Delivery receipt endpoint
- [ ] WebSocket relay endpoint
- [ ] Rate limiting middleware
- [ ] Request authentication (Ed25519 signature verification)
- [ ] Pydantic schemas for all endpoints
- [ ] Unit tests for services
- [ ] Integration tests for API endpoints

**Database:**
- [ ] `devices` table + indexes
- [ ] `device_public_keys` table
- [ ] `message_envelopes` table + indexes
- [ ] `delivery_receipts` table
- [ ] `audit_events` table
- [ ] `rate_limit_events` table
- [ ] `blocked_devices` table
- [ ] `feature_flags` table
- [ ] Alembic migration for all tables

**Android (when SDK available):**
- [ ] Project skeleton with Hilt, Room, Compose, Navigation
- [ ] Device identity generation (Ed25519 + X25519)
- [ ] Android Keystore integration
- [ ] Room database with Message, Conversation, Contact entities
- [ ] Basic chat UI (conversation list + message thread)
- [ ] REST API client (Retrofit/Ktor)
- [ ] Encrypted message send/receive via backend relay
- [ ] Unit tests for crypto, domain logic

**Estimated effort:** 2-3 sessions

---

### Phase 2: Offline BLE Transport

**Goal:** BLE discovery, direct encrypted message exchange, offline outbox.

- [ ] BLE GATT service definition (custom UUID)
- [ ] BLE advertising with service UUID
- [ ] BLE scanning with service filter
- [ ] MTU negotiation
- [ ] Peer discovery and capability exchange
- [ ] Mesh packet serialization/deserialization
- [ ] Packet ID deduplication cache
- [ ] Ed25519 signature verification on received packets
- [ ] Session key establishment (X25519 ECDH + HKDF)
- [ ] Encrypted message send/receive over BLE
- [ ] Persistent offline outbox (Room)
- [ ] Delivery acknowledgement packets
- [ ] TTL and hop-count enforcement
- [ ] Store-and-forward queue
- [ ] Connection lifecycle management
- [ ] BLE transport status in UI
- [ ] Simulated mesh tests

**Estimated effort:** 3-4 sessions

---

### Phase 3: Attachments & Voice Notes

**Goal:** Voice-note recording/playback, encrypted file transfers, chunking, resumption.

- [ ] Voice note recording (Opus via MediaCodec or libopus)
- [ ] Waveform visualization
- [ ] Playback with progress
- [ ] File picker integration
- [ ] Camera/gallery capture
- [ ] MIME type detection
- [ ] Client-side encryption (per-file random key + AES-256-GCM)
- [ ] Chunk splitting with SHA-256 per chunk
- [ ] Transfer offer/accept/reject protocol
- [ ] Chunk transmission and acknowledgement
- [ ] Resumable transfer state machine
- [ ] Transfer progress UI (%, speed, ETA)
- [ ] Pause/cancel/retry controls
- [ ] Thumbnail generation (images/video)
- [ ] Attachment metadata encryption
- [ ] Backend attachment chunk API
- [ ] Storage management (limits, cleanup)
- [ ] Safe filename handling
- [ ] Tests for interrupted transfers, corrupted chunks

**Estimated effort:** 3-4 sessions

---

### Phase 4: Wi-Fi Aware & Large Transfers

**Goal:** High-bandwidth local transfers, transport selection.

- [ ] Wi-Fi Aware feature detection
- [ ] Wi-Fi Aware publish/subscribe
- [ ] Wi-Fi Aware data path (NAN data path)
- [ ] Transport capability reporting
- [ ] Transport selection algorithm
- [ ] Automatic transport negotiation
- [ ] Concurrent chunk transfer
- [ ] Backpressure mechanism
- [ ] Bandwidth adaptation
- [ ] Large file streaming I/O
- [ ] Graceful fallback to BLE
- [ ] Device compatibility documentation
- [ ] Tests

**Estimated effort:** 2-3 sessions

---

### Phase 5: Groups & Advanced Security

**Goal:** Group/channel messaging, key rotation, contact verification.

- [ ] Group/channel data model
- [ ] Membership management
- [ ] Sender-key group encryption
- [ ] Key rotation on membership change
- [ ] QR-code contact verification
- [ ] Safety-number display
- [ ] Key-change warnings
- [ ] Device revocation
- [ ] Block/report functionality
- [ ] Geographic channels (geohash)
- [ ] Group UI
- [ ] Tests

**Estimated effort:** 2-3 sessions

---

### Phase 6: Nostr & Tor

**Goal:** Optional Internet transports.

- [ ] Nostr transport adapter
- [ ] NIP-44 encrypted events
- [ ] Configurable relay list
- [ ] Event expiration
- [ ] Nostr chunked attachment support
- [ ] Tor proxy integration (Orbot or embedded)
- [ ] Transport privacy settings UI
- [ ] Connection metadata documentation
- [ ] Tests

**Estimated effort:** 2 sessions

---

### Phase 7: Production Hardening

**Goal:** Performance, battery, observability, security review.

- [ ] Battery profiling
- [ ] Adaptive BLE scan intervals
- [ ] Background work optimization
- [ ] Structured logging with redaction
- [ ] Observability metrics
- [ ] Database retention and cleanup
- [ ] Load testing
- [ ] Security review
- [ ] Accessibility audit
- [ ] Release documentation
- [ ] Web admin dashboard (optional)

**Estimated effort:** 2-3 sessions

---

## 5. Test Strategy

### Unit Tests
- **Backend:** pytest with fixtures, httpx test client
- **Android:** JUnit 5 + MockK for domain/crypto/protocol logic

### Integration Tests
- **Backend:** TestContainers for MySQL, real FastAPI app
- **Android:** Instrumented tests with Room in-memory DB

### Transport Tests
- Simulated BLE transport (in-process packet exchange)
- Simulated peer disconnection and reconnection
- Packet loss, duplication, corruption injection
- Transfer interruption and resume verification

### End-to-End Tests
- Two simulated devices exchanging encrypted text
- File transfer with interruption and resume
- Store-and-forward delivery after delay
- Multi-hop relay through intermediate simulated node

### Security Tests
- Malformed packet handling (fuzzing)
- Replay attack rejection
- Invalid signature rejection
- Oversized payload rejection
- Rate limit enforcement
- Path traversal in filenames
- Decompression bomb protection

## 6. Immediate Next Steps

1. **Create Docker Compose** with FastAPI + MySQL + Redis
2. **Scaffold backend** with FastAPI project structure
3. **Create MySQL schema** and first Alembic migration
4. **Implement health/ready** endpoints
5. **Implement device registration** endpoint
6. **Add backend tests**
7. **Update README** with setup/run instructions
8. **Commit and push**

After Phase 0 is stable, proceed to Phase 1 backend endpoints, then set up the Android project (requires JDK 17+ and Android SDK).
