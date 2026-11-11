"""Read-only music access: list audio under MEDIA_OSS_PREFIX and proxy byte ranges for playback.

Bucket handling, range parsing and body streaming are shared with oss_store.
"""

from __future__ import annotations

import json
import logging
import math
import re
from pathlib import Path

import oss2

import oss_store
from config import Settings
from logs import describe_error
from oss_store import ObjectStream, RangeNotSatisfiable, UserError

log = logging.getLogger("media")

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

MAX_LIST_PAGES = 50  # 50 × 1000 objects; the UI reports when the cap is reached.

# Written by media-to-oss next to the uploads; the player only ever reads it.
CATALOG_NAME = "catalog.json"
MAX_CATALOG_BYTES = 8 * 1024 * 1024
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")
_EPOCH = "1970-01-01T00:00:00Z"


class CatalogError(Exception):
    pass


def media_prefix(settings: Settings) -> str:
    prefix = settings.media_oss_prefix.strip().strip("/")
    return f"{prefix}/" if prefix else ""


def catalog_key(settings: Settings) -> str:
    return f"{media_prefix(settings)}{CATALOG_NAME}"


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
    """The browser may only read audio objects below the media prefix."""
    key = validate_key(key)
    if not key.startswith(media_prefix(settings)):
        raise UserError("只能播放配置前缀下的 OSS 文件。")
    if audio_type(key) is None:
        raise UserError("不支持该音频格式。")
    return key


def safe_error(exc: Exception) -> str:
    """Map raw SDK/network errors to a short message that never contains URLs or credentials."""
    if isinstance(exc, UserError):
        return str(exc)
    message = re.sub(r"https?://\S+", "[链接]", str(exc).lower())
    patterns = [
        (
            ("403", "accessdenied", "invalidaccesskey", "signaturedoesnotmatch", "securitytoken"),
            "访问被拒绝，请检查 OSS 凭据及 RAM 授权（需要 oss:GetObject 与 oss:ListObjects）。",
        ),
        (("nosuchkey",), "OSS 中已找不到该文件，请刷新列表。"),
        (("404", "not found", "nosuchbucket"), "OSS Bucket 或文件不存在，请检查配置。"),
        (("timeout", "timed out"), "请求 OSS 超时，请检查网络后重试。"),
        (("certificate", "ssl"), "HTTPS 证书验证失败，请检查网络及证书配置。"),
        (("connection", "resolve", "network"), "无法连接 OSS，请检查网络及 Endpoint。"),
    ]
    for needles, result in patterns:
        if any(needle in message for needle in needles):
            return result
    return "OSS 请求失败，请查看服务日志。"


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
    """List every audio object under the media prefix, newest first; never a bucket-wide listing."""
    prefix = media_prefix(settings)
    try:
        bucket = bucket or oss_store.get_bucket(settings)
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
                tracks.append(
                    {
                        "key": key,
                        "name": key[len(prefix) :],
                        "size": int(item.size or 0),
                        "last_modified": oss_store._iso_time(item.last_modified or 0) or _EPOCH,
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


def open_stream(key: str, range_header: str | None, settings: Settings, bucket=None) -> ObjectStream:
    key = ensure_audio_key(key, settings)
    byte_range = oss_store.parse_range(range_header)
    try:
        bucket = bucket or oss_store.get_bucket(settings)
        # "standard" makes OSS answer 416 for out-of-bounds ranges instead of silently sending 200.
        headers = {"x-oss-range-behavior": "standard"} if byte_range else None
        result = bucket.get_object(key, byte_range=byte_range, headers=headers)
    except oss2.exceptions.OssError as exc:
        if exc.status == 416:
            raise RangeNotSatisfiable(oss_store._object_size(bucket, key)) from None
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
    return ObjectStream(status=status, headers=response_headers, body=oss_store._iter_body(result, key))


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
