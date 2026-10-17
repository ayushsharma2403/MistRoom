"""Configuration and constants for MistRoom."""
import os
from pathlib import Path

PORT = int(os.getenv("PORT", 3001))

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
