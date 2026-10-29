from __future__ import annotations

import hashlib
import io
import mimetypes
import time
from datetime import UTC, datetime
from types import SimpleNamespace

import bcrypt
import jwt
import pytest
from fastapi.testclient import TestClient
from oss2.exceptions import NoSuchKey, ServerError

import oss_store
from app import create_app
from config import Settings

TEST_AUTH_USERNAME = "testadmin"
TEST_AUTH_PASSWORD = "testpass123"
TEST_JWT_SECRET = "test-jwt-secret-key-for-testing"


class FakeBody:
    def __init__(
        self,
        data: bytes,
        *,
        key: str,
        content_range: str | None = None,
        content_type: str | None = None,
        etag: str | None = None,
    ):
        self._stream = io.BytesIO(data)
        self.content_length = len(data)
        self.content_range = content_range
        self.content_type = content_type or mimetypes.guess_type(key)[0] or "application/octet-stream"
        self.etag = etag
        self.closed = False
        self.read_amounts: list[int | None] = []

    def read(self, amount: int | None = None) -> bytes:
        self.read_amounts.append(amount)
        return self._stream.read(amount)

    def close(self) -> None:
        self.closed = True
        self._stream.close()


class FakeBucket:
    """In-memory OSS Bucket implementation used by every backend test."""

    def __init__(
        self,
        objects: dict[str, bytes] | None = None,
        *,
        page_size: int = 1000,
        modified: dict[str, datetime] | None = None,
    ):
        self.objects: dict[str, bytes] = dict(objects or {})
        self.object_headers: dict[str, dict[str, str]] = {}
        self.page_size = page_size
        self.modified: dict[str, datetime] = dict(modified or {})
        self.multipart: dict[str, dict[str, object]] = {}
        self.calls: list[tuple] = []
        self.versioning_status: str | None = None
        self.versioning_error: Exception | None = None
        self._upload_counter = 0

    @staticmethod
    def _result(**values):
        values.setdefault("etag", None)
        return SimpleNamespace(status=200, **values)

    @staticmethod
    def _data_bytes(data) -> bytes:
        if isinstance(data, bytes):
            return data
        if isinstance(data, bytearray):
            return bytes(data)
        if hasattr(data, "read"):
            return data.read()
        return b"".join(data)

    def list_objects_v2(
        self,
        prefix: str = "",
        delimiter: str = "",
        continuation_token: str = "",
        max_keys: int = 1000,
    ):
        self.calls.append(("list", prefix, delimiter, continuation_token, max_keys))
        entries: list[tuple[str, str]] = []
        seen_prefixes: set[str] = set()
        for key in sorted(key for key in self.objects if key.startswith(prefix)):
            relative = key[len(prefix) :]
            if delimiter and delimiter in relative:
                folder = prefix + relative.split(delimiter, 1)[0] + delimiter
                if folder not in seen_prefixes:
                    entries.append((folder, "prefix"))
                    seen_prefixes.add(folder)
            else:
                entries.append((key, "object"))
        entries.sort()
        try:
            start = int(continuation_token or 0)
        except ValueError:
            start = 0
        limit = min(max_keys, self.page_size)
        selected = entries[start : start + limit]
        end = start + len(selected)
        token = str(end) if end < len(entries) else None
        object_list = [
            SimpleNamespace(
                key=value,
                size=len(self.objects[value]),
                last_modified=self.modified.get(value, datetime(2026, 1, 2, tzinfo=UTC)),
                etag=self._etag(self.objects[value]),
            )
            for value, kind in selected
            if kind == "object"
        ]
        return SimpleNamespace(
            object_list=object_list,
            prefix_list=[value for value, kind in selected if kind == "prefix"],
            is_truncated=token is not None,
            next_continuation_token=token,
        )

    def get_object(self, key: str, byte_range=None, headers=None):
        self.calls.append(("get", key, byte_range, headers))
        if key not in self.objects:
            raise NoSuchKey(404, {}, b"", {"Code": "NoSuchKey"})
        data = self.objects[key]
        content_type = self.object_headers.get(key, {}).get("Content-Type")
        if byte_range is None:
            return FakeBody(data, key=key, content_type=content_type, etag=self._etag(data))
        start, end = byte_range
        if start is None:
            length = end
            start = max(0, len(data) - length)
            end = len(data) - 1
        else:
            end = len(data) - 1 if end is None else min(end, len(data) - 1)
        if start >= len(data):
            raise ServerError(416, {}, b"", {"Code": "InvalidRange"})
        ranged_data = data[start : end + 1]
        return FakeBody(
            ranged_data,
            key=key,
            content_range=f"bytes {start}-{end}/{len(data)}",
            content_type=content_type,
            etag=self._etag(data),
        )

    def get_bucket_versioning(self):
        self.calls.append(("versioning",))
        if self.versioning_error is not None:
            raise self.versioning_error
        return SimpleNamespace(status=self.versioning_status)

    def head_object(self, key: str):
        self.calls.append(("head", key))
        if key not in self.objects:
            raise NoSuchKey(404, {}, b"", {"Code": "NoSuchKey"})
        data = self.objects[key]
        return SimpleNamespace(
            content_length=len(data),
            content_type=self.object_headers.get(key, {}).get("Content-Type")
            or mimetypes.guess_type(key)[0]
            or "application/octet-stream",
            etag=self._etag(data),
            last_modified=datetime(2026, 1, 2, tzinfo=UTC),
        )

    def put_object(self, key: str, data, headers=None):
        body = self._data_bytes(data)
        stored_headers = dict(headers or {})
        self.calls.append(("put", key, body, stored_headers))
        if (
            stored_headers.get("x-oss-forbid-overwrite") == "true"
            and self.versioning_status is None
            and key in self.objects
        ):
            raise ServerError(409, {}, b"", {"Code": "FileAlreadyExists"})
        self.objects[key] = body
        self.object_headers[key] = stored_headers
        return self._result(etag=self._etag(body))

    def delete_object(self, key: str):
        self.calls.append(("delete", key))
        self.objects.pop(key, None)
        self.object_headers.pop(key, None)
        return self._result()

    def batch_delete_objects(self, keys: list[str]):
        self.calls.append(("batch_delete", tuple(keys)))
        for key in keys:
            self.objects.pop(key, None)
            self.object_headers.pop(key, None)
        return self._result()

    def copy_object(self, bucket_name: str, src_key: str, dst_key: str):
        self.calls.append(("copy", bucket_name, src_key, dst_key))
        if src_key not in self.objects:
            raise NoSuchKey(404, {}, b"", {"Code": "NoSuchKey"})
        self.objects[dst_key] = self.objects[src_key]
        self.object_headers[dst_key] = dict(self.object_headers.get(src_key, {}))
        return self._result(etag=self._etag(self.objects[dst_key]))

    def init_multipart_upload(self, key: str, headers=None):
        self._upload_counter += 1
        upload_id = f"upload-{self._upload_counter}"
        stored_headers = dict(headers or {})
        self.calls.append(("init_multipart", key, stored_headers))
        self.multipart[upload_id] = {"key": key, "parts": {}, "headers": stored_headers}
        return self._result(upload_id=upload_id)

    def upload_part(self, key: str, upload_id: str, part_number: int, data):
        body = self._data_bytes(data)
        self.calls.append(("upload_part", key, upload_id, part_number, body))
        state = self.multipart.get(upload_id)
        if state is None or state["key"] != key:
            raise ServerError(404, {}, b"", {"Code": "NoSuchUpload"})
        state["parts"][part_number] = body
        return self._result(etag=self._etag(body))

    def complete_multipart_upload(self, key: str, upload_id: str, parts):
        self.calls.append(("complete_multipart", key, upload_id))
        state = self.multipart.get(upload_id)
        if state is None or state["key"] != key:
            raise ServerError(404, {}, b"", {"Code": "NoSuchUpload"})
        numbers = [part.part_number for part in parts]
        self.objects[key] = b"".join(state["parts"][number] for number in numbers)
        self.object_headers[key] = dict(state["headers"])
        del self.multipart[upload_id]
        return self._result(etag=self._etag(self.objects[key]))

    def abort_multipart_upload(self, key: str, upload_id: str):
        self.calls.append(("abort_multipart", key, upload_id))
        state = self.multipart.get(upload_id)
        if state is None or state["key"] != key:
            raise ServerError(404, {}, b"", {"Code": "NoSuchUpload"})
        del self.multipart[upload_id]
        return self._result()

    @staticmethod
    def _etag(data: bytes) -> str:
        return hashlib.md5(data, usedforsecurity=False).hexdigest()


