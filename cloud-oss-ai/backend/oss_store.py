"""Prefix-confined Aliyun OSS operations for the local drive service."""

from __future__ import annotations

import logging
import mimetypes
import re
import threading
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import PurePosixPath
from urllib.parse import urlsplit, urlunsplit

import oss2

from config import Settings

log = logging.getLogger("oss")

# SDK debug output may contain signed URLs or signatures.
_sdk_logger = logging.getLogger("oss2")
_sdk_logger.addHandler(logging.NullHandler())
_sdk_logger.propagate = False

CHUNK_SIZE = 64 * 1024
MAX_LIST_PAGES = 50
MAX_KEYS_PER_PAGE = 1000
_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


class UserError(ValueError):
    """An error safe to return to an API client."""


class ConflictError(UserError):
    """A requested destination already exists or overlaps its source."""


class NotFoundError(UserError):
    """A requested OSS object does not exist."""


class PreconditionFailedError(UserError):
    """An object changed after the client last read it."""

    def __init__(self, message: str, current_etag: str | None):
        super().__init__(message)
        self.current_etag = current_etag


class TooLargeError(UserError):
    """An object exceeds the supported size for an operation."""


class RangeNotSatisfiable(Exception):
    def __init__(self, size: int | None):
        super().__init__("range not satisfiable")
        self.size = size


@dataclass
class ObjectStream:
    status: int
    headers: dict[str, str]
    body: Iterator[bytes]


@dataclass
class _KeyLockState:
    lock: threading.Lock
    users: int = 0


_bucket_lock = threading.Lock()
_bucket_cache: dict[int, oss2.Bucket] = {}
_versioning_lock = threading.Lock()
_versioning_cache: dict[int, str] = {}
_create_locks_guard = threading.Lock()
_create_locks: dict[tuple[int, str], _KeyLockState] = {}
_upload_lock = threading.Lock()
_upload_keys: dict[str, str] = {}


def object_prefix(settings: Settings) -> str:
    prefix = settings.oss_prefix.strip().strip("/")
    return f"{prefix}/" if prefix else ""


def settings_with_prefix(settings: Settings, prefix: str) -> Settings:
    """Return a settings view scoped to a separately validated OSS prefix."""
    normalized = prefix.strip().strip("/")
    scoped_prefix = f"{normalized}/" if normalized else ""
    if scoped_prefix:
        validate_key(scoped_prefix, allow_folder=True)
    return settings.model_copy(update={"oss_prefix": scoped_prefix})


def validate_key(key: str, *, allow_folder: bool = False) -> str:
    if not isinstance(key, str) or not key or key.startswith("/") or "\\" in key:
        raise UserError("Invalid OSS object key.")
    if any(ord(char) < 32 or ord(char) == 127 for char in key):
        raise UserError("Invalid OSS object key.")
    folder = key.endswith("/")
    if folder and not allow_folder:
        raise UserError("A file key must not end with '/'.")
    core = key[:-1] if folder else key
    if not core or any(part in {"", ".", ".."} for part in core.split("/")):
        raise UserError("Invalid OSS object key.")
    try:
        encoded_length = len(key.encode("utf-8"))
    except UnicodeEncodeError:
        raise UserError("Invalid OSS object key.") from None
    if encoded_length > 1023:
        raise UserError("OSS object key is too long.")
    return key


def validate_name(name: str) -> str:
    if not isinstance(name, str):
        raise UserError("Invalid file or folder name.")
    name = name.strip()
    if (
        not name
        or name in {".", ".."}
        or "/" in name
        or "\\" in name
        or any(ord(char) < 32 or ord(char) == 127 for char in name)
    ):
        raise UserError("Invalid file or folder name.")
    try:
        encoded_length = len(name.encode("utf-8"))
    except UnicodeEncodeError:
        raise UserError("Invalid file or folder name.") from None
    if encoded_length > 255:
        raise UserError("Invalid file or folder name.")
    return name


