"""Private OSS uploads and short-lived HTTPS download links."""

from __future__ import annotations

import fcntl
import json
import logging
import mimetypes
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qs, urlsplit, urlunsplit
from uuid import uuid4

import oss2

from config import ROOT, Settings
from logs import describe_error
from security import UserError, safe_error

log = logging.getLogger("oss")

# SDK debug messages may contain signatures. Do not send them to a root stdout handler.
_sdk_logger = logging.getLogger("oss2")
_sdk_logger.addHandler(logging.NullHandler())
_sdk_logger.propagate = False

_MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".m4v": "video/mp4",
    ".flv": "video/x-flv",
    ".ts": "video/mp2t",
    ".m2ts": "video/mp2t",
    ".ogv": "video/ogg",
    ".3gp": "video/3gpp",
    ".3g2": "video/3gpp2",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
    ".wmv": "video/x-ms-wmv",
}

# One JSON document under the prefix describes every upload (title, source, ...).
CATALOG_NAME = "catalog.json"
MAX_CATALOG_BYTES = 8 * 1024 * 1024
# Uploads update the catalog from worker subprocesses while deletes run in the service
# process, so read-modify-write cycles are serialized with a file lock as well.
CATALOG_LOCK_FILE = ROOT / ".runtime" / ".catalog.lock"
CATALOG_LOCK_SECONDS = 30
_catalog_lock = threading.Lock()


class CatalogError(Exception):
    """The catalog exists but cannot be used; never overwrite it in this state."""


def _validate_key(key: str) -> str:
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


def object_prefix(settings: Settings) -> str:
    """Normalized directory prefix ("media/" or "") that uploads and listings share."""
    prefix = settings.oss_prefix.strip().strip("/")
    return f"{prefix}/" if prefix else ""


def object_kind(key: str) -> str:
    media_type = _MEDIA_TYPES.get(Path(key).suffix.lower(), "")
    return media_type.split("/", 1)[0] if media_type.startswith(("audio/", "video/")) else "other"


def catalog_key(settings: Settings) -> str:
    return f"{object_prefix(settings)}{CATALOG_NAME}"


def make_object_key(filename: str, settings: Settings) -> str:
    """Keep only a known media extension; never include a supplied title or path."""
    extension = Path(filename).suffix.lower()
    if extension not in _MEDIA_TYPES:
        raise UserError("不支持该媒体文件扩展名。")
    return _validate_key(f"{object_prefix(settings)}{uuid4().hex}{extension}")


def ensure_listed_key(key: str, settings: Settings) -> str:
    """Only objects under the configured prefix may be signed from the browser."""
    key = _validate_key(key)
    prefix = object_prefix(settings)
    if not key.startswith(prefix) or key.endswith("/"):
        raise UserError("只能访问配置前缀下的 OSS 文件。")
    return key


def _bucket(settings: Settings):
    if settings.oss_missing:
        raise UserError("OSS 配置不完整：" + ", ".join(settings.oss_missing))
    endpoint = settings.oss_endpoint.strip()
    if "://" not in endpoint:
        endpoint = "https://" + endpoint
    try:
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or any(c.isspace() or ord(c) < 32 for c in endpoint)
        ):
            raise UserError("invalid endpoint")
        parsed.port  # Validate a configured port before passing it to the SDK.
    except ValueError:
        raise UserError("OSS Endpoint 必须是有效的 HTTPS 服务地址，不得包含路径或凭据。") from None
    # Upgrade a scheme-less or HTTP configuration before signing or sending credentials.
    endpoint = urlunsplit(("https", parsed.netloc, "", "", ""))
    access_id = settings.oss_access_key_id.get_secret_value()
    access_secret = settings.oss_access_key_secret.get_secret_value()
    token = settings.oss_security_token.get_secret_value()
    auth = oss2.StsAuth(access_id, access_secret, token) if token else oss2.Auth(access_id, access_secret)
    return oss2.Bucket(
        auth,
        endpoint,
        settings.oss_bucket,
        connect_timeout=max(1, min(30, settings.download_timeout_seconds)),
    )


