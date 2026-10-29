import re
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent
DEV_ORIGIN = "http://127.0.0.1:5173"
_HOST = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore", hide_input_in_errors=True)

    oss_endpoint: str = ""
    oss_bucket: str = ""
    oss_access_key_id: SecretStr = SecretStr("")
    oss_access_key_secret: SecretStr = SecretStr("")
    oss_security_token: SecretStr = SecretStr("")
    oss_prefix: str = "media/"
    library_file: str = "data/library.json"
    log_level: str = "INFO"
    allowed_hosts: list[str] = Field(default_factory=lambda: ["localhost", "127.0.0.1"], min_length=1)
    allowed_origins: list[str] = Field(default_factory=list)
    enable_dev_origin: bool = False
    frontend_dist: str = "frontend/dist"

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

    @field_validator("oss_endpoint")
    @classmethod
    def validate_endpoint(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if value:
            parsed = urlsplit(value if "://" in value else "https://" + value)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError("OSS_ENDPOINT 必须是无用户名和密码的 HTTPS 地址")
            if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
                raise ValueError("OSS_ENDPOINT 不能带路径、查询参数或片段")
        return value

    @field_validator("oss_prefix")
    @classmethod
    def validate_prefix(cls, value: str) -> str:
        if ".." in value.split("/") or "\\" in value or any(ord(c) < 32 for c in value):
            raise ValueError("OSS_PREFIX 不能包含路径跳转或控制字符")
        return value.strip("/") + "/" if value.strip("/") else ""

    @field_validator("library_file", "frontend_dist")
    @classmethod
    def validate_library_file(cls, value: str) -> str:
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
    def oss_missing(self) -> list[str]:
        values = {
            "OSS_ENDPOINT": self.oss_endpoint,
            "OSS_BUCKET": self.oss_bucket,
            "OSS_ACCESS_KEY_ID": self.oss_access_key_id.get_secret_value(),
            "OSS_ACCESS_KEY_SECRET": self.oss_access_key_secret.get_secret_value(),
        }
        return [key for key, value in values.items() if not value.strip()]

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
