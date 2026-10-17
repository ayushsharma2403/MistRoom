"""Configuration and constants for MistRoom."""
import os
from pathlib import Path

PORT = int(os.getenv("PORT", 3001))
MYSQL_HOST = os.getenv("MYSQL_HOST")
MYSQL_PORT = int(os.getenv("MYSQL_PORT", 3306))
MYSQL_USER = os.getenv("MYSQL_USER", "mistroom_user")
MYSQL_PASSWORD = os.getenv("MYSQL_PASSWORD", "mistroom_pass")
MYSQL_DATABASE = os.getenv("MYSQL_DATABASE", "mistroom")

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