def ensure_scoped_key(key: str, settings: Settings, *, allow_folder: bool = False) -> str:
    key = validate_key(key, allow_folder=allow_folder)
    prefix = object_prefix(settings)
    if prefix and not key.startswith(prefix):
        raise UserError("The object is outside the configured OSS prefix.")
    if key == prefix:
        raise UserError("The configured OSS prefix itself cannot be modified.")
    return key


def resolve_upload_key(key: str, settings: Settings) -> str:
    """Resolve the frontend's root-relative filename to an OSS-scoped object key."""
    key = validate_key(key)
    prefix = object_prefix(settings)
    if prefix and "/" not in key:
        key = f"{prefix}{key}"
    return ensure_scoped_key(key, settings)


def resolve_directory_prefix(
    value: str,
    settings: Settings,
    *,
    allow_root: bool = True,
    strict_scope: bool = False,
) -> str:
    if not isinstance(value, str):
        raise UserError("Invalid folder prefix.")
    value = value.strip()
    if value.startswith("/"):
        raise UserError("Folder prefixes must be relative paths.")
    root = object_prefix(settings)
    if not value:
        if allow_root:
            return root
        raise UserError("A folder prefix is required.")
    candidate = value.strip("/")
    if not candidate:
        if allow_root:
            return root
        raise UserError("A folder prefix is required.")
    full = f"{candidate}/"
    if root and not full.startswith(root):
        if strict_scope:
            raise UserError("The folder is outside the configured OSS prefix.")
        full = f"{root}{full}"
    validate_key(full, allow_folder=True)
    if root and not full.startswith(root):
        raise UserError("The folder is outside the configured OSS prefix.")
    if not allow_root and full == root:
        raise UserError("The configured OSS prefix itself cannot be modified.")
    return full


def join_key(prefix: str, name: str, settings: Settings, *, folder: bool = False) -> str:
    directory = resolve_directory_prefix(prefix, settings)
    name = validate_name(name)
    key = f"{directory}{name}{'/' if folder else ''}"
    return ensure_scoped_key(key, settings, allow_folder=folder)


def get_bucket(settings: Settings) -> oss2.Bucket:
    if settings.oss_missing:
        raise UserError("OSS configuration is incomplete: " + ", ".join(settings.oss_missing))
    with _bucket_lock:
        bucket = _bucket_cache.get(id(settings))
        if bucket is None:
            bucket = _make_bucket(settings)
            _bucket_cache[id(settings)] = bucket
        return bucket


def _make_bucket(settings: Settings) -> oss2.Bucket:
    endpoint = settings.oss_endpoint.strip()
    parsed = urlsplit(endpoint if "://" in endpoint else f"https://{endpoint}")
    if not parsed.hostname or parsed.scheme != "https":
        raise UserError("OSS endpoint must use HTTPS.")
    endpoint = urlunsplit(("https", parsed.netloc, "", "", ""))
    access_id = settings.oss_access_key_id.get_secret_value()
    access_secret = settings.oss_access_key_secret.get_secret_value()
    token = settings.oss_security_token.get_secret_value()
    auth = oss2.StsAuth(access_id, access_secret, token) if token else oss2.Auth(access_id, access_secret)
    return oss2.Bucket(auth, endpoint, settings.oss_bucket, connect_timeout=30, enable_crc=False)


def _marker(value: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) > 2048
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise UserError("Invalid continuation token.")
    return value


def _iso_time(value) -> str | None:
    if isinstance(value, datetime):
        moment = value.astimezone(UTC)
    else:
        try:
            moment = datetime.fromtimestamp(int(value), UTC)
        except (TypeError, ValueError, OSError):
            return None
    return moment.isoformat().replace("+00:00", "Z")


def _object_item(item, current_prefix: str) -> dict:
    key = item.key
    relative = key[len(current_prefix) :] if key.startswith(current_prefix) else key
    return {
        "key": key,
        "name": relative,
        "size": int(item.size or 0),
        "last_modified": _iso_time(getattr(item, "last_modified", None)) or "",
        "is_dir": False,
        "etag": getattr(item, "etag", None),
        "content_type": mimetypes.guess_type(key)[0] or "application/octet-stream",
    }


