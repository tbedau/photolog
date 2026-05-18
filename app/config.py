import os
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """Configuration class for application settings."""

    BASE_DIR: Path = Path(__file__).resolve().parent.parent

    # Database + auth
    DATABASE_URL: str = f"sqlite:///{BASE_DIR / 'data' / 'photolog_data.db'}"
    SECRET_KEY: str = Field(..., min_length=32)
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30

    # "production" requires HTTPS and uses the __Host- cookie prefix; "development"
    # over plain HTTP localhost cannot, because the prefix demands Secure.
    ENVIRONMENT: Literal["production", "development"] = "production"

    # Hosts we'll accept in the Host header. Defense against host-header injection.
    ALLOWED_HOSTS: tuple[str, ...] = (
        "photolog.tillmannbedau.com",
        "localhost",
        "127.0.0.1",
        "testserver",
    )

    # Image + upload
    FRONTPAGE_PHOTO_COUNT: int = 30
    MAX_FILE_SIZE: int = 15 * 1024 * 1024
    MAX_DIMENSION: int = 3200
    MAX_UPLOADS_PER_DAY: int = 1
    TIMEZONE: str = "Europe/Berlin"
    UPLOAD_FOLDER: Path = BASE_DIR / "uploads"

    class Config:
        env_file = ".env"

    @field_validator("SECRET_KEY")
    @classmethod
    def _reject_placeholder_secret(cls, v: str) -> str:
        if v.lower() in {"changeme", "secret", "dev", "test"}:
            raise ValueError("SECRET_KEY is a placeholder value")
        return v

    @property
    def cookie_secure(self) -> bool:
        return self.ENVIRONMENT == "production"

    @property
    def cookie_name(self) -> str:
        # `__Host-` enforces Secure + no Domain + Path=/. Only usable over HTTPS,
        # so dev (HTTP) falls back to a plain name.
        return "__Host-access_token" if self.cookie_secure else "access_token"

    def setup_directories(self):
        for directory in (self.UPLOAD_FOLDER, self.BASE_DIR / "data"):
            directory.mkdir(parents=True, exist_ok=True)
            os.chmod(directory, 0o750)


@lru_cache()
def get_settings() -> Settings:
    settings = Settings()
    settings.setup_directories()
    return settings
