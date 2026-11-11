import re
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
DEV_ORIGIN = "http://127.0.0.1:5173"
_HOST = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*")


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
    # Each module owns one prefix inside the shared bucket.
    oss_prefix: str = "driver/"
    note_oss_prefix: str = "my-note/"
    media_oss_prefix: str = "media/"
    library_file: str = "data/library.json"
    log_level: str = "INFO"
    port: int = Field(default=8790, ge=1, le=65535)
    allowed_hosts: list[str] = Field(default_factory=lambda: ["localhost", "127.0.0.1"], min_length=1)
    # Capacitor iOS serves the bundled frontend from capacitor://localhost and Android from https://localhost.
    allowed_origins: list[str] = Field(default_factory=lambda: ["capacitor://localhost", "https://localhost"])
    enable_dev_origin: bool = False
    # Sibling Web build for single-port local runs; point elsewhere (or at nothing) for API-only deployments.
    frontend_dist: str = "../frontend/dist"
    auth_username: str = ""
    auth_password_hash: SecretStr = SecretStr("")
    jwt_secret_key: SecretStr = SecretStr("")
    jwt_expire_minutes: int = Field(default=1440, ge=1, le=43200)

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

    @field_validator("oss_prefix", "note_oss_prefix", "media_oss_prefix")
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

    @field_validator("auth_username")
    @classmethod
    def validate_auth_username(cls, value: str) -> str:
        value = value.strip()
        if len(value) > 100 or any(ord(c) < 32 for c in value):
            raise ValueError("AUTH_USERNAME 不能超过 100 字符或包含控制字符")
        return value

    @field_validator("jwt_secret_key")
    @classmethod
    def validate_jwt_secret(cls, value: SecretStr) -> SecretStr:
        # PyJWT warns below 32 bytes; reject weak secrets instead of signing with them.
        secret = value.get_secret_value()
        if secret and len(secret.encode("utf-8")) < 32:
            raise ValueError("JWT_SECRET_KEY 至少需要 32 字节，请用 secrets.token_urlsafe(32) 生成")
        return value

    @field_validator("allowed_hosts")
    @classmethod
    def validate_allowed_hosts(cls, values: list[str]) -> list[str]:
        hosts = [value.strip().lower() for value in values]
        if any(len(host) > 253 or not _HOST.fullmatch(host) for host in hosts):
            raise ValueError(
                "ALLOWED_HOSTS requires exact DNS names or IPv4 addresses without ports or wildcards"
            )
        return list(dict.fromkeys(hosts))

    @field_validator("allowed_origins")
    @classmethod
    def validate_allowed_origins(cls, values: list[str]) -> list[str]:
        origins = []
        for value in values:
            value = value.strip()
            if value == "capacitor://localhost":
                origins.append(value)
                continue
            parsed = urlsplit(value)
            host = parsed.hostname or ""
            if (
                parsed.scheme not in {"http", "https"}
                or len(host) > 253
                or not _HOST.fullmatch(host)
                or parsed.username is not None
                or parsed.password is not None
                or value != f"{parsed.scheme}://{parsed.netloc}"
            ):
                raise ValueError("ALLOWED_ORIGINS requires exact HTTP(S) origins or capacitor://localhost")
            port = parsed.port
            if port == 0:
                raise ValueError("ALLOWED_ORIGINS ports must be between 1 and 65535")
            default_port = 80 if parsed.scheme == "http" else 443
            authority = host if port is None or port == default_port else f"{host}:{port}"
            if value != f"{parsed.scheme}://{authority}":
                raise ValueError("ALLOWED_ORIGINS must use lowercase hosts and omit default ports")
            origins.append(value)
        return list(dict.fromkeys(origins))

    @field_validator("library_file", "frontend_dist")
    @classmethod
    def validate_file_path(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(c) < 32 for c in value):
            raise ValueError("File paths must not be empty or contain control characters")
        return value

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, value: str) -> str:
        value = value.strip().upper()
        if value not in {"DEBUG", "INFO", "WARNING", "ERROR"}:
            raise ValueError("LOG_LEVEL 只能是 DEBUG、INFO、WARNING 或 ERROR")
        return value

    @property
    def auth_configured(self) -> bool:
        """True only when a complete login credential set is present."""
        return not self.auth_missing

    @property
    def auth_missing(self) -> list[str]:
        values = {
            "AUTH_USERNAME": self.auth_username,
            "AUTH_PASSWORD_HASH": self.auth_password_hash.get_secret_value(),
            "JWT_SECRET_KEY": self.jwt_secret_key.get_secret_value(),
        }
        return [key for key, value in values.items() if not value.strip()]

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
    def library_path(self) -> Path:
        path = Path(self.library_file).expanduser()
        return path if path.is_absolute() else ROOT / path

    @property
    def frontend_path(self) -> Path:
        path = Path(self.frontend_dist).expanduser()
        return path if path.is_absolute() else ROOT / path

    @property
    def cors_origins(self) -> list[str]:
        origins = [*self.allowed_origins]
        if self.enable_dev_origin and DEV_ORIGIN not in origins:
            origins.append(DEV_ORIGIN)
        return origins


settings = Settings()