def upload_file(
    path: Path,
    key: str,
    emit: Callable[[dict], None],
    settings: Settings,
) -> dict:
    """Upload with object-level private ACL. Never remove the local file on failure."""
    key = _validate_key(key)
    try:
        if path.is_symlink() or not path.is_file():
            raise UserError("待上传文件不存在或不是普通文件。")
        path = path.resolve(strict=True)
        size = path.stat().st_size
        if settings.max_file_mb <= 0 or not 0 < size <= settings.max_file_mb * 1024 * 1024:
            raise UserError("待上传文件为空或超过大小限制。")
        bucket = _bucket(settings)
        content_type = _MEDIA_TYPES.get(path.suffix.lower())
        if content_type is None:
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        last_percent = -1

        def progress(consumed_bytes: int, total_bytes: int | None) -> None:
            nonlocal last_percent
            total = total_bytes or size
            # Reserve 100% for the successful server response, not the final socket write.
            percent = max(0, min(99, int(consumed_bytes / total * 100)))
            if percent != last_percent:
                last_percent = percent
                emit({"event": "progress", "status": "uploading", "progress": percent})

        emit({"event": "progress", "status": "uploading", "progress": 0})
        log.info(
            "开始上传 bucket=%s key=%s size=%s content_type=%s", settings.oss_bucket, key, size, content_type
        )
        result = bucket.put_object_from_file(
            key,
            str(path),
            headers={"Content-Type": content_type, "x-oss-object-acl": "private"},
            progress_callback=progress,
        )
        if not 200 <= result.status < 300:
            log.error(
                "OSS 返回非成功状态 status=%s request_id=%s key=%s",
                result.status,
                getattr(result, "request_id", "-"),
                key,
            )
            raise UserError("OSS 未确认上传成功。")
        log.info("上传成功 key=%s request_id=%s", key, getattr(result, "request_id", "-"))
        emit({"event": "progress", "status": "uploading", "progress": 100})
        return {"object_key": key}
    except Exception as exc:
        _log_oss_error("上传", key, exc)
        raise UserError(f"OSS 上传失败，本地文件已保留：{safe_error(exc)}") from None


def _log_oss_error(action: str, key: str, exc: Exception) -> None:
    """Record the SDK error code and request id; the UI only receives safe_error()."""
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


def _clean(value, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = " ".join("".join(" " if ord(c) < 32 or ord(c) == 127 else c for c in value).split())
    return value[:limit] or None


def _number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or not 0 <= value < 10**12:
        return None
    return round(float(value), 1)


def _catalog_entry(value) -> dict:
    """Normalize one catalog record; unknown or malformed fields are dropped."""
    if not isinstance(value, dict):
        return {}
    entry = {
        "title": _clean(value.get("title"), 200),
        "artist": _clean(value.get("artist"), 200),
        "duration": _number(value.get("duration")),
        "source": _clean(value.get("source"), 100),
        "source_host": _clean(value.get("source_host"), 253),
        "mode": value.get("mode") if value.get("mode") in {"audio", "video"} else None,
        "size": int(size) if (size := _number(value.get("size"))) is not None else None,
        "content_type": _clean(value.get("content_type"), 100),
        "uploaded_at": _clean(value.get("uploaded_at"), 40),
    }
    return {k: v for k, v in entry.items() if v is not None}


def _read_catalog(bucket, key: str) -> dict[str, dict]:
    """Return {object_key: entry}. A missing catalog is empty; a broken one raises CatalogError."""
    try:
        result = bucket.get_object(key)
    except oss2.exceptions.NoSuchKey:
        return {}
    try:
        if (result.content_length or 0) > MAX_CATALOG_BYTES:
            raise CatalogError(f"{key} 超过 {MAX_CATALOG_BYTES // 1024 // 1024} MB")
        raw = result.read()
    finally:
        result.close()
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        raise CatalogError(f"{key} 不是有效的 UTF-8 JSON：{exc}") from None
    files = data.get("files") if isinstance(data, dict) else None
    if not isinstance(files, dict):
        raise CatalogError(f"{key} 缺少 files 对象")
    return {k: v for k, v in files.items() if isinstance(k, str) and isinstance(v, dict)}


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


@contextmanager
def _catalog_guard() -> Iterator[None]:
    """Hold the catalog for one read-modify-write, across this process and worker subprocesses."""
    with _catalog_lock:
        CATALOG_LOCK_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with CATALOG_LOCK_FILE.open("a") as handle:
            deadline = time.monotonic() + CATALOG_LOCK_SECONDS
            while True:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise UserError("曲目信息文件正在被其他操作写入，请稍后重试。") from None
                    time.sleep(0.1)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)


