from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT / ".env",
        extra="ignore",
        hide_input_in_errors=True,
    )

    oss_endpoint: str = ""
    oss_bucket: str = ""
    oss_access_key_id: SecretStr = SecretStr("")
    oss_access_key_secret: SecretStr = SecretStr("")
    oss_security_token: SecretStr = SecretStr("")
    oss_prefix: str = ""
    note_oss_prefix: str = ""
    auth_username: str = ""
    auth_password_hash: SecretStr = SecretStr("")
    jwt_secret_key: SecretStr = SecretStr("")
    jwt_expire_minutes: int = 1440  # 24 hours
    port: int = Field(default=8700, ge=1, le=65535)

    @field_validator("oss_endpoint")
    @classmethod
    def validate_endpoint(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if not value:
            return value
        try:
            parsed = urlsplit(value if "://" in value else f"https://{value}")
            parsed.port
        except ValueError:
            raise ValueError("OSS_ENDPOINT must be a valid HTTPS endpoint") from None
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or any(char.isspace() or ord(char) < 32 for char in value)
        ):
            raise ValueError("OSS_ENDPOINT must be an HTTPS endpoint without a path or credentials")
        return value

    @field_validator("oss_prefix", "note_oss_prefix")
    @classmethod
    def validate_prefix(cls, value: str, info: ValidationInfo) -> str:
        variable_name = info.field_name.upper()
        value = value.strip()
        if (
            "\\" in value
            or any(part in {".", ".."} for part in value.split("/"))
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
        ):
            raise ValueError(f"{variable_name} must not contain traversal or control characters")
        normalized = value.strip("/")
        if len(normalized.encode("utf-8")) > 1022:
            raise ValueError(f"{variable_name} is too long")
        return f"{normalized}/" if normalized else ""

    @property
    def auth_configured(self) -> bool:
        """认证是否已配置（用户名、密码哈希、JWT 密钥均非空）。"""
        return bool(
            self.auth_username
            and self.auth_password_hash.get_secret_value()
            and self.jwt_secret_key.get_secret_value()
        )

    @property
    def oss_missing(self) -> list[str]:
        values = {
            "OSS_ENDPOINT": self.oss_endpoint,
            "OSS_BUCKET": self.oss_bucket,
            "OSS_ACCESS_KEY_ID": self.oss_access_key_id.get_secret_value(),
            "OSS_ACCESS_KEY_SECRET": self.oss_access_key_secret.get_secret_value(),
        }
        return [name for name, value in values.items() if not value.strip()]

    @property
    def frontend_path(self) -> Path:
        return ROOT / "frontend" / "dist"


settings = Settings()
