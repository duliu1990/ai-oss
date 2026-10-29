"""Read-only OSS access: list audio under the configured prefix and proxy byte ranges for playback."""

from __future__ import annotations

import json
import logging
import math
import re
import threading
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import oss2

from config import Settings
from logs import describe_error
from security import UserError, safe_error

log = logging.getLogger("oss")

# SDK debug messages may contain signatures; keep them away from root handlers.
_sdk_logger = logging.getLogger("oss2")
_sdk_logger.addHandler(logging.NullHandler())
_sdk_logger.propagate = False

AUDIO_TYPES = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".oga": "audio/ogg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
}

CHUNK_SIZE = 64 * 1024
MAX_LIST_PAGES = 50  # 50 × 1000 objects; the UI reports when the cap is reached.
_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")

# Written by media-to-oss next to the uploads; the player only ever reads it.
CATALOG_NAME = "catalog.json"
MAX_CATALOG_BYTES = 8 * 1024 * 1024
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")


class CatalogError(Exception):
    pass


class RangeNotSatisfiable(Exception):
    def __init__(self, size: int | None):
        super().__init__("range not satisfiable")
        self.size = size


@dataclass
class AudioStream:
    status: int
    headers: dict[str, str]
    body: Iterator[bytes]


def object_prefix(settings: Settings) -> str:
    prefix = settings.oss_prefix.strip().strip("/")
    return f"{prefix}/" if prefix else ""


def catalog_key(settings: Settings) -> str:
    return f"{object_prefix(settings)}{CATALOG_NAME}"


def audio_type(key: str) -> str | None:
    return AUDIO_TYPES.get(Path(key).suffix.lower())


def validate_key(key: str) -> str:
    if (
        not isinstance(key, str)
        or not key
        or key.startswith("/")
        or "\\" in key
        or any(ord(c) < 32 or ord(c) == 127 for c in key)
        or any(part in {"", ".", ".."} for part in key.split("/"))
        or len(key.encode("utf-8")) > 1023
    ):
        raise UserError("OSS 对象路径无效。")
    return key


def ensure_audio_key(key: str, settings: Settings) -> str:
    """The browser may only read audio objects below the configured prefix."""
    key = validate_key(key)
    if not key.startswith(object_prefix(settings)):
        raise UserError("只能播放配置前缀下的 OSS 文件。")
    if audio_type(key) is None:
        raise UserError("不支持该音频格式。")
    return key


_bucket_lock = threading.Lock()
_bucket_cache: dict[int, oss2.Bucket] = {}


def get_bucket(settings: Settings) -> oss2.Bucket:
    """One Bucket per Settings object so the HTTP session keeps connections alive."""
    if settings.oss_missing:
        raise UserError("OSS 配置不完整：" + ", ".join(settings.oss_missing))
    with _bucket_lock:
        bucket = _bucket_cache.get(id(settings))
        if bucket is None:
            bucket = _make_bucket(settings)
            _bucket_cache[id(settings)] = bucket
        return bucket


def _make_bucket(settings: Settings) -> oss2.Bucket:
    endpoint = settings.oss_endpoint.strip()
    parsed = urlsplit(endpoint if "://" in endpoint else "https://" + endpoint)
    if not parsed.hostname:
        raise UserError("OSS Endpoint 无效。")
    # Credentials are only ever sent over HTTPS.
    endpoint = urlunsplit(("https", parsed.netloc, "", "", ""))
    access_id = settings.oss_access_key_id.get_secret_value()
    access_secret = settings.oss_access_key_secret.get_secret_value()
    token = settings.oss_security_token.get_secret_value()
    auth = oss2.StsAuth(access_id, access_secret, token) if token else oss2.Auth(access_id, access_secret)
    return oss2.Bucket(auth, endpoint, settings.oss_bucket, connect_timeout=30, enable_crc=False)


