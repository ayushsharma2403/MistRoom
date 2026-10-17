#!/usr/bin/env python3
"""Offline verification tool for exported incident logs."""
import argparse
import base64
import hashlib
import json
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def canonical_entry_bytes(entry_dict):
    keys = sorted([k for k in entry_dict.keys() if k not in ("hash", "sig")])
    d = {k: entry_dict[k] for k in keys}
    return json.dumps(d, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def verify_bundle(bundle_path):
    with open(bundle_path, "r", encoding="utf-8") as f:
        bundle = json.load(f)

    entries = bundle.get("entries", [])
    pub_key_b64 = bundle.get("public_key")
    head_hash = bundle.get("head_hash")
    witness_receipts = bundle.get("witness_receipts", [])

    if not pub_key_b64:
        return False, "Missing public_key in bundle"

    pub_bytes = base64.b64decode(pub_key_b64)
    pub = Ed25519PublicKey.from_public_bytes(pub_bytes)

    if not entries:
        return True, "Log is empty, verified successfully"

    prev_hash = "GENESIS"
    for i, entry in enumerate(entries):
        idx = entry.get("idx")
        if idx != i:
            return False, f"Entry index mismatch at {i}: got {idx}"

        if entry.get("prevHash") != prev_hash:
            return False, f"Broken chain link at index {i}: prevHash {entry.get('prevHash')} != expected {prev_hash}"

        expected_hash = hashlib.sha256(canonical_entry_bytes(entry)).hexdigest()
        if entry.get("hash") != expected_hash:
            return False, f"Hash mismatch at index {i}: got {entry.get('hash')} != computed {expected_hash}"

        sig_b64 = entry.get("sig")
        if not sig_b64:
            return False, f"Missing signature at index {i}"

        try:
            sig_bytes = base64.b64decode(sig_b64)
            pub.verify(sig_bytes, expected_hash.encode("ascii"))
        except Exception as e:
            return False, f"Invalid signature at index {i}: {e}"

        prev_hash = expected_hash

    if head_hash and prev_hash != head_hash:
        return False, f"Head hash mismatch: got {head_hash} != calculated {prev_hash}"

    # Verify witness receipts if any
    for w in witness_receipts:
        w_head = w.get("head_hash")
        w_pk = w.get("witness_pk")
        w_sig = w.get("sig")
        if w_head != head_hash:
            return False, f"Witness receipt witnessed different head hash: {w_head}"
        if w_pk and w_sig:
            try:
                w_pub = Ed25519PublicKey.from_public_bytes(base64.b64decode(w_pk))
                w_pub.verify(base64.b64decode(w_sig), f"WITNESS:{w_head}".encode("ascii"))
            except Exception as e:
                return False, f"Invalid witness signature: {e}"

    return True, f"OK - Verified {len(entries)} entries across tamper-evident chain"


def main():
    parser = argparse.ArgumentParser(description="Verify an exported incident log bundle")
    parser.add_argument("bundle", help="Path to exported log .json bundle")
    args = parser.parse_args()

    ok, msg = verify_bundle(args.bundle)
    if ok:
        print(f"VERIFICATION SUCCESS: {msg}")
    else:
        print(f"VERIFICATION FAILED: {msg}")
        exit(1)


if __name__ == "__main__":
    main()
