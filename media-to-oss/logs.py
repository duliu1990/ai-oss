"""Server-side logging. Raw errors go here; the web UI only ever sees safe_error() text."""

from __future__ import annotations

import logging
import re
import sys
from logging.handlers import RotatingFileHandler

from config import ROOT, Settings

FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"

# Credentials and signatures can appear in SDK/extractor messages; never write them to disk.
_SECRET_PARAMS = re.compile(
    r"(?i)\b(OSSAccessKeyId|Signature|security-token|x-oss-security-token|"
    r"x-oss-credential|x-oss-signature|api[_-]?key|access[_-]?key[_-]?secret)"
    r"(\s*[=:]\s*)[^&\s,;'\"]+"
)
# Authorization values contain spaces ("OSS <id>:<sig>", "Bearer <token>"); drop the whole value.
_AUTH_HEADER = re.compile(r"(?i)\b(Authorization)(\s*[=:]\s*)[^\n,;'\"]+")
_ACCESS_KEY = re.compile(r"\bLTAI[0-9A-Za-z]{12,}\b")
_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-]+")


def redact(text: str) -> str:
    text = _AUTH_HEADER.sub(r"\1\2[已隐藏]", text)
    text = _SECRET_PARAMS.sub(r"\1\2[已隐藏]", text)
    text = _BEARER.sub("Bearer [已隐藏]", text)
    text = _ACCESS_KEY.sub("LTAI[已隐藏]", text)
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", " ", text)


def describe_error(exc: BaseException, limit: int = 2000) -> str:
    """One-line, redacted description of an exception for the server log."""
    text = redact(str(exc)).strip() or "(无错误信息)"
    if len(text) > limit:
        text = text[:limit] + "…[已截断]"
    return f"{type(exc).__name__}: {text}"


class RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return redact(super().format(record))


def setup_logging(settings: Settings, stream=None) -> logging.Logger:
    """Configure the root logger once: stderr plus an optional rotating file."""
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, "_media_to_oss", False):
            root.removeHandler(handler)
            handler.close()
    formatter = RedactingFormatter(FORMAT)
    handlers: list[logging.Handler] = [logging.StreamHandler(stream or sys.stderr)]
    if settings.log_file:
        path = ROOT / settings.log_file if not settings.log_file.startswith("/") else settings.log_file
        handlers.append(RotatingFileHandler(path, maxBytes=10 * 1024 * 1024, backupCount=3, encoding="utf-8"))
    for handler in handlers:
        handler.setFormatter(formatter)
        handler._media_to_oss = True  # type: ignore[attr-defined]
        root.addHandler(handler)
    root.setLevel(settings.log_level)
    # Uvicorn installs its own handlers unless started with log_config=None; keep one output path.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True
    # Third-party HTTP stacks are noisy at DEBUG and may echo request URLs with signatures.
    for name in ("httpx", "httpcore", "urllib3", "oss2"):
        logging.getLogger(name).setLevel(logging.WARNING)
    return root
