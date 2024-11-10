import os
from pathlib import Path
from pydantic_settings import BaseSettings
from functools import lru_cache
from dotenv import load_dotenv

# Define the base directory as the project root
BASE_DIR = Path(__file__).resolve().parent.parent

# Load the .env file from the project root to set DEV_MODE
load_dotenv(dotenv_path=BASE_DIR / ".env")

# Determine if we're in development mode
DEV_MODE = os.getenv("DEV_MODE", "False").lower() == "true"
ENV_FILE = BASE_DIR / ".env" if DEV_MODE else Path.home() / "data" / "photolog" / ".env"

# Load environment variables from the specific environment file
load_dotenv(dotenv_path=ENV_FILE)

class Settings(BaseSettings):
    """Configuration class for application settings."""
    
    # Development mode
    DEV_MODE: bool = DEV_MODE

    # Base paths for dev and production
    BASE_DIR: Path = BASE_DIR
    PROD_BASE_PATH: Path = Path.home() / "data" / "photolog"
    
    # Database configuration
    DATABASE_URL: str
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    COOKIE_NAME: str = "access_token"
    
    # Image and Upload settings
    IMAGES_PER_PAGE: int = 10
    ALLOWED_EXTENSIONS: set = {"jpg", "jpeg"}
    MAX_FILE_SIZE: int = 10 * 1024 * 1024  # 10 MB
    MAX_DIMENSION: int = 1600  # Max dimension for image resizing
    
    # Determine upload folder based on environment
    DEV_UPLOAD_PATH: Path = BASE_DIR / "data" / "uploads"
    PROD_UPLOAD_PATH: Path = PROD_BASE_PATH / "uploads"
    
    class Config:
        env_file = str(ENV_FILE)

    @property
    def UPLOAD_FOLDER(self) -> Path:
        upload_path = self.DEV_UPLOAD_PATH if DEV_MODE else self.PROD_UPLOAD_PATH
        upload_path.mkdir(parents=True, exist_ok=True)
        os.chmod(upload_path, 0o750)
        return upload_path

@lru_cache()
def get_settings() -> Settings:
    return Settings()