def list_directory(prefix: str, marker: str, settings: Settings, bucket=None) -> dict:
    current = resolve_directory_prefix(prefix, settings)
    marker = _marker(marker)
    try:
        bucket = bucket or get_bucket(settings)
        result = bucket.list_objects_v2(
            prefix=current,
            delimiter="/",
            continuation_token=marker,
            max_keys=MAX_KEYS_PER_PAGE,
        )
        objects = []
        for item in result.object_list:
            key = getattr(item, "key", "")
            if key == current or not isinstance(key, str) or not key.startswith(current) or key.endswith("/"):
                continue
            try:
                ensure_scoped_key(key, settings)
            except UserError:
                continue
            objects.append(_object_item(item, current))
        folders = []
        for folder_key in result.prefix_list:
            if not isinstance(folder_key, str) or not folder_key.startswith(current):
                continue
            try:
                ensure_scoped_key(folder_key, settings, allow_folder=True)
            except UserError:
                continue
            relative = folder_key[len(current) :].rstrip("/")
            if relative and "/" not in relative:
                folders.append({"prefix": folder_key, "name": relative})
        truncated = bool(result.is_truncated)
        next_marker = (result.next_continuation_token or None) if truncated else None
        return {
            "prefix": current,
            "files": objects,
            "folders": folders,
            "objects": objects,
            "common_prefixes": [folder["prefix"] for folder in folders],
            "truncated": truncated,
            "is_truncated": truncated,
            "next_marker": next_marker,
            "continuation_token": next_marker,
        }
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("list", current, exc)
        raise UserError(f"Unable to list OSS files: {_safe_error(exc)}") from None


def list_recursive_keys(prefix: str, settings: Settings, bucket=None) -> list[str]:
    """List every object below one scoped folder, including its marker object."""
    folder = ensure_scoped_key(prefix, settings, allow_folder=True)
    if not folder.endswith("/"):
        raise UserError("A folder key must end with '/'.")
    token = ""
    keys: list[str] = []
    try:
        bucket = bucket or get_bucket(settings)
        for _ in range(MAX_LIST_PAGES):
            result = bucket.list_objects_v2(
                prefix=folder,
                continuation_token=token,
                max_keys=MAX_KEYS_PER_PAGE,
            )
            for item in result.object_list:
                key = getattr(item, "key", "")
                if isinstance(key, str) and key.startswith(folder):
                    keys.append(ensure_scoped_key(key, settings, allow_folder=key.endswith("/")))
            truncated = bool(result.is_truncated)
            token = result.next_continuation_token or ""
            if not truncated or not token:
                return keys
        raise UserError("Folder contains too many objects to process safely in one request.")
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("list folder recursively", folder, exc)
        raise UserError(f"Unable to list the OSS folder: {_safe_error(exc)}") from None


def list_recursive_objects(prefix: str, settings: Settings, bucket=None) -> list[dict]:
    """List every non-directory object below *prefix* with key, size and last_modified."""
    root = object_prefix(settings)
    folder = f"{root}{prefix}" if prefix else root
    if folder and not folder.endswith("/"):
        folder += "/"
    token = ""
    objects: list[dict] = []
    try:
        bucket = bucket or get_bucket(settings)
        for _ in range(MAX_LIST_PAGES):
            result = bucket.list_objects_v2(
                prefix=folder,
                continuation_token=token,
                max_keys=MAX_KEYS_PER_PAGE,
            )
            for item in result.object_list:
                key = getattr(item, "key", "")
                if not isinstance(key, str) or key.endswith("/"):
                    continue
                relative = key[len(root) :] if root and key.startswith(root) else key
                objects.append(
                    {
                        "key": relative,
                        "size": int(item.size or 0),
                        "last_modified": _iso_time(getattr(item, "last_modified", None)) or "",
                    }
                )
            truncated = bool(result.is_truncated)
            token = result.next_continuation_token or ""
            if not truncated or not token:
                return objects
        raise UserError("Too many objects to list in one request.")
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("list objects recursively", folder, exc)
        raise UserError(f"Unable to list OSS objects: {_safe_error(exc)}") from None