def _patch_oss(monkeypatch) -> FakeBucket:
    bucket = FakeBucket()
    monkeypatch.setattr(oss_store.oss2, "Bucket", lambda *args, **kwargs: bucket)
    oss_store._bucket_cache.clear()
    oss_store._versioning_cache.clear()
    oss_store._create_locks.clear()
    oss_store._upload_keys.clear()
    return bucket


@pytest.fixture
def settings() -> Settings:
    return Settings(
        _env_file=None,
        oss_endpoint="https://oss-cn-hangzhou.aliyuncs.com",
        oss_bucket="test-bucket",
        oss_access_key_id="test-id",
        oss_access_key_secret="test-secret",
        oss_prefix="drive/",
        note_oss_prefix="notes/",
        port=9876,
    )


@pytest.fixture
def unconfigured_settings() -> Settings:
    return Settings(_env_file=None, port=9876)


@pytest.fixture
def fake_bucket(monkeypatch) -> FakeBucket:
    bucket = FakeBucket()
    monkeypatch.setattr(oss_store.oss2, "Bucket", lambda *args, **kwargs: bucket)
    oss_store._bucket_cache.clear()
    oss_store._versioning_cache.clear()
    oss_store._create_locks.clear()
    oss_store._upload_keys.clear()
    yield bucket
    oss_store._bucket_cache.clear()
    oss_store._versioning_cache.clear()
    oss_store._create_locks.clear()
    oss_store._upload_keys.clear()


