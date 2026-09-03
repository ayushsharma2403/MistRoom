# MistRoom — Threat Model

> Version: 1.0-draft

## 1. Overview

This document catalogs adversary capabilities, attack surfaces, mitigations, and residual risks for the MistRoom decentralized mesh messenger.

MistRoom operates across three trust boundaries:

1. **Local device** — user's Android phone
2. **Local mesh** — BLE / Wi-Fi Aware peers within radio range
3. **Internet** — Backend server, Nostr relays, optional Tor

Each boundary has distinct threat actors and attack surfaces.

## 2. Threat Actors

### 2.1 Passive Radio Observer

**Capabilities:**
- Observe BLE advertisement packets
- Observe Wi-Fi Aware discovery frames
- Record timing, frequency, and volume of wireless transmissions
- Correlate device presence with radio activity patterns

**Cannot:**
- Read encrypted message content
- Determine message recipients (fingerprints are not linked to real identity)
- Inject or modify packets

**Mitigations:**
- All payload content encrypted (AES-256-GCM / ChaCha20-Poly1305)
- BLE uses rotating RPA (Resolvable Private Address) when OS supports it
- Packet IDs are random UUIDs, not sequential
- Minimal unencrypted metadata in advertisements

**Residual risk:**
- Timing analysis can reveal communication patterns
- BLE advertising frequency reveals device activity
- Physical proximity is inherently observable
- Device fingerprint in mesh packets (16 bytes) is pseudonymous but linkable across sessions

### 2.2 Malicious Mesh Peer

**Capabilities:**
- Send malformed packets
- Send replayed packets with valid signatures from other senders
- Flood the network with excessive packets
- Claim false routing information
- Drop or delay forwarded packets selectively
- Attempt resource exhaustion (disk, memory, battery)
- Observe packet metadata (sender/recipient fingerprints, sizes, timing)
- Attempt to correlate traffic patterns