def prefix_has_objects(prefix: str, settings: Settings, bucket=None) -> bool:
    """Return whether any object exists at or below one scoped folder prefix."""
    folder = ensure_scoped_key(prefix, settings, allow_folder=True)
    if not folder.endswith("/"):
        raise UserError("A folder key must end with '/'.")
    try:
        bucket = bucket or get_bucket(settings)
        try:
            bucket.head_object(folder.rstrip("/"))
        except oss2.exceptions.OssError as exc:
            if exc.status != 404:
                raise
        else:
            return True
        result = bucket.list_objects_v2(prefix=folder, max_keys=1)
        return bool(result.object_list)
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("check folder destination", folder, exc)
        raise UserError(f"Unable to check the OSS destination: {_safe_error(exc)}") from None


def search_objects(query: str, prefix: str, settings: Settings, bucket=None) -> dict:
    query = query.strip()
    if not query or len(query) > 200 or any(ord(char) < 32 or ord(char) == 127 for char in query):
        raise UserError("Search query must contain 1 to 200 printable characters.")
    current = resolve_directory_prefix(prefix, settings)
    needle = query.casefold()
    token = ""
    matches: list[dict] = []
    truncated = False
    try:
        bucket = bucket or get_bucket(settings)
        for _ in range(MAX_LIST_PAGES):
            result = bucket.list_objects_v2(
                prefix=current,
                continuation_token=token,
                max_keys=MAX_KEYS_PER_PAGE,
            )
            for item in result.object_list:
                key = getattr(item, "key", "")
                if not isinstance(key, str) or key.endswith("/") or not key.startswith(current):
                    continue
                try:
                    ensure_scoped_key(key, settings)
                except UserError:
                    continue
                if needle in PurePosixPath(key).name.casefold():
                    matches.append(_object_item(item, current))
            truncated = bool(result.is_truncated)
            token = result.next_continuation_token or ""
            if not truncated or not token:
                break
        return {
            "query": query,
            "prefix": current,
            "results": matches,
            "objects": matches,
            "truncated": truncated,
            "is_truncated": truncated,
        }
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("search", current, exc)
        raise UserError(f"Unable to search OSS files: {_safe_error(exc)}") from None


def bucket_versioning_status(settings: Settings, *, bucket=None) -> str:
    """Return a cached OSS versioning capability without exposing remote error details."""
    bucket = bucket or get_bucket(settings)
    cache_key = id(bucket)
    with _versioning_lock:
        cached = _versioning_cache.get(cache_key)
        if cached is not None:
            return cached
        try:
            result = bucket.get_bucket_versioning()
            remote_status = getattr(result, "status", None)
            if remote_status is None:
                status = "NeverEnabled"
            elif remote_status in {"Enabled", "Suspended"}:
                status = remote_status
            else:
                status = "Unknown"
        except Exception as exc:
            # Deliberately degrade to a HEAD preflight. Logs contain only safe OSS diagnostics.
            _log_oss_error("check bucket versioning", settings.oss_bucket or "-", exc)
            status = "Unknown"
        _versioning_cache[cache_key] = status
        return status


@contextmanager
def _create_key_lock(bucket, key: str):
    token = (id(bucket), key)
    with _create_locks_guard:
        state = _create_locks.get(token)
        if state is None:
            state = _KeyLockState(threading.Lock())
            _create_locks[token] = state
        state.users += 1
    try:
        with state.lock:
            yield
    finally:
        with _create_locks_guard:
            state.users -= 1
            if state.users == 0:
                _create_locks.pop(token, None)