def _write_catalog(bucket, target: str, files: dict[str, dict]) -> None:
    body = json.dumps(
        {"version": 1, "updated_at": _now(), "files": files},
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    ).encode("utf-8")
    if len(body) > MAX_CATALOG_BYTES:
        raise CatalogError("写入后会超过大小上限")
    result = bucket.put_object(
        target,
        body,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-cache",
            "x-oss-object-acl": "private",
        },
    )
    if not 200 <= result.status < 300:
        raise CatalogError(f"OSS 返回状态 {result.status}")


def record_upload(key: str, info: dict, settings: Settings) -> dict:
    """Add or replace the catalog entry for an uploaded object; existing entries are kept."""
    key = _validate_key(key)
    target = catalog_key(settings)
    entry = _catalog_entry(
        {
            **(info if isinstance(info, dict) else {}),
            "content_type": _MEDIA_TYPES.get(Path(key).suffix.lower()),
            "uploaded_at": _now(),
        }
    )
    try:
        with _catalog_guard():
            bucket = _bucket(settings)
            files = _read_catalog(bucket, target)
            files[key] = entry
            _write_catalog(bucket, target, files)
        log.info("曲目信息已写入 catalog=%s key=%s entries=%s", target, key, len(files))
        return entry
    except CatalogError as exc:
        log.error("曲目信息文件不可用，未覆盖 catalog=%s key=%s：%s", target, key, exc)
        raise UserError("曲目信息文件 catalog.json 已损坏或过大，已停止写入以免覆盖。") from None
    except Exception as exc:
        _log_oss_error("写入曲目信息", target, exc)
        raise UserError(f"写入曲目信息失败：{safe_error(exc)}") from None


def _forget_upload(bucket, key: str, settings: Settings) -> bool:
    """Drop the catalog entry of a deleted object; returns whether the catalog changed."""
    target = catalog_key(settings)
    try:
        with _catalog_guard():
            files = _read_catalog(bucket, target)
            if key not in files:
                return False
            del files[key]
            _write_catalog(bucket, target, files)
        log.info("曲目信息已移除 catalog=%s key=%s entries=%s", target, key, len(files))
        return True
    except CatalogError as exc:
        log.error("曲目信息文件不可用，未覆盖 catalog=%s key=%s：%s", target, key, exc)
        raise UserError("catalog.json 已损坏或过大，已停止写入以免覆盖。") from None
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("更新曲目信息", target, exc)
        raise UserError(safe_error(exc)) from None


def delete_object(key: str, settings: Settings) -> dict:
    """Delete a listed object, then its catalog entry. A leftover entry is harmless: listings win."""
    key = ensure_listed_key(key, settings)
    if key == catalog_key(settings):
        raise UserError("不能删除曲目信息文件 catalog.json。")
    try:
        bucket = _bucket(settings)
        result = bucket.delete_object(key)
        if not 200 <= result.status < 300:
            raise UserError("OSS 未确认删除成功。")
        log.info("对象已删除 key=%s request_id=%s", key, getattr(result, "request_id", "-"))
    except Exception as exc:
        _log_oss_error("删除", key, exc)
        raise UserError(f"删除 OSS 文件失败：{safe_error(exc)}") from None
    try:
        changed = _forget_upload(bucket, key, settings)
    except UserError as exc:
        return {"key": key, "catalog": False, "warning": f"文件已删除，但 catalog.json 未同步更新：{exc}"}
    return {"key": key, "catalog": changed, "warning": None}


