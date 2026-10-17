"""Unit tests for offline serverless QR / text pairing logic."""
import hashlib
import json
import pytest


def compute_pairing_code_py(offer_sdp: str, answer_sdp: str) -> str:
    combined = (offer_sdp + answer_sdp).encode("utf-8")
    h = hashlib.sha256(combined).digest()
    num = int.from_bytes(h[0:4], byteorder="big") % 1000000
    return f"{num:06d}"


def test_pairing_code_derivation_deterministic():
    offer_sdp = "v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
    answer_sdp = "v=0\r\no=- 67890 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
    code1 = compute_pairing_code_py(offer_sdp, answer_sdp)
    code2 = compute_pairing_code_py(offer_sdp, answer_sdp)
    assert code1 == code2
    assert len(code1) == 6
    assert code1.isdigit()


def test_pairing_code_mismatch_detection():
    offer_sdp = "v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
    answer_sdp_original = "v=0\r\no=- 67890 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
    answer_sdp_tampered = "v=0\r\no=- 99999 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
    code_valid = compute_pairing_code_py(offer_sdp, answer_sdp_original)
    code_tampered = compute_pairing_code_py(offer_sdp, answer_sdp_tampered)
    assert code_valid != code_tampered


def test_frame_chunking_and_reassembly():
    """Verify that payloads longer than maxChunk are split into MIST:k:n:chunk and reassembled."""
    payload = "A" * 2500
    max_chunk = 800
    chunks = []
    for i in range(0, len(payload), max_chunk):
        chunks.append(payload[i:i + max_chunk])
    total = len(chunks)
    assert total == 4

    frames = [f"MIST:{idx + 1}:{total}:{chunk}" for idx, chunk in enumerate(chunks)]

    # Reassemble in arbitrary order
    received = {}
    for frame in reversed(frames):
        parts = frame.split(":", 3)
        k = int(parts[1])
        n = int(parts[2])
        data = parts[3]
        received[k] = data

    assert len(received) == total
    reassembled = "".join(received[i] for i in range(1, total + 1))
    assert reassembled == payload
