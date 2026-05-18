import os
from pathlib import Path
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """Configuration class for application settings."""

    # Base directory for the project
    BASE_DIR: Path = Path(__file__).resolve().parent.parent

    # Database and Security
    DATABASE_URL: str = f"sqlite:///{BASE_DIR / 'data' / 'photolog_data.db'}"
    SECRET_KEY: str = os.getenv("SECRET_KEY")
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    COOKIE_NAME: str = "access_token"

    # Image and Upload settings
    FRONTPAGE_PHOTO_COUNT: int = 30
    MAX_FILE_SIZE: int = 15 * 1024 * 1024  # 15 MB
    MAX_DIMENSION: int = 3200
    MAX_UPLOADS_PER_DAY: int = 1
    TIMEZONE: str = "Europe/Berlin"
    UPLOAD_FOLDER: Path = BASE_DIR / "uploads"

    class Config:
        env_file = ".env"  # Load environment variables from .env, if present

    def setup_directories(self):
        """Ensures that required directories exist."""
        directories = [self.UPLOAD_FOLDER, self.BASE_DIR / "data"]
        for directory in directories:
            directory.mkdir(parents=True, exist_ok=True)
            os.chmod(directory, 0o750)  # Secure permissions


@lru_cache()
def get_settings() -> Settings:
    """Cached instance of settings."""
    settings = Settings()
    settings.setup_directories()
    return settings