def list_objects(settings: Settings, token: str = "", max_keys: int = 100) -> dict:
    """List one page of objects under the configured prefix; never a bucket-wide listing."""
    if not isinstance(token, str) or len(token) > 1024 or any(ord(c) < 32 or ord(c) == 127 for c in token):
        raise UserError("分页标记无效。")
    prefix = object_prefix(settings)
    target = catalog_key(settings)
    try:
        bucket = _bucket(settings)
        result = bucket.list_objects_v2(
            prefix=prefix, continuation_token=token, max_keys=max(1, min(1000, max_keys))
        )
        catalog, catalog_error = _catalog_for_listing(bucket, target)
        objects = []
        for item in result.object_list:
            key = item.key
            if not isinstance(key, str) or key.endswith("/") or not key.startswith(prefix) or key == target:
                continue  # Skip directory placeholders created in the console, and the catalog itself.
            try:
                _validate_key(key)
            except UserError:
                continue
            modified = datetime.fromtimestamp(int(item.last_modified or 0), UTC)
            objects.append(
                {
                    "key": key,
                    "name": key[len(prefix) :],
                    "size": int(item.size or 0),
                    "last_modified": modified.isoformat().replace("+00:00", "Z"),
                    "kind": object_kind(key),
                    "info": _catalog_entry(catalog.get(key)),
                }
            )
        truncated = bool(result.is_truncated)
        log.info(
            "列举对象 bucket=%s prefix=%s count=%s catalog_entries=%s truncated=%s request_id=%s",
            settings.oss_bucket,
            prefix or "/",
            len(objects),
            len(catalog),
            truncated,
            getattr(result, "request_id", "-"),
        )
        return {
            "objects": objects,
            "prefix": prefix,
            "truncated": truncated,
            "next_token": (result.next_continuation_token or None) if truncated else None,
            "catalog_error": catalog_error,
        }
    except Exception as exc:
        _log_oss_error("列举", prefix or "/", exc)
        raise UserError(f"获取 OSS 文件列表失败：{safe_error(exc)}") from None


def _catalog_for_listing(bucket, target: str) -> tuple[dict[str, dict], str | None]:
    """A catalog problem must not hide the file list: fall back to object names."""
    try:
        return _read_catalog(bucket, target), None
    except CatalogError as exc:
        log.error("曲目信息文件无法解析 catalog=%s：%s", target, exc)
        return {}, "曲目信息文件 catalog.json 无法解析，暂时按文件名显示。"
    except Exception as exc:
        _log_oss_error("读取曲目信息", target, exc)
        return {}, f"读取曲目信息失败，暂时按文件名显示：{safe_error(exc)}"


def sign_url(key: str, settings: Settings) -> dict:
    """Return the exact V1 signature expiry as UTC; STS credentials can expire earlier."""
    key = _validate_key(key)
    if settings.signed_url_seconds <= 0:
        raise UserError("签名链接有效期必须大于零。")
    try:
        bucket = _bucket(settings)
        signed = bucket.sign_url("GET", key, settings.signed_url_seconds)
        parsed = urlsplit(signed)
        if parsed.scheme != "https" or not parsed.hostname:
            raise UserError("OSS 未生成 HTTPS 签名链接。")
        # Use the signed timestamp to avoid clock drift in the displayed expiry.
        expires = int(parse_qs(parsed.query)["Expires"][0])
        expires_at = datetime.fromtimestamp(expires, UTC).isoformat().replace("+00:00", "Z")
        return {"signed_url": signed, "expires_at": expires_at}
    except Exception as exc:
        _log_oss_error("签名", key, exc)
        raise UserError(f"生成 OSS 签名链接失败：{safe_error(exc)}") from None