**Cannot:**
- Decrypt message content without session keys
- Forge signatures (requires sender's Ed25519 private key)
- Modify encrypted payloads without detection (auth tag verification)

**Mitigations:**

| Attack | Mitigation |
|--------|-----------|
| Malformed packets | Strict validation before any allocation; discard and do not respond |
| Replay | Packet ID deduplication cache with expiration |
| Flooding | Per-peer rate limits; drop excess; reduce relay willingness |
| False routing | Route verification via end-to-end delivery ACKs; TTL limits |
| Selective drop | Timeout-based retransmission; alternative route discovery |
| Resource exhaustion | Bounded queues, transfer quotas, storage limits |
| Metadata observation | Fingerprints are pseudonymous; content is opaque |

**Residual risk:**
- Determined adversary can build traffic-analysis models from metadata
- Selective dropping is difficult to distinguish from poor connectivity
- A Sybil attack (many fake peers) can surround a target device

### 2.3 Malicious Nostr Relay

**Capabilities:**
- Observe encrypted event metadata (pubkeys, timestamps, event kinds)
- Drop events selectively
- Delay event delivery
- Reorder events
- Serve stale or replayed events
- Correlate sender/recipient activity across events
- Log IP addresses of connecting clients

**Cannot:**
- Decrypt NIP-44 encrypted payloads
- Forge event signatures
- Modify event content without invalidating signatures

**Mitigations:**
- All Nostr payloads use NIP-44 or equivalent authenticated encryption
- Multi-relay redundancy (post to multiple relays)
- Event expiration via NIP-40
- Optional Tor transport hides client IP from relay
- Client validates all event signatures
- Duplicate event detection

**Residual risk:**
- Relay operator sees connection timing and IP (mitigated by Tor)
- Relay can permanently deny service
- Cross-relay correlation possible if same pubkey is used

### 2.4 Compromised Backend Server

**Capabilities:**
- Access MySQL database containing encrypted envelopes
- Read device public keys and registration metadata
- Observe API request patterns and IP addresses
- Modify relay responses
- Deny service

**Cannot:**
- Decrypt message envelopes (no private keys stored server-side)
- Decrypt attachment content (client-encrypted before upload)
- Forge device signatures
- Access Android Keystore on any client

**Mitigations:**
- Backend never receives plaintext content
- Database stores only encrypted envelopes and public metadata
- Server authentication via device-signed challenges
- Clients verify server TLS certificates
- Clients can operate entirely offline via mesh
- Audit logging for administrative actions

**Residual risk:**
- Compromised server can observe traffic patterns and device registration timing
- Server can inject false public keys (key transparency / TOFU mitigates this)
- Server can deny service or selectively drop envelopes

### 2.5 Compromised / Lost Device

**Capabilities:**
- Access local Room database
- Access local encrypted file cache
- Potentially extract keys from Android Keystore (depends on device security level)
- Access all historical decrypted messages stored locally

**Mitigations:**
- Private keys stored in Android Keystore (hardware-backed when available)
- Optional device PIN/biometric requirement for key access
- Remote device revocation via backend
- Key-change notifications to contacts
- Optional auto-expiring messages
- Optional encrypted local database (SQLCipher or similar)
- Message retention limits

**Residual risk:**
- Decrypted message history on device is accessible to device owner/thief
- Hardware Keystore security varies by device manufacturer
- Android OS vulnerabilities could bypass Keystore protections
- Past messages are not protected by forward secrecy rotation

### 2.6 Spam and Denial of Service

**Attack vectors:**
- Mass unsolicited messages via mesh
- Large file transfer offers to exhaust storage
- Connection flooding to exhaust BLE connection slots
- Battery drain attacks via constant BLE scanning provocation

**Mitigations:**
- Per-peer message rate limits
- Store-and-forward quota per unknown sender
- File transfer requires explicit acceptance
- Configurable relay willingness (none / text only / all)
- Unknown-sender throttling
- Block/report functionality
- Battery-aware scan interval adaptation
- Maximum concurrent BLE connections (typically 5-7)

**Residual risk:**
- A nearby attacker can force BLE scanning activity
- Mesh flooding is difficult to prevent completely in an open network
- Blocking requires receiving at least one message from the spammer

### 2.7 Malicious Files

**Attack vectors:**
- Path traversal in filenames (`../../etc/passwd`)
- Decompression bombs
- Oversized metadata fields
- Malformed media triggering decoder vulnerabilities
- Executable files (APKs)

**Mitigations:**
- Files stored using generated internal names (never user-supplied paths)
- Original filename stored only in encrypted metadata
- Display names are sanitized before rendering
- Maximum metadata field sizes enforced
- Files never auto-executed or auto-installed
- Content-type validated against actual content where feasible
- Chunk and file size limits enforced before allocation
- Streaming I/O prevents memory exhaustion

**Residual risk:**
- Media decoders in Android may have undiscovered vulnerabilities
- User may manually open dangerous files after saving

## 3. Trust Model

```
HIGH TRUST
│   Local device (Android Keystore, local DB)
│
│   Verified contacts (QR-code verified fingerprint)
│
MEDIUM TRUST
│   Unverified contacts (TOFU — Trust On First Use)
│
│   MistRoom backend (encrypted envelopes only)
│
LOW TRUST
│   Unknown mesh peers (relay only, no content access)
│
│   Nostr relays (encrypted events only)
│
ZERO TRUST
│   Internet transit (TLS + E2E encryption)
│
│   Malicious peers (strict validation, rate limiting)
```

## 4. What MistRoom Does NOT Protect Against

The following are **explicitly out of scope** or have **inherent platform limitations**:

| Limitation | Explanation |
|-----------|-------------|
| Physical proximity detection | BLE/Wi-Fi reveals that a device is nearby |
| Traffic analysis | Packet timing and volume patterns are observable |
| Device seizure | Local message history is accessible on the device |
| Android OS compromise | Root/kernel exploits bypass application security |
| Guaranteed delivery | Mesh is delay-tolerant, not real-time guaranteed |
| Universal Wi-Fi Aware | Only some Android devices/OS versions support it |
| Complete anonymity | MistRoom does not claim anonymous communication |
| Perfect forward secrecy (Phase 1) | Initial implementation uses static session keys; ratcheting is Phase 5+ |
| Coercion resistance | No deniable encryption in current design |

## 5. Cryptographic Assumptions

The security of MistRoom depends on:

1. **Ed25519** signature scheme is unforgeable under chosen-message attacks
2. **X25519** ECDH key agreement is secure under the CDH assumption
3. **AES-256-GCM** provides authenticated encryption with unique nonces
4. **SHA-256** is collision-resistant and pre-image resistant
5. **HKDF** produces cryptographically independent subkeys
6. **Android Keystore** protects private keys from application-layer extraction
7. **Random number generation** (SecureRandom) is unpredictable

If any of these assumptions are broken, the corresponding security properties are compromised.

## 6. Incident Response

### Key Compromise

1. Generate new device identity
2. Notify contacts of key change
3. Revoke old public key via backend (if connected)
4. Contacts see key-change warning
5. Re-verify via QR code

### Suspected Relay Compromise

1. Disable relay connectivity in settings
2. Operate in mesh-only mode
3. Rotate session keys with all contacts
4. Report relay if applicable

### Spam / Abuse

1. Block sending device fingerprint
2. Report via backend (if connected)
3. Adjust relay willingness settings
4. Clear forwarding queue