def _object_exists_for_create(bucket, key: str) -> bool:
    try:
        bucket.head_object(key)
        return True
    except oss2.exceptions.OssError as exc:
        if exc.status == 404:
            return False
        _log_oss_error("preflight create", key, exc)
        raise UserError(f"Unable to check the OSS destination: {_safe_error(exc)}") from None
    except Exception as exc:
        _log_oss_error("preflight create", key, exc)
        raise UserError(f"Unable to check the OSS destination: {_safe_error(exc)}") from None


def put_object_if_absent(
    key: str,
    data,
    settings: Settings,
    *,
    content_type: str | None = None,
    bucket=None,
) -> dict:
    """Create an object without intentionally replacing an existing current object."""
    key = ensure_scoped_key(key, settings, allow_folder=key.endswith("/"))
    bucket = bucket or get_bucket(settings)
    versioning = bucket_versioning_status(settings, bucket=bucket)
    if versioning == "NeverEnabled":
        return put_object(
            key,
            data,
            settings,
            content_type=content_type,
            forbid_overwrite=True,
            bucket=bucket,
        )

    # This lock closes races within this process. External writers and other processes can still
    # write between HEAD and PUT because OSS ignores forbid-overwrite once versioning was enabled.
    with _create_key_lock(bucket, key):
        if _object_exists_for_create(bucket, key):
            raise ConflictError("The OSS object already exists.")
        return put_object(
            key,
            data,
            settings,
            content_type=content_type,
            forbid_overwrite=True,
            bucket=bucket,
        )


def put_object(
    key: str,
    data,
    settings: Settings,
    *,
    content_type: str | None = None,
    forbid_overwrite: bool = False,
    bucket=None,
) -> dict:
    key = ensure_scoped_key(key, settings, allow_folder=key.endswith("/"))
    headers = {"x-oss-object-acl": "private"}
    if content_type:
        headers["Content-Type"] = content_type
    if forbid_overwrite:
        headers["x-oss-forbid-overwrite"] = "true"
    try:
        bucket = bucket or get_bucket(settings)
        result = bucket.put_object(key, data, headers=headers)
        _require_success(result, "upload")
        return {"key": key, "etag": getattr(result, "etag", None)}
    except UserError:
        raise
    except Exception as exc:
        if _is_object_exists_error(exc):
            raise ConflictError("The OSS object already exists.") from None
        _log_oss_error("upload", key, exc)
        raise UserError(f"Unable to upload OSS object: {_safe_error(exc)}") from None


def init_multipart_upload(
    key: str, settings: Settings, *, content_type: str | None = None, bucket=None
) -> str:
    key = ensure_scoped_key(key, settings)
    headers = {"x-oss-object-acl": "private"}
    if content_type:
        headers["Content-Type"] = content_type
    try:
        bucket = bucket or get_bucket(settings)
        result = bucket.init_multipart_upload(key, headers=headers)
        upload_id = result.upload_id
        _validate_upload_id(upload_id)
        with _upload_lock:
            _upload_keys[upload_id] = key
        return upload_id
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("initialize multipart upload", key, exc)
        raise UserError(f"Unable to initialize multipart upload: {_safe_error(exc)}") from None


def multipart_key(upload_id: str) -> str:
    upload_id = _validate_upload_id(upload_id)
    with _upload_lock:
        key = _upload_keys.get(upload_id)
    if key is None:
        raise UserError("Unknown or expired multipart upload.")
    return key


def upload_part(
    key: str,
    upload_id: str,
    part_number: int,
    data,
    settings: Settings,
    *,
    bucket=None,
) -> str:
    key = ensure_scoped_key(key, settings)
    _ensure_upload_matches(upload_id, key)
    if not 1 <= part_number <= 10000:
        raise UserError("Part number must be between 1 and 10000.")
    try:
        bucket = bucket or get_bucket(settings)
        result = bucket.upload_part(key, upload_id, part_number, data)
        _require_success(result, "upload part")
        return result.etag
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("upload part", key, exc)
        raise UserError(f"Unable to upload part: {_safe_error(exc)}") from None


