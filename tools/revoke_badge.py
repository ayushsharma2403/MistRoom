#!/usr/bin/env python3
"""Issue a signed revocation list or revoke a badge."""
import argparse
import base64
import json
import time
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def canonical_revocation_bytes(payload):
    d = {k: payload[k] for k in sorted(payload.keys()) if k != "sig"}
    return json.dumps(d, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def main():
    parser = argparse.ArgumentParser(description="Create a signed badge revocation list")
    parser.add_argument("--authority-key", required=True, help="Path to authority raw private key file")
    parser.add_argument("--revoked-pubkey", required=True, action="append", help="Subject pubkey(s) to revoke")
    parser.add_argument("--reason", default="Badge invalidated", help="Reason for revocation")
    args = parser.parse_args()

    with open(args.authority_key, "rb") as f:
        priv_bytes = f.read()

    priv = Ed25519PrivateKey.from_private_bytes(priv_bytes)
    pub = priv.public_key()
    issuer_pk = base64.b64encode(pub.public_bytes_raw()).decode("ascii")

    revocation_payload = {
        "v": 1,
        "issuer_pk": issuer_pk,
        "revoked_subjects": [pk.strip() for pk in args.revoked_pubkey],
        "reason": args.reason,
        "timestamp": int(time.time())
    }

    sig = priv.sign(canonical_revocation_bytes(revocation_payload))
    revocation_payload["sig"] = base64.b64encode(sig).decode("ascii")

    print(json.dumps(revocation_payload, indent=2))


if __name__ == "__main__":
    main()
