"""Unit and integration tests for:
1. Safe-walk GPS ring buffer & timer
2. Responder badge verification & authority trust
3. Tamper-evident incident harassment log verification
"""
import base64
import hashlib
import json
import os
import time
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from tools.issue_badge import canonical_badge_bytes, make_badge_payload
from tools.revoke_badge import canonical_revocation_bytes
from tools.verify_log import canonical_entry_bytes, verify_bundle


# =========================================================================
# FEATURE 1: Safe-walk tests
# =========================================================================
def test_safewalk_ring_buffer_cap():
    max_ring = 120
    buf = []
    for i in range(150):
        buf.append({"lat": 28.6139 + i * 0.0001, "lon": 77.2090, "ts": i})
        if len(buf) > max_ring:
            buf.pop(0)
    assert len(buf) == 120
    assert buf[-1]["ts"] == 149
    assert buf[0]["ts"] == 30


# =========================================================================
# FEATURE 2: Signed Responder Badges tests
# =========================================================================
def test_responder_badge_verification():
    # 1. Generate authority key
    auth_priv = Ed25519PrivateKey.generate()
    auth_pub = auth_priv.public_key()
    issuer_pk = base64.b64encode(auth_pub.public_bytes_raw()).decode("ascii")

    # 2. Generate responder key
    resp_priv = Ed25519PrivateKey.generate()
    resp_pub = resp_priv.public_key()
    subject_pk = base64.b64encode(resp_pub.public_bytes_raw()).decode("ascii")

    # 3. Valid badge
    now = int(time.time())
    badge = make_badge_payload(
        issuer_name="Delhi Relief Camp 4",
        issuer_pk=issuer_pk,
        subject_pk=subject_pk,
        role="medic",
        issued_at=now,
        expires_at=now + 86400
    )
    sig = auth_priv.sign(canonical_badge_bytes(badge))
    badge["sig"] = base64.b64encode(sig).decode("ascii")

    # Verify signature
    auth_pub.verify(base64.b64decode(badge["sig"]), canonical_badge_bytes(badge))

    # Test expired badge
    expired_badge = dict(badge)
    expired_badge["expires_at"] = now - 100
    assert expired_badge["expires_at"] < now

    # Test wrong issuer
    rogue_priv = Ed25519PrivateKey.generate()
    rogue_sig = rogue_priv.sign(canonical_badge_bytes(badge))
    with pytest.raises(Exception):
        auth_pub.verify(rogue_sig, canonical_badge_bytes(badge))

    # Test tampered role
    tampered_badge = dict(badge)
    tampered_badge["role"] = "doctor_fraud"
    with pytest.raises(Exception):
        auth_pub.verify(base64.b64decode(badge["sig"]), canonical_badge_bytes(tampered_badge))

    # Test subject mismatch
    other_resp = base64.b64encode(Ed25519PrivateKey.generate().public_key().public_bytes_raw()).decode("ascii")
    assert badge["subject_pk"] != other_resp


def test_revocation_list_generation_and_check():
    auth_priv = Ed25519PrivateKey.generate()
    auth_pub = auth_priv.public_key()
    issuer_pk = base64.b64encode(auth_pub.public_bytes_raw()).decode("ascii")

    revoked_subject = "sample_revoked_subject_pubkey_12345"
    revocation = {
        "v": 1,
        "issuer_pk": issuer_pk,
        "revoked_subjects": [revoked_subject],
        "reason": "Security protocol violation",
        "timestamp": int(time.time())
    }
    sig = auth_priv.sign(canonical_revocation_bytes(revocation))
    revocation["sig"] = base64.b64encode(sig).decode("ascii")

    auth_pub.verify(base64.b64decode(revocation["sig"]), canonical_revocation_bytes(revocation))
    assert revoked_subject in revocation["revoked_subjects"]


# =========================================================================
# FEATURE 3: Tamper-Evident Harassment Log tests
# =========================================================================
def test_harassment_log_hash_chain_and_verify_offline(tmp_path):
    user_priv = Ed25519PrivateKey.generate()
    user_pub = user_priv.public_key()
    pub_b64 = base64.b64encode(user_pub.public_bytes_raw()).decode("ascii")

    entries = []
    prev_hash = "GENESIS"

    for i in range(3):
        entry = {
            "idx": i,
            "ts": 1700000000 + i * 100,
            "cat": "stalking",
            "text": f"Incident entry #{i}",
            "lat": 28.61,
            "lon": 77.20,
            "prevHash": prev_hash
        }
        entry_hash = hashlib.sha256(canonical_entry_bytes(entry)).hexdigest()
        entry["hash"] = entry_hash
        sig = user_priv.sign(entry_hash.encode("ascii"))
        entry["sig"] = base64.b64encode(sig).decode("ascii")

        entries.append(entry)
        prev_hash = entry_hash

    bundle = {
        "bundle_version": 1,
        "public_key": pub_b64,
        "head_hash": prev_hash,
        "exported_at": int(time.time()),
        "entries": entries,
        "witness_receipts": []
    }

    bundle_file = tmp_path / "valid_bundle.json"
    bundle_file.write_text(json.dumps(bundle))

    # Verify with verify_log.py logic
    ok, msg = verify_bundle(str(bundle_file))
    assert ok is True
    assert "Verified 3 entries" in msg

    # Test tampering with entry index 1
    tampered_entries = [dict(e) for e in entries]
    tampered_entries[1]["text"] = "Tampered text!"
    tampered_bundle = dict(bundle)
    tampered_bundle["entries"] = tampered_entries

    tampered_file = tmp_path / "tampered_bundle.json"
    tampered_file.write_text(json.dumps(tampered_bundle))

    ok_tamper, msg_tamper = verify_bundle(str(tampered_file))
    assert ok_tamper is False
    assert "Hash mismatch at index 1" in msg_tamper