def complete_multipart_upload(
    key: str,
    upload_id: str,
    parts: Iterable[dict | tuple[int, str]],
    settings: Settings,
    *,
    bucket=None,
) -> dict:
    key = ensure_scoped_key(key, settings)
    _ensure_upload_matches(upload_id, key)
    part_infos = []
    previous = 0
    for part in parts:
        if isinstance(part, dict):
            number = part.get("part_number", part.get("part"))
            etag = part.get("etag")
        else:
            number, etag = part
        if not isinstance(number, int) or isinstance(number, bool) or not 1 <= number <= 10000:
            raise UserError("Invalid multipart part number.")
        if number <= previous or not isinstance(etag, str) or not etag or len(etag) > 256:
            raise UserError("Multipart parts must be ordered and include valid ETags.")
        previous = number
        part_infos.append(oss2.models.PartInfo(number, etag))
    if not part_infos:
        raise UserError("At least one multipart part is required.")
    try:
        bucket = bucket or get_bucket(settings)
        result = bucket.complete_multipart_upload(key, upload_id, part_infos)
        _require_success(result, "complete multipart upload")
        with _upload_lock:
            _upload_keys.pop(upload_id, None)
        return {"key": key, "etag": getattr(result, "etag", None)}
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("complete multipart upload", key, exc)
        raise UserError(f"Unable to complete multipart upload: {_safe_error(exc)}") from None


def abort_multipart_upload(key: str, upload_id: str, settings: Settings, *, bucket=None) -> None:
    key = ensure_scoped_key(key, settings)
    _ensure_upload_matches(upload_id, key)
    try:
        bucket = bucket or get_bucket(settings)
        result = bucket.abort_multipart_upload(key, upload_id)
        _require_success(result, "abort multipart upload")
        with _upload_lock:
            _upload_keys.pop(upload_id, None)
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("abort multipart upload", key, exc)
        raise UserError(f"Unable to abort multipart upload: {_safe_error(exc)}") from None


def copy_object(src_key: str, dst_key: str, settings: Settings, *, bucket=None) -> dict:
    src_key = ensure_scoped_key(src_key, settings, allow_folder=src_key.endswith("/"))
    dst_key = ensure_scoped_key(dst_key, settings, allow_folder=dst_key.endswith("/"))
    if src_key == dst_key:
        raise UserError("Source and destination are the same object.")
    try:
        bucket = bucket or get_bucket(settings)
        result = bucket.copy_object(settings.oss_bucket, src_key, dst_key)
        _require_success(result, "copy")
        return {"key": dst_key, "etag": getattr(result, "etag", None)}
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("copy", src_key, exc)
        raise UserError(f"Unable to copy OSS object: {_safe_error(exc)}") from None


def delete_object(key: str, settings: Settings, *, bucket=None) -> None:
    key = ensure_scoped_key(key, settings, allow_folder=key.endswith("/"))
    try:
        bucket = bucket or get_bucket(settings)
        result = bucket.delete_object(key)
        _require_success(result, "delete")
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("delete", key, exc)
        raise UserError(f"Unable to delete OSS object: {_safe_error(exc)}") from None


def batch_delete_objects(keys: Iterable[str], settings: Settings, *, bucket=None) -> int:
    validated = [ensure_scoped_key(key, settings, allow_folder=key.endswith("/")) for key in keys]
    if not validated:
        return 0
    try:
        bucket = bucket or get_bucket(settings)
        deleted = 0
        for start in range(0, len(validated), MAX_KEYS_PER_PAGE):
            chunk = validated[start : start + MAX_KEYS_PER_PAGE]
            result = bucket.batch_delete_objects(chunk)
            _require_success(result, "batch delete")
            deleted += len(chunk)
        return deleted
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("batch delete", validated[0], exc)
        raise UserError(f"Unable to delete OSS objects: {_safe_error(exc)}") from None