def _clean(value, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = " ".join(_CONTROL.sub(" ", value).split())[:limit]
    return value or None


def _catalog_info(value) -> dict:
    """Whitelist the display fields of one catalog entry; anything malformed is dropped."""
    if not isinstance(value, dict):
        return {}
    duration = value.get("duration")
    if isinstance(duration, bool) or not isinstance(duration, int | float) or not math.isfinite(duration):
        duration = None
    elif not 0 <= duration < 10**7:
        duration = None
    info = {
        "title": _clean(value.get("title"), 200),
        "artist": _clean(value.get("artist"), 200),
        "duration": duration,
        "source": _clean(value.get("source"), 100),
        "source_host": _clean(value.get("source_host"), 253),
    }
    return {name: item for name, item in info.items() if item is not None}


def read_catalog(bucket, key: str) -> dict[str, dict]:
    """Return the catalog's files map; a missing catalog is empty, a broken one raises CatalogError."""
    try:
        result = bucket.get_object(key)
    except oss2.exceptions.NoSuchKey:
        return {}
    try:
        if (result.content_length or 0) > MAX_CATALOG_BYTES:
            raise CatalogError("catalog too large")
        raw = result.read(MAX_CATALOG_BYTES + 1)
    finally:
        result.close()
    if len(raw) > MAX_CATALOG_BYTES:
        raise CatalogError("catalog too large")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise CatalogError("catalog is not valid JSON") from None
    files = data.get("files") if isinstance(data, dict) else None
    if not isinstance(files, dict):
        raise CatalogError("catalog has no files map")
    return {k: v for k, v in files.items() if isinstance(k, str) and isinstance(v, dict)}


def _catalog_for_listing(bucket, key: str) -> tuple[dict[str, dict], str | None]:
    # The listing still works without names, so catalog problems only become a warning.
    try:
        return read_catalog(bucket, key), None
    except CatalogError as exc:
        log.warning("曲目信息文件无法解析 key=%s：%s", key, exc)
        return {}, "OSS 上的 catalog.json 无法解析，暂时按文件名显示。"
    except Exception as exc:
        _log_oss_error("读取曲目信息", key, exc)
        return {}, f"读取 catalog.json 失败，暂时按文件名显示：{safe_error(exc)}"


def list_audio(settings: Settings, bucket=None) -> dict:
    """List every audio object under the prefix, newest first; never a bucket-wide listing."""
    prefix = object_prefix(settings)
    try:
        bucket = bucket or get_bucket(settings)
        tracks: list[dict] = []
        token = ""
        truncated = False
        for _ in range(MAX_LIST_PAGES):
            result = bucket.list_objects_v2(prefix=prefix, continuation_token=token, max_keys=1000)
            for item in result.object_list:
                key = item.key
                if not isinstance(key, str) or not key.startswith(prefix) or audio_type(key) is None:
                    continue
                try:
                    validate_key(key)
                except UserError:
                    continue
                modified = datetime.fromtimestamp(int(item.last_modified or 0), UTC)
                tracks.append(
                    {
                        "key": key,
                        "name": key[len(prefix) :],
                        "size": int(item.size or 0),
                        "last_modified": modified.isoformat().replace("+00:00", "Z"),
                    }
                )
            truncated = bool(result.is_truncated)
            token = result.next_continuation_token or ""
            if not truncated or not token:
                break
        tracks.sort(key=lambda t: (t["last_modified"], t["key"]), reverse=True)
        catalog, catalog_error = _catalog_for_listing(bucket, catalog_key(settings))
        for track in tracks:
            track["info"] = _catalog_info(catalog.get(track["key"]))
        log.info(
            "列举音频 bucket=%s prefix=%s count=%s catalog_entries=%s truncated=%s",
            settings.oss_bucket,
            prefix or "/",
            len(tracks),
            sum(1 for t in tracks if t["info"]),
            truncated,
        )
        return {"tracks": tracks, "prefix": prefix, "truncated": truncated, "catalog_error": catalog_error}
    except Exception as exc:
        _log_oss_error("列举", prefix or "/", exc)
        raise UserError(f"获取 OSS 音乐列表失败：{safe_error(exc)}") from None


def parse_range(header: str | None) -> tuple[int | None, int | None] | None:
    """Parse a single "bytes=" range. Malformed or multi-range headers are ignored (RFC 9110)."""
    if not header:
        return None
    match = _RANGE.match(header.strip())
    if not match:
        return None
    start, end = match.group(1), match.group(2)
    if not start and not end:
        return None
    if not start:
        return (None, int(end)) if int(end) > 0 else None
    if end and int(end) < int(start):
        return None
    return int(start), int(end) if end else None


def open_stream(key: str, range_header: str | None, settings: Settings, bucket=None) -> AudioStream:
    key = ensure_audio_key(key, settings)
    byte_range = parse_range(range_header)
    try:
        bucket = bucket or get_bucket(settings)
        # "standard" makes OSS answer 416 for out-of-bounds ranges instead of silently sending 200.
        headers = {"x-oss-range-behavior": "standard"} if byte_range else None
        result = bucket.get_object(key, byte_range=byte_range, headers=headers)
    except oss2.exceptions.OssError as exc:
        if exc.status == 416:
            raise RangeNotSatisfiable(_object_size(bucket, key)) from None
        _log_oss_error("读取", key, exc)
        raise UserError(f"读取音频失败：{safe_error(exc)}") from None
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("读取", key, exc)
        raise UserError(f"读取音频失败：{safe_error(exc)}") from None

    response_headers = {
        "Content-Type": audio_type(key) or "application/octet-stream",
        "Accept-Ranges": "bytes",
    }
    if result.content_length is not None:
        response_headers["Content-Length"] = str(result.content_length)
    if result.content_range:
        response_headers["Content-Range"] = result.content_range
    status = 206 if result.content_range else 200
    log.debug("读取音频 key=%s range=%s status=%s", key, range_header or "-", status)
    return AudioStream(status=status, headers=response_headers, body=_iter_body(result, key))


def _object_size(bucket, key: str) -> int | None:
    try:
        return int(bucket.head_object(key).content_length)
    except Exception:
        return None


def _iter_body(result, key: str) -> Iterator[bytes]:
    try:
        while True:
            chunk = result.read(CHUNK_SIZE)
            if not chunk:
                break
            yield chunk
    except Exception as exc:
        # The status line is already sent; the browser retries with a new range request.
        log.warning("音频传输中断 key=%s：%s", key, describe_error(exc))
    finally:
        result.close()


def _log_oss_error(action: str, key: str, exc: Exception) -> None:
    if isinstance(exc, UserError):
        log.warning("OSS %s被拒绝 key=%s：%s", action, key, exc)
    elif isinstance(exc, oss2.exceptions.OssError):
        log.error(
            "OSS %s失败 key=%s status=%s code=%s request_id=%s ec=%s message=%s",
            action,
            key,
            exc.status,
            exc.code or "-",
            exc.request_id or "-",
            getattr(exc, "ec", "") or "-",
            exc.message or exc.details,
        )
    else:
        log.error("OSS %s失败 key=%s：%s", action, key, describe_error(exc))
