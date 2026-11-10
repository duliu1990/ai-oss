import time

import bcrypt
import jwt
import pytest
from oss2.exceptions import NoSuchKey, ServerError

from config import Settings

AUTH_USERNAME = "player"
AUTH_PASSWORD = "test-password-123"
# 32+ bytes keeps PyJWT from emitting InsecureKeyLengthWarning during tests.
JWT_SECRET = "test-jwt-secret-key-with-enough-bytes"
# Hash once with the lowest cost factor: tests only need a verifiable hash, not a slow one.
AUTH_PASSWORD_HASH = bcrypt.hashpw(AUTH_PASSWORD.encode(), bcrypt.gensalt(rounds=4)).decode()


def issue_token(app_settings: Settings, **claims) -> str:
    """Sign a token with the settings' own secret so tests never hardcode one."""
    now = int(time.time())
    payload = {"sub": app_settings.auth_username, "iat": now, "exp": now + 3600, **claims}
    return jwt.encode(payload, app_settings.jwt_secret_key.get_secret_value(), algorithm="HS256")


def bearer(app_settings: Settings, token: str | None = None) -> dict[str, str]:
    return {"Authorization": f"Bearer {token if token is not None else issue_token(app_settings)}"}


class FakeItem:
    def __init__(self, key, size, last_modified):
        self.key = key
        self.size = size
        self.last_modified = last_modified


class FakePage:
    def __init__(self, items, token):
        self.object_list = items
        self.is_truncated = token is not None
        self.next_continuation_token = token


class FakeResult:
    def __init__(self, data: bytes, content_range: str | None):
        self._data = data
        self.content_length = len(data)
        self.content_range = content_range
        self.closed = False

    def read(self, amount=None):
        chunk, self._data = self._data[:amount], self._data[amount:]
        return chunk

    def close(self):
        self.closed = True


class FakeHead:
    def __init__(self, size):
        self.content_length = size


class FakeBucket:
    """In-memory stand-in for oss2.Bucket covering the calls the player makes."""

    def __init__(self, objects: dict[str, bytes], page_size=1000, modified=None):
        self.objects = objects
        self.page_size = page_size
        self.modified = modified or {}
        self.requests = []

    def list_objects_v2(self, prefix="", continuation_token="", max_keys=100):
        keys = sorted(k for k in self.objects if k.startswith(prefix))
        start = int(continuation_token or 0)
        page = keys[start : start + self.page_size]
        end = start + len(page)
        items = [FakeItem(k, len(self.objects[k]), self.modified.get(k, 1_700_000_000)) for k in page]
        return FakePage(items, str(end) if end < len(keys) else None)

    def get_object(self, key, byte_range=None, headers=None):
        self.requests.append((key, byte_range, headers))
        if key not in self.objects:
            raise NoSuchKey(404, {}, b"", {"Code": "NoSuchKey"})
        data = self.objects[key]
        if byte_range is None:
            return FakeResult(data, None)
        start, end = byte_range
        if start is None:
            start, end = max(0, len(data) - end), len(data) - 1
        end = len(data) - 1 if end is None else min(end, len(data) - 1)
        if start >= len(data):
            raise ServerError(416, {}, b"", {"Code": "InvalidRange"})
        return FakeResult(data[start : end + 1], f"bytes {start}-{end}/{len(data)}")

    def head_object(self, key):
        return FakeHead(len(self.objects[key]))


@pytest.fixture
def settings():
    return Settings(
        _env_file=None,
        oss_endpoint="https://oss-cn-hangzhou.aliyuncs.com",
        oss_bucket="bucket",
        oss_access_key_id="id",
        oss_access_key_secret="secret",
        oss_prefix="media/",
        auth_username=AUTH_USERNAME,
        auth_password_hash=AUTH_PASSWORD_HASH,
        jwt_secret_key=JWT_SECRET,
    )