def delete_folder(prefix: str, settings: Settings, *, bucket=None) -> int:
    folder = resolve_directory_prefix(prefix, settings, allow_root=False)
    token = ""
    keys: list[str] = []
    try:
        bucket = bucket or get_bucket(settings)
        for _ in range(MAX_LIST_PAGES):
            result = bucket.list_objects_v2(
                prefix=folder,
                continuation_token=token,
                max_keys=MAX_KEYS_PER_PAGE,
            )
            for item in result.object_list:
                key = getattr(item, "key", "")
                if isinstance(key, str) and key.startswith(folder):
                    keys.append(ensure_scoped_key(key, settings, allow_folder=key.endswith("/")))
            truncated = bool(result.is_truncated)
            token = result.next_continuation_token or ""
            if not truncated or not token:
                break
        else:
            raise UserError("Folder contains too many objects to delete safely in one request.")
        return batch_delete_objects(keys, settings, bucket=bucket)
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("delete folder", folder, exc)
        raise UserError(f"Unable to delete OSS folder: {_safe_error(exc)}") from None


def head_object(key: str, settings: Settings, *, bucket=None) -> dict:
    key = ensure_scoped_key(key, settings)
    try:
        bucket = bucket or get_bucket(settings)
        result = bucket.head_object(key)
        return {
            "key": key,
            "size": int(result.content_length or 0),
            "content_type": getattr(result, "content_type", None)
            or mimetypes.guess_type(key)[0]
            or "application/octet-stream",
            "etag": getattr(result, "etag", None),
            "last_modified": _iso_time(getattr(result, "last_modified", None)),
        }
    except UserError:
        raise
    except oss2.exceptions.OssError as exc:
        if exc.status == 404:
            raise NotFoundError("Object not found.") from None
        _log_oss_error("head", key, exc)
        raise UserError(f"Unable to read OSS object metadata: {_safe_error(exc)}") from None
    except Exception as exc:
        _log_oss_error("head", key, exc)
        raise UserError(f"Unable to read OSS object metadata: {_safe_error(exc)}") from None


def read_object_bounded(key: str, max_bytes: int, settings: Settings, *, bucket=None) -> dict:
    """Read content and metadata from one bounded GET response snapshot."""
    key = ensure_scoped_key(key, settings)
    result = None
    try:
        bucket = bucket or get_bucket(settings)
        result = bucket.get_object(key)
        content_length = getattr(result, "content_length", None)
        if content_length is not None and int(content_length) > max_bytes:
            raise TooLargeError("File content exceeds the 1 MiB limit.")
        body = result.read(max_bytes + 1)
        if len(body) > max_bytes:
            raise TooLargeError("File content exceeds the 1 MiB limit.")
        return {
            "key": key,
            "body": body,
            "etag": getattr(result, "etag", None),
            "size": len(body),
        }
    except UserError:
        raise
    except oss2.exceptions.OssError as exc:
        if exc.status == 404:
            raise NotFoundError("Object not found.") from None
        _log_oss_error("read", key, exc)
        raise UserError(f"Unable to read OSS object: {_safe_error(exc)}") from None
    except Exception as exc:
        _log_oss_error("read", key, exc)
        raise UserError(f"Unable to read OSS object: {_safe_error(exc)}") from None
    finally:
        if result is not None:
            result.close()


def parse_range(header: str | None) -> tuple[int | None, int | None] | None:
    if not header:
        return None
    match = _RANGE.fullmatch(header.strip())
    if not match:
        return None
    start_text, end_text = match.groups()
    if not start_text and not end_text:
        return None
    if not start_text:
        length = int(end_text)
        return (None, length) if length > 0 else None
    start = int(start_text)
    end = int(end_text) if end_text else None
    if end is not None and end < start:
        return None
    return start, end


