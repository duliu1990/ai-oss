from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    oss_endpoint: str = ""
    oss_bucket: str = ""
    oss_access_key_id: SecretStr = SecretStr("")
    oss_access_key_secret: SecretStr = SecretStr("")
    oss_security_token: SecretStr = SecretStr("")
    oss_prefix: str = "media/"
    signed_url_seconds: int = Field(default=300, ge=60, le=3600)
    ai_base_url: str = ""
    ai_api_key: SecretStr = SecretStr("")
    ai_model: str = ""
    max_file_mb: int = Field(default=500, ge=1, le=10000)
    max_storage_mb: int = Field(default=2000, ge=10, le=50000)
    max_queue: int = Field(default=5, ge=1, le=20)
    analyze_timeout_seconds: int = Field(default=90, ge=5, le=300)
    download_timeout_seconds: int = Field(default=1800, ge=10, le=14400)
    upload_timeout_seconds: int = Field(default=900, ge=10, le=7200)
    retention_hours: int = Field(default=24, ge=1, le=168)
    log_level: str = "INFO"
    log_file: str = ""

    @field_validator("oss_endpoint", "ai_base_url")
    @classmethod
    def validate_endpoint(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if value:
            parsed = urlsplit(value)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError("接口地址必须是无用户名和密码的 HTTPS URL")
            if parsed.query or parsed.fragment:
                raise ValueError("接口地址不能带查询参数或片段")
        return value

    @field_validator("oss_prefix")
    @classmethod
    def validate_prefix(cls, value: str) -> str:
        if ".." in value.split("/") or "\\" in value or any(ord(c) < 32 for c in value):
            raise ValueError("OSS_PREFIX 不能包含路径跳转或控制字符")
        return value.strip("/") + "/" if value.strip("/") else ""

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, value: str) -> str:
        value = value.strip().upper()
        if value not in {"DEBUG", "INFO", "WARNING", "ERROR"}:
            raise ValueError("LOG_LEVEL 只能是 DEBUG、INFO、WARNING 或 ERROR")
        return value

    @field_validator("log_file")
    @classmethod
    def validate_log_file(cls, value: str) -> str:
        value = value.strip()
        if value and any(ord(c) < 32 for c in value):
            raise ValueError("LOG_FILE 不能包含控制字符")
        return value

    @model_validator(mode="after")
    def validate_storage(self):
        if self.max_storage_mb < self.max_file_mb * 3:
            raise ValueError("MAX_STORAGE_MB 至少为 MAX_FILE_MB 的三倍，以容纳转码临时文件")
        return self

    @property
    def oss_missing(self) -> list[str]:
        values = {
            "OSS_ENDPOINT": self.oss_endpoint,
            "OSS_BUCKET": self.oss_bucket,
            "OSS_ACCESS_KEY_ID": self.oss_access_key_id.get_secret_value(),
            "OSS_ACCESS_KEY_SECRET": self.oss_access_key_secret.get_secret_value(),
        }
        return [key for key, value in values.items() if not value.strip()]

    @property
    def ai_enabled(self) -> bool:
        return bool(self.ai_base_url and self.ai_api_key.get_secret_value() and self.ai_model)


settings = Settings()
