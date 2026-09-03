# MistRoom — REST API Specification

> Version: 1.0-draft  
> Base URL: `/api/v1`  
> Auth: Device-signed challenge-response (Ed25519)

## 1. Overview

The MistRoom backend provides optional Internet-connected services. All endpoints handle **encrypted data only** — the server never receives plaintext messages, files, or private keys.

### Authentication

Most endpoints require device authentication:

1. Client sends `Authorization: MistRoom <fingerprint>:<timestamp>:<signature>`
2. `signature` = Ed25519_sign(private_key, `fingerprint || timestamp || method || path`)
3. Server verifies signature against registered public key
4. Timestamp must be within ±5 minutes (replay window)

Unauthenticated endpoints: `/health`, `/ready`, `POST /devices/register`

### Error Format

```json
{
  "error": {
    "code": "ENVELOPE_NOT_FOUND",
    "message": "No envelope with the specified ID exists",
    "details": {}
  }
}
```

Standard HTTP status codes: 200, 201, 400, 401, 403, 404, 409, 413, 422, 429, 500.

### Rate Limiting

All endpoints are rate-limited per device fingerprint:

| Category | Limit |
|----------|-------|
| Registration | 5 / hour / IP |
| Envelope submission | 100 / minute |
| Attachment upload | 20 / minute |
| Chunk upload | 200 / minute |
| Read operations | 300 / minute |

Rate limit headers: `X-RateLimit-Remaining`, `X-RateLimit-Reset`

---

## 2. Device Endpoints

### `POST /api/v1/devices/register`

Register a new device with the relay server.

**Request:**
```json
{
  "fingerprint": "a1b2c3d4e5f67890a1b2c3d4e5f67890",
  "ed25519_public_key": "<base64>",
  "x25519_public_key": "<base64>",
  "display_name_encrypted": "<base64>",
  "protocol_version": 1,
  "capabilities": 255,
  "timestamp": 1693750000000,
  "signature": "<base64>"
}
```

**Response: `201 Created`**
```json
{
  "device_id": "uuid",
  "fingerprint": "a1b2c3d4e5f67890a1b2c3d4e5f67890",
  "registered_at": "2026-09-03T12:00:00Z"
}
```

**Errors:** `409 Conflict` (fingerprint already registered), `422` (invalid key format)

---

### `POST /api/v1/devices/rotate-key`

Rotate the X25519 key pair. Requires authentication.

**Request:**
```json
{
  "new_x25519_public_key": "<base64>",
  "old_key_signature": "<base64>",
  "timestamp": 1693750000000,
  "signature": "<base64>"
}
```

**Response: `200 OK`**
```json
{
  "fingerprint": "a1b2c3d4e5f67890a1b2c3d4e5f67890",
  "key_rotated_at": "2026-09-03T12:00:00Z"
}
```

---

### `GET /api/v1/devices/{fingerprint}`

Retrieve a device's public keys and capabilities.

**Response: `200 OK`**
```json
{
  "fingerprint": "a1b2c3d4e5f67890a1b2c3d4e5f67890",
  "ed25519_public_key": "<base64>",
  "x25519_public_key": "<base64>",
  "protocol_version": 1,
  "capabilities": 255,
  "last_seen": "2026-09-03T12:00:00Z"
}
```

**Errors:** `404` (unknown device)

---

## 3. Envelope Endpoints

### `POST /api/v1/envelopes`

Submit an encrypted message envelope for relay delivery.

**Request:**
```json
{
  "envelope_id": "uuid",
  "sender_fingerprint": "a1b2c3d4e5f67890a1b2c3d4e5f67890",
  "recipient_fingerprint": "f0e1d2c3b4a596870f1e2d3c4b5a6978",
  "encrypted_payload": "<base64>",
  "expires_at": "2026-09-10T12:00:00Z",
  "priority": "HIGH",
  "signature": "<base64>"
}
```

**Response: `201 Created`**
```json
{
  "envelope_id": "uuid",
  "queued_at": "2026-09-03T12:00:00Z",
  "expires_at": "2026-09-10T12:00:00Z"
}
```

**Errors:** `413` (payload too large), `429` (rate limited)

**Max payload size:** 64 KB per envelope (use chunked attachment for larger)

---

### `GET /api/v1/envelopes/pending`

Retrieve pending envelopes for the authenticated device.

**Query params:**
- `limit` (int, default 50, max 200)
- `after` (cursor, envelope_id for pagination)

**Response: `200 OK`**
```json
{
  "envelopes": [
    {
      "envelope_id": "uuid",
      "sender_fingerprint": "a1b2c3d4e5f67890a1b2c3d4e5f67890",
      "encrypted_payload": "<base64>",
      "queued_at": "2026-09-03T12:00:00Z",
      "expires_at": "2026-09-10T12:00:00Z",
      "priority": "HIGH",
      "signature": "<base64>"
    }
  ],
  "has_more": false,
  "cursor": "uuid"
}
```

---

### `POST /api/v1/envelopes/{envelope_id}/receipt`

Acknowledge receipt of an envelope (marks it for cleanup).

**Request:**
```json
{
  "received_at": "2026-09-03T12:01:00Z",
  "signature": "<base64>"
}
```

**Response: `200 OK`**

---

## 4. Attachment Endpoints

### `POST /api/v1/attachments`

Create an attachment transfer session.

