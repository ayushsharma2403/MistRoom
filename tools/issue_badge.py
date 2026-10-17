#!/usr/bin/env python3
"""Issue a signed responder badge using an authority private key."""
import argparse
import base64
import json
import time
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def make_badge_payload(issuer_name, issuer_pk, subject_pk, role, issued_at, expires_at):
    return {
        "v": 1,
        "issuer_name": issuer_name,
        "issuer_pk": issuer_pk,
        "subject_pk": subject_pk,
        "role": role,
        "issued_at": issued_at,
        "expires_at": expires_at
    }


def canonical_badge_bytes(badge_dict):
    d = {k: badge_dict[k] for k in sorted(badge_dict.keys()) if k != "sig"}
    return json.dumps(d, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def main():
    parser = argparse.ArgumentParser(description="Issue a signed responder badge")
    parser.add_argument("--authority-key", required=True, help="Path to authority raw private key file")
    parser.add_argument("--name", required=True, help="Authority / Issuer organization name")
    parser.add_argument("--role", required=True, help="Responder role (e.g. medic, volunteer, coordinator)")
    parser.add_argument("--peer-pubkey", required=True, help="Subject's Ed25519 public key (Base64)")
    parser.add_argument("--expires", required=True, help="Expiration date (YYYY-MM-DD or Unix timestamp)")
    args = parser.parse_args()

    with open(args.authority_key, "rb") as f:
        priv_bytes = f.read()

    priv = Ed25519PrivateKey.from_private_bytes(priv_bytes)
    pub = priv.public_key()
    issuer_pk = base64.b64encode(pub.public_bytes_raw()).decode("ascii")

    issued_at = int(time.time())
    if args.expires.isdigit():
        expires_at = int(args.expires)
    else:
        # Parse YYYY-MM-DD
        from datetime import datetime, timezone
        dt = datetime.strptime(args.expires, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        expires_at = int(dt.timestamp())

    badge = make_badge_payload(
        issuer_name=args.name,
        issuer_pk=issuer_pk,
        subject_pk=args.peer_pubkey.strip(),
        role=args.role.strip(),
        issued_at=issued_at,
        expires_at=expires_at
    )

    data_to_sign = canonical_badge_bytes(badge)
    sig = priv.sign(data_to_sign)
    badge["sig"] = base64.b64encode(sig).decode("ascii")

    print(json.dumps(badge, indent=2))


if __name__ == "__main__":
    main()
