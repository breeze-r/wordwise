import logging
import secrets
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


logger = logging.getLogger(__name__)
BASE_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        env_prefix="WORDWISE_",
        extra="ignore",
    )

    database_url: str = "sqlite+aiosqlite:///./wordwise.db"
    jwt_secret_key: str | None = None
    jwt_algorithm: str = "HS256"
    access_token_expire_days: int = 30
    test_session_expire_minutes: int = 30
    translator_api_key: str | None = None
    translator_api_url: str = ""
    translator_model: str = ""
    translator_mode: str = "hybrid"
    local_wordbook_path: str = str(BASE_DIR / "data" / "ielts_wordbook.json")
    local_dictionary_db_path: str = str(BASE_DIR / "data" / "ecdict.db")
    local_dictionary_csv_path: str = str(BASE_DIR / "data" / "ecdict.csv")


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if not settings.jwt_secret_key:
        settings.jwt_secret_key = secrets.token_urlsafe(48)
        logger.warning(
            "WORDWISE_JWT_SECRET_KEY is not set; generated an ephemeral key for this process."
        )
    return settings