def open_stream(
    key: str,
    range_header: str | None,
    settings: Settings,
    *,
    download: bool = False,
    bucket=None,
) -> ObjectStream:
    key = ensure_scoped_key(key, settings)
    byte_range = parse_range(range_header)
    try:
        bucket = bucket or get_bucket(settings)
        headers = {"x-oss-range-behavior": "standard"} if byte_range else None
        result = bucket.get_object(key, byte_range=byte_range, headers=headers)
    except oss2.exceptions.OssError as exc:
        if exc.status == 416:
            raise RangeNotSatisfiable(_object_size(bucket, key)) from None
        _log_oss_error("download", key, exc)
        raise UserError(f"Unable to read OSS object: {_safe_error(exc)}") from None
    except UserError:
        raise
    except Exception as exc:
        _log_oss_error("download", key, exc)
        raise UserError(f"Unable to read OSS object: {_safe_error(exc)}") from None

    name = PurePosixPath(key).name
    disposition = "attachment" if download else "inline"
    response_headers = {
        "Content-Type": getattr(result, "content_type", None)
        or mimetypes.guess_type(name)[0]
        or "application/octet-stream",
        "Content-Disposition": _content_disposition(disposition, name),
        "Accept-Ranges": "bytes",
    }
    if result.content_length is not None:
        response_headers["Content-Length"] = str(result.content_length)
    if result.content_range:
        response_headers["Content-Range"] = result.content_range
    status = 206 if result.content_range else 200
    return ObjectStream(status=status, headers=response_headers, body=_iter_body(result, key))


def _content_disposition(kind: str, name: str) -> str:
    from urllib.parse import quote

    fallback = "".join(char if 32 <= ord(char) < 127 and char not in {'"', "\\"} else "_" for char in name)
    fallback = fallback[:150] or "download"
    return f"{kind}; filename=\"{fallback}\"; filename*=UTF-8''{quote(name, safe='')}"


def _object_size(bucket, key: str) -> int | None:
    try:
        return int(bucket.head_object(key).content_length)
    except Exception:
        return None


def _iter_body(result, key: str) -> Iterator[bytes]:
    try:
        while chunk := result.read(CHUNK_SIZE):
            yield chunk
    except Exception as exc:
        log.warning("OSS stream interrupted key=%s error=%s", key, type(exc).__name__)
    finally:
        result.close()


def _validate_upload_id(upload_id: str) -> str:
    if (
        not isinstance(upload_id, str)
        or not upload_id
        or len(upload_id) > 256
        or any(ord(char) < 32 or ord(char) == 127 for char in upload_id)
    ):
        raise UserError("Invalid multipart upload ID.")
    return upload_id


def _ensure_upload_matches(upload_id: str, key: str) -> None:
    if multipart_key(upload_id) != key:
        raise UserError("Multipart upload does not belong to this object.")


def _require_success(result, action: str) -> None:
    status = getattr(result, "status", 200)
    if not 200 <= status < 300:
        raise UserError(f"OSS did not confirm {action}.")


def _is_object_exists_error(exc: Exception) -> bool:
    object_already_exists = getattr(oss2.exceptions, "ObjectAlreadyExists", ())
    return isinstance(exc, object_already_exists) or (
        isinstance(exc, oss2.exceptions.OssError)
        and getattr(exc, "code", None) in {"FileAlreadyExists", "ObjectAlreadyExists"}
    )


def _safe_error(exc: Exception) -> str:
    if isinstance(exc, UserError):
        return str(exc)
    if isinstance(exc, oss2.exceptions.OssError):
        if exc.status == 404:
            return "Object not found."
        if exc.status == 403:
            return "OSS access was denied; check RAM permissions."
        if exc.status == 409:
            return "OSS reported a conflicting operation."
    return "Check the OSS endpoint, credentials, permissions, and network connection."


def _log_oss_error(action: str, key: str, exc: Exception) -> None:
    if isinstance(exc, oss2.exceptions.OssError):
        log.error(
            "OSS %s failed key=%s status=%s code=%s request_id=%s",
            action,
            key,
            exc.status,
            exc.code or "-",
            exc.request_id or "-",
        )
    elif isinstance(exc, UserError):
        log.info("OSS %s rejected key=%s error=%s", action, key, exc)
    else:
        log.error("OSS %s failed key=%s error=%s", action, key, type(exc).__name__)
