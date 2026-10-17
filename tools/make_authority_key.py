#!/usr/bin/env python3
"""Generate an Ed25519 keypair for an authority."""
import argparse
import base64
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization


def main():
    parser = argparse.ArgumentParser(description="Generate an authority Ed25519 keypair")
    parser.add_argument("--out", default="authority.key", help="Output private key path")
    parser.add_argument("--pub-out", default=None, help="Optional output public key path")
    args = parser.parse_args()

    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key()

    priv_bytes = priv.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption()
    )
    pub_bytes = pub.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw
    )

    with open(args.out, "wb") as f:
        f.write(priv_bytes)

    pub_path = args.pub_out or (args.out + ".pub")
    pub_b64 = base64.b64encode(pub_bytes).decode("ascii")
    with open(pub_path, "w", encoding="utf-8") as f:
        f.write(pub_b64 + "\n")

    print(f"Generated authority private key: {args.out}")
    print(f"Authority public key ({pub_path}): {pub_b64}")


if __name__ == "__main__":
    main()