@pytest.fixture
def client(settings: Settings, fake_bucket: FakeBucket):
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture
def auth_settings(monkeypatch):
    """Settings with authentication configured."""
    from routes import auth

    password_hash = bcrypt.hashpw(TEST_AUTH_PASSWORD.encode(), bcrypt.gensalt()).decode()
    configured = Settings(
        oss_endpoint="https://test.oss-cn-test.aliyuncs.com",
        oss_bucket="test-bucket",
        oss_access_key_id="test-key-id",
        oss_access_key_secret="test-key-secret",
        oss_prefix="test/",
        note_oss_prefix="notes/",
        auth_username=TEST_AUTH_USERNAME,
        auth_password_hash=password_hash,
        jwt_secret_key=TEST_JWT_SECRET,
        jwt_expire_minutes=60,
        _env_file=None,
    )
    _patch_oss(monkeypatch)
    auth._fail_window.clear()
    return configured


@pytest.fixture
def auth_client(auth_settings):
    """Test client with authentication configured."""
    with TestClient(create_app(auth_settings)) as test_client:
        yield test_client


@pytest.fixture
def auth_token(auth_settings):
    """Pre-generated valid JWT token."""
    payload = {
        "sub": TEST_AUTH_USERNAME,
        "iat": int(time.time()),
        "exp": int(time.time()) + 3600,
    }
    return jwt.encode(payload, TEST_JWT_SECRET, algorithm="HS256")


def auth_header(token: str) -> dict[str, str]:
    """Build an Authorization header."""
    return {"Authorization": f"Bearer {token}"}