**Request:**
```json
{
  "attachment_id": "uuid",
  "sender_fingerprint": "a1b2c3d4e5f67890a1b2c3d4e5f67890",
  "recipient_fingerprint": "f0e1d2c3b4a596870f1e2d3c4b5a6978",
  "encrypted_metadata": "<base64>",
  "total_size": 4194304,
  "chunk_count": 16,
  "chunk_size": 262144,
  "file_hash": "<hex-sha256>",
  "expires_at": "2026-09-10T12:00:00Z",
  "signature": "<base64>"
}
```

**Response: `201 Created`**
```json
{
  "attachment_id": "uuid",
  "upload_url_prefix": "/api/v1/attachments/uuid/chunks/",
  "created_at": "2026-09-03T12:00:00Z"
}
```

**Limits:** Max total size 500 MB, max chunk count 10,000

---

### `POST /api/v1/attachments/{attachment_id}/chunks/{chunk_index}`

Upload a single encrypted chunk.

**Request:** Binary body (encrypted chunk data)

**Headers:**
- `Content-Type: application/octet-stream`
- `X-Chunk-Hash: <hex-sha256>`
- `Content-Length: <size>`

**Response: `201 Created`**
```json
{
  "chunk_index": 5,
  "received_hash": "<hex-sha256>",
  "verified": true
}
```

**Errors:** `400` (hash mismatch), `409` (chunk already uploaded), `413` (chunk too large)

---

### `GET /api/v1/attachments/{attachment_id}/missing-chunks`

Get list of chunks not yet uploaded (for resume after interruption).

**Response: `200 OK`**
```json
{
  "attachment_id": "uuid",
  "total_chunks": 16,
  "received_chunks": 10,
  "missing_indices": [5, 8, 11, 12, 14, 15]
}
```

---

### `POST /api/v1/attachments/{attachment_id}/complete`

Signal that all chunks are uploaded; server verifies completeness.

**Request:**
```json
{
  "final_hash": "<hex-sha256>",
  "signature": "<base64>"
}
```

**Response: `200 OK`**
```json
{
  "attachment_id": "uuid",
  "status": "COMPLETE",
  "verified": true
}
```

**Errors:** `400` (missing chunks), `400` (hash mismatch)

---

## 5. Relay Endpoints

### `POST /api/v1/relays/register`

Register a Nostr or WebSocket relay endpoint.

**Request:**
```json
{
  "relay_url": "wss://relay.example.com",
  "relay_type": "NOSTR",
  "capabilities": ["NIP-01", "NIP-04", "NIP-44"],
  "max_event_size": 65536,
  "signature": "<base64>"
}
```

**Response: `201 Created`**

---

### `GET /api/v1/relays`

List known relays.

**Query params:** `type` (NOSTR | WEBSOCKET), `limit`, `offset`

**Response: `200 OK`**
```json
{
  "relays": [
    {
      "relay_id": "uuid",
      "relay_url": "wss://relay.example.com",
      "relay_type": "NOSTR",
      "last_seen": "2026-09-03T12:00:00Z",
      "status": "ACTIVE"
    }
  ]
}
```

---

## 6. WebSocket Relay

### `WS /api/v1/ws/relay`

Real-time encrypted envelope relay.

**Connection:**
1. Client connects with `Authorization` header
2. Server verifies device authentication
3. Bidirectional envelope exchange

**Client → Server messages:**
```json
{
  "type": "ENVELOPE",
  "data": {
    "envelope_id": "uuid",
    "recipient_fingerprint": "...",
    "encrypted_payload": "<base64>",
    "signature": "<base64>"
  }
}
```

**Server → Client messages:**
```json
{
  "type": "ENVELOPE",
  "data": { ... }
}
```

```json
{
  "type": "ACK",
  "data": {
    "envelope_id": "uuid",
    "status": "DELIVERED"
  }
}
```

**Heartbeat:** Client sends `{"type": "PING"}` every 30 seconds. Server responds `{"type": "PONG"}`.

---

## 7. Health Endpoints

### `GET /health`

**Response: `200 OK`**
```json
{
  "status": "healthy",
  "version": "0.1.0",
  "uptime_seconds": 3600
}
```

### `GET /ready`

**Response: `200 OK`** when database is connected and migrations are current.  
**Response: `503 Service Unavailable`** otherwise.

---

## 8. Admin Endpoints (RBAC Protected)

### `GET /api/v1/admin/stats`

Server statistics (admin role required).

### `DELETE /api/v1/admin/devices/{fingerprint}`

Revoke/block a device (admin role required).

### `GET /api/v1/admin/audit-log`

Query audit events (admin role required).

---

## 9. Pagination

All list endpoints use cursor-based pagination:

```
GET /api/v1/envelopes/pending?limit=50&after=<last_envelope_id>
```

Response includes `has_more` and `cursor` for next page.

## 10. Privacy Guarantees

| Data | Server Access |
|------|-------------|
| Message plaintext | ❌ Never |
| Attachment content | ❌ Never (encrypted blobs only) |
| Private keys | ❌ Never |
| Device fingerprints | ✅ Public identifiers |
| Public keys | ✅ Key directory |
| Envelope ciphertext | ✅ Stores for relay (cannot decrypt) |
| IP addresses | ✅ Visible in server logs (use Tor to hide) |
| Request timing | ✅ Observable (use Tor to reduce) |
