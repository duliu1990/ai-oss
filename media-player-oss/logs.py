"""Server-side logging with credential redaction; the web UI only receives safe_error() text."""

from __future__ import annotations

import logging
import re
import sys

from config import Settings

FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"

_SECRET_PARAMS = re.compile(
    r"(?i)\b(OSSAccessKeyId|Signature|security-token|x-oss-security-token|"
    r"x-oss-credential|x-oss-signature|access[_-]?key[_-]?secret)"
    r"(\s*[=:]\s*)[^&\s,;'\"]+"
)
_AUTH_HEADER = re.compile(r"(?i)\b(Authorization)(\s*[=:]\s*)[^\n,;'\"]+")
_ACCESS_KEY = re.compile(r"\bLTAI[0-9A-Za-z]{12,}\b")


def redact(text: str) -> str:
    text = _AUTH_HEADER.sub(r"\1\2[已隐藏]", text)
    text = _SECRET_PARAMS.sub(r"\1\2[已隐藏]", text)
    text = _ACCESS_KEY.sub("LTAI[已隐藏]", text)
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", " ", text)


def describe_error(exc: BaseException, limit: int = 2000) -> str:
    text = redact(str(exc)).strip() or "(无错误信息)"
    if len(text) > limit:
        text = text[:limit] + "…[已截断]"
    return f"{type(exc).__name__}: {text}"


class RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return redact(super().format(record))


def setup_logging(settings: Settings, stream=None) -> logging.Logger:
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, "_media_player", False):
            root.removeHandler(handler)
            handler.close()
    handler = logging.StreamHandler(stream or sys.stderr)
    handler.setFormatter(RedactingFormatter(FORMAT))
    handler._media_player = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    root.setLevel(settings.log_level)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True
    # SDK debug output may echo signed request headers.
    for name in ("urllib3", "oss2"):
        logging.getLogger(name).setLevel(logging.WARNING)
    return root
