# MistRoom — Decentralized Offline Mesh Messenger

> End-to-end encrypted, offline-first messaging over BLE mesh networks with optional Internet relay.

## Overview

MistRoom is an anonymous, decentralized messenger that works **without the Internet**. Devices communicate directly over Bluetooth Low Energy (BLE) and Wi-Fi Aware, forming ad-hoc mesh networks. An optional relay backend provides Internet connectivity for message delivery when peers are not in proximity.

### Privacy Guarantees

| Data | Server Access |
|------|---------------|
| Message plaintext | ❌ Never |
| Attachment content | ❌ Never (encrypted blobs only) |
| Private keys | ❌ Never |
| Device fingerprints | ✅ Public identifiers |
| Public keys | ✅ Key directory |
| Envelope ciphertext | ✅ Stores for relay (cannot decrypt) |

### Architecture

```
┌─────────────────────┐     BLE / Wi-Fi Aware     ┌─────────────────────┐
│   Android Device A  │◄──────────────────────────►│   Android Device B  │
│                     │    Direct E2E Encrypted     │                     │
│  ┌───────────────┐  │                             │  ┌───────────────┐  │
│  │ Ed25519 Keys  │  │                             │  │ Ed25519 Keys  │  │
│  │ X25519  Keys  │  │                             │  │ X25519  Keys  │  │
│  │ AES-256-GCM   │  │                             │  │ AES-256-GCM   │  │
│  └───────────────┘  │                             │  └───────────────┘  │
└──────────┬──────────┘                             └──────────┬──────────┘
           │            Optional Internet Relay                │
           └──────────────────┐    ┌───────────────────────────┘
                              ▼    ▼
                    ┌──────────────────────┐
                    │   FastAPI Backend    │
                    │  (Encrypted Relay)   │
                    ├──────────────────────┤
                    │  MySQL 8 │ Redis 7   │
                    └──────────────────────┘
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Python 3.11+ / FastAPI / SQLAlchemy 2 (async) |
| Database | MySQL 8.0 (Docker) |
| Cache | Redis 7 (Docker) |
| Crypto | Ed25519 (signing), X25519 (key agreement), AES-256-GCM (encryption) |
| Backend Crypto | PyNaCl, cryptography |
| Android | Kotlin, Jetpack Compose, Hilt, Room *(planned)* |
| Containerization | Docker Compose |

## Prerequisites

- **Docker** ≥ 24.0 and **Docker Compose** ≥ 2.0
- **Python** ≥ 3.11 (for local development without Docker)
- **Git**

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/ayushsharma2403/MistRoom.git
cd MistRoom
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your secrets (especially APP_SECRET_KEY and ADMIN_API_KEY)
```

### 3. Start all services

```bash
docker compose up -d
```

This starts:
- **API server** at `http://localhost:8000`
- **MySQL** at `localhost:3306`
- **Redis** at `localhost:6379`

### 4. Verify

```bash
# Health check
curl http://localhost:8000/health

# Readiness check (verifies DB + Redis)
curl http://localhost:8000/ready

# Interactive API docs
open http://localhost:8000/docs
```

## Local Development (without Docker)

```bash
cd backend

# Create virtual environment
python -m venv .venv
source .venv/bin/activate   # Linux/Mac
# .venv\Scripts\activate    # Windows

# Install dependencies
pip install -e ".[dev]"

# Set environment variables (or use .env file)
export MYSQL_HOST=localhost
export REDIS_HOST=localhost

# Run database migrations
alembic upgrade head

# Start development server
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## API Documentation

Full API spec: [`docs/api.md`](docs/api.md)

### Key Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/ready` | GET | No | Readiness check |
| `/api/v1/devices/register` | POST | No | Register a new device |
| `/api/v1/devices/{fingerprint}` | GET | No | Look up device public keys |
| `/api/v1/devices/rotate-key` | POST | Yes | Rotate X25519 key pair |
| `/api/v1/envelopes` | POST | Yes | Submit encrypted envelope |
| `/api/v1/envelopes/pending` | GET | Yes | Retrieve pending envelopes |
| `/api/v1/envelopes/{id}/receipt` | POST | Yes | Acknowledge delivery |
| `/api/v1/ws/relay` | WS | Yes | Real-time envelope relay |
| `/api/v1/attachments` | POST | Yes | Create attachment transfer |
| `/api/v1/admin/stats` | GET | Admin | Server statistics |

### Authentication

Most endpoints require Ed25519 device authentication:

```
Authorization: MistRoom <fingerprint>:<timestamp_ms>:<base64_signature>
```

Where `signature = Ed25519_sign(private_key, fingerprint + timestamp + method + path)`

## Running Tests

```bash
cd backend
pip install -e ".[dev]"
pytest tests/ -v
```

With coverage:

```bash
pytest tests/ -v --cov=app --cov-report=term-missing
```

## Project Structure

```
MistRoom/
├── backend/                    # FastAPI relay server
│   ├── app/
│   │   ├── api/v1/           # API endpoint routers
│   │   │   ├── admin.py      # Admin endpoints
│   │   │   ├── attachments.py # Chunked attachment uploads
│   │   │   ├── devices.py    # Device registration & key directory
│   │   │   ├── envelopes.py  # Encrypted envelope relay
│   │   │   ├── relays.py     # Relay registry
│   │   │   └── websocket.py  # Real-time WebSocket relay
│   │   ├── core/
│   │   │   ├── auth.py       # Ed25519 authentication
│   │   │   ├── audit.py      # Audit event logging
│   │   │   ├── config.py     # Application settings
│   │   │   ├── logging.py    # Structured logging with redaction
│   │   │   └── rate_limit.py # Redis-backed rate limiting
│   │   ├── db/               # Database session & base
│   │   ├── models/           # SQLAlchemy ORM models
│   │   └── schemas/          # Pydantic request/response schemas
│   ├── alembic/              # Database migrations
│   └── tests/                # pytest test suite
├── docs/
│   ├── api.md                # REST API specification
│   ├── architecture.md       # System architecture
│   ├── protocol.md           # Wire protocol specification
│   ├── threat-model.md       # Security threat model
│   └── implementation-plan.md # Phased delivery plan
├── infrastructure/           # Docker & deployment configs
├── android/                  # Android app (planned)
├── frontend/                 # Web frontend (planned)
├── docker-compose.yml
└── .env.example
```

## Design Documents

- [Architecture](docs/architecture.md) — System design, transport layers, crypto primitives
- [Protocol](docs/protocol.md) — Wire format, handshake, mesh routing
- [Threat Model](docs/threat-model.md) — Security analysis, attack vectors, mitigations
- [API Specification](docs/api.md) — REST and WebSocket API reference
- [Implementation Plan](docs/implementation-plan.md) — Phased roadmap

## License

MIT
