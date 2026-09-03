"""Application configuration via pydantic-settings."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All application settings, loaded from environment variables or .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # ── Application ───────────────────────────────────
    app_name: str = "MistRoom Relay API"
    app_version: str = "0.1.0"
    app_env: str = "development"
    app_debug: bool = True
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    app_secret_key: str = "CHANGE_ME"

    # ── CORS ──────────────────────────────────────────
    cors_origins: str = "http://localhost:3000,http://localhost:5173"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    # ── MySQL ─────────────────────────────────────────
    mysql_host: str = "localhost"
    mysql_port: int = 3306
    mysql_database: str = "mistroom"
    mysql_user: str = "mistroom"
    mysql_password: str = "mistroom_dev_pass"

    @property
    def database_url(self) -> str:
        return (
            f"mysql+aiomysql://{self.mysql_user}:{self.mysql_password}"
            f"@{self.mysql_host}:{self.mysql_port}/{self.mysql_database}"
        )

    @property
    def database_url_sync(self) -> str:
        """Synchronous URL for Alembic migrations."""
        return (
            f"mysql+pymysql://{self.mysql_user}:{self.mysql_password}"
            f"@{self.mysql_host}:{self.mysql_port}/{self.mysql_database}"
        )

    # ── Redis ─────────────────────────────────────────
    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_db: int = 0

    @property
    def redis_url(self) -> str:
        return f"redis://{self.redis_host}:{self.redis_port}/{self.redis_db}"

    # ── Rate Limiting ─────────────────────────────────
    rate_limit_per_minute: int = 100
    rate_limit_registration_per_hour: int = 5

    # ── Envelope / Attachment Limits ──────────────────
    max_envelope_size_bytes: int = 65536
    max_attachment_size_bytes: int = 524_288_000  # 500 MB
    max_chunk_size_bytes: int = 262_144  # 256 KB
    envelope_retention_hours: int = 168  # 7 days
    attachment_retention_hours: int = 720  # 30 days

    # ── Logging ───────────────────────────────────────
    log_level: str = "INFO"
    log_format: str = "json"

    # ── Admin ─────────────────────────────────────────
    admin_api_key: str = "CHANGE_ME"


settings = Settings()
