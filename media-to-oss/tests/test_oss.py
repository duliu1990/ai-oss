import fcntl
import json
import time
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

import pytest
from oss2.exceptions import NoSuchKey

import oss_store
from config import Settings
from security import UserError


class FakeObject:
    def __init__(self, body: bytes):
        self.body = body
        self.content_length = len(body)
        self.closed = False

    def read(self):
        return self.body

    def close(self):
        self.closed = True


def catalog_body(files: dict) -> bytes:
    return json.dumps({"version": 1, "files": files}).encode()


def missing_catalog(key):
    raise NoSuchKey(404, {}, b"", {"Code": "NoSuchKey"})


@pytest.fixture(autouse=True)
def catalog_lock(tmp_path, monkeypatch):
    path = tmp_path / "lock" / ".catalog.lock"
    monkeypatch.setattr(oss_store, "CATALOG_LOCK_FILE", path)
    return path


@pytest.fixture
def settings():
    return Settings(
        _env_file=None,
        oss_endpoint="https://oss-cn-hangzhou.aliyuncs.com",
        oss_bucket="test-bucket",
        oss_access_key_id="test-id",
        oss_access_key_secret="test-secret",
    )


def test_unique_keys_do_not_include_title(settings):
    first = oss_store.make_object_key("../private-title.mp3", settings)
    second = oss_store.make_object_key("media.mp3", settings)
    assert first != second and first.startswith("media/") and first.endswith(".mp3")
    assert "private-title" not in first and ".." not in first


def test_private_upload_and_progress(settings, tmp_path, monkeypatch):
    path = tmp_path / "media.mp3"
    path.write_bytes(b"test audio")
    bucket = Mock()

    def upload(key, filename, headers, progress_callback):
        assert key == "media/test.mp3" and filename == str(path)
        assert headers == {"Content-Type": "audio/mpeg", "x-oss-object-acl": "private"}
        progress_callback(5, 10)
        progress_callback(10, 10)
        return SimpleNamespace(status=200)

    bucket.put_object_from_file.side_effect = upload
    monkeypatch.setattr(oss_store, "_bucket", lambda s: bucket)
    events = []
    assert oss_store.upload_file(path, "media/test.mp3", events.append, settings) == {
        "object_key": "media/test.mp3"
    }
    assert [e["progress"] for e in events] == [0, 50, 99, 100]
    assert path.is_file()


def test_upload_failure_keeps_file_and_redacts_error(settings, tmp_path, monkeypatch):
    path = tmp_path / "media.mp3"
    path.write_bytes(b"test audio")
    bucket = Mock()
    bucket.put_object_from_file.side_effect = RuntimeError("403 secret-token=abc")
    monkeypatch.setattr(oss_store, "_bucket", lambda s: bucket)
    with pytest.raises(UserError) as error:
        oss_store.upload_file(path, "media/test.mp3", lambda e: None, settings)
    assert "abc" not in str(error.value) and "已保留" in str(error.value)
    assert path.read_bytes() == b"test audio"


def test_actual_sdk_signing_without_network(settings, monkeypatch):
    import socket

    monkeypatch.setattr(socket.socket, "connect", Mock(side_effect=AssertionError("No network allowed")))
    before = time.time()
    result = oss_store.sign_url("media/test.mp3", settings)
    url = urlsplit(result["signed_url"])
    assert url.scheme == "https" and url.hostname == "test-bucket.oss-cn-hangzhou.aliyuncs.com"
    expires = int(parse_qs(url.query)["Expires"][0])
    assert datetime.fromisoformat(result["expires_at"]).timestamp() == expires
    assert before + 295 < expires < before + 305


@pytest.mark.parametrize("key", ["../file.mp3", "/file.mp3", "media//file.mp3", "media/../file.mp3"])
def test_invalid_keys_rejected(settings, key):
    with pytest.raises(UserError):
        oss_store.sign_url(key, settings)


def test_list_objects_stays_under_prefix_and_normalizes(settings, monkeypatch):
    bucket = Mock()
    entries = [
        SimpleNamespace(key="media/", last_modified=1_700_000_000, size=0),
        SimpleNamespace(key="media/track.mp3", last_modified=1_700_000_000, size=1234),
        SimpleNamespace(key="media/clip.webm", last_modified=1_700_000_100, size=5678),
        SimpleNamespace(key="media/notes.txt", last_modified=1_700_000_200, size=9),
        SimpleNamespace(key="media/../escape.mp3", last_modified=1_700_000_300, size=1),
        SimpleNamespace(key="media/catalog.json", last_modified=1_700_000_400, size=50),
    ]
    bucket.list_objects_v2.return_value = SimpleNamespace(
        object_list=entries, is_truncated=True, next_continuation_token="token-2", request_id="req-1"
    )
    catalog = FakeObject(
        catalog_body(
            {
                "media/track.mp3": {
                    "title": "晴天\n",
                    "artist": "周杰伦",
                    "duration": 269.47,
                    "source": "yt-dlp · BiliBili",
                    "uploaded_at": "2023-11-14T22:13:21Z",
                    "url": "https://cdn.example.com/a.mp3?sig=1",
                },
                "media/gone.mp3": {"title": "已删除"},
            }
        )
    )
    bucket.get_object.return_value = catalog
    monkeypatch.setattr(oss_store, "_bucket", lambda s: bucket)
    result = oss_store.list_objects(settings, "token-1")
    bucket.list_objects_v2.assert_called_once_with(
        prefix="media/", continuation_token="token-1", max_keys=100
    )
    bucket.get_object.assert_called_once_with("media/catalog.json")
    assert catalog.closed
    assert result["prefix"] == "media/" and result["truncated"] is True and result["next_token"] == "token-2"
    assert result["catalog_error"] is None
    assert [o["name"] for o in result["objects"]] == ["track.mp3", "clip.webm", "notes.txt"]
    assert [o["kind"] for o in result["objects"]] == ["audio", "video", "other"]
    assert result["objects"][0] == {
        "key": "media/track.mp3",
        "name": "track.mp3",
        "size": 1234,
        "last_modified": "2023-11-14T22:13:20Z",
        "kind": "audio",
        "info": {
            "title": "晴天",
            "artist": "周杰伦",
            "duration": 269.5,
            "source": "yt-dlp · BiliBili",
            "uploaded_at": "2023-11-14T22:13:21Z",
        },
    }
    assert result["objects"][1]["info"] == {}


def test_list_objects_without_prefix_and_last_page(monkeypatch):
    settings = Settings(
        _env_file=None,
        oss_endpoint="https://oss-cn-hangzhou.aliyuncs.com",
        oss_bucket="test-bucket",
        oss_access_key_id="test-id",
        oss_access_key_secret="test-secret",
        oss_prefix="",
    )
    bucket = Mock()
    bucket.list_objects_v2.return_value = SimpleNamespace(
        object_list=[SimpleNamespace(key="a.mp4", last_modified=0, size=1)],
        is_truncated=False,
        next_continuation_token="",
    )
    bucket.get_object.side_effect = missing_catalog
    monkeypatch.setattr(oss_store, "_bucket", lambda s: bucket)
    result = oss_store.list_objects(settings)
    assert bucket.list_objects_v2.call_args.kwargs["prefix"] == ""
    bucket.get_object.assert_called_once_with("catalog.json")
    assert result == {
        "objects": [
            {
                "key": "a.mp4",
                "name": "a.mp4",
                "size": 1,
                "last_modified": "1970-01-01T00:00:00Z",
                "kind": "video",
                "info": {},
            }
        ],
        "prefix": "",
        "truncated": False,
        "next_token": None,
        "catalog_error": None,
    }


def test_list_objects_failure_is_sanitized(settings, monkeypatch):
    bucket = Mock()
    bucket.list_objects_v2.side_effect = RuntimeError("403 Signature=abc")
    monkeypatch.setattr(oss_store, "_bucket", lambda s: bucket)
    with pytest.raises(UserError) as error:
        oss_store.list_objects(settings)
    assert "abc" not in str(error.value) and "文件列表失败" in str(error.value)
    with pytest.raises(UserError, match="分页标记"):
        oss_store.list_objects(settings, "bad\ntoken")


@pytest.mark.parametrize(
    "key", ["other/file.mp3", "file.mp3", "media/", "../media/file.mp3", "mediax/file.mp3"]
)
def test_listed_key_must_be_under_prefix(settings, key):
    with pytest.raises(UserError):
        oss_store.ensure_listed_key(key, settings)
    assert oss_store.ensure_listed_key("media/file.mp3", settings) == "media/file.mp3"


@pytest.mark.parametrize("body", [b"not json", b"[]", b'{"files": []}', b"\xff"])
def test_broken_catalog_keeps_listing_and_is_never_overwritten(settings, monkeypatch, body):
    bucket = Mock()
    bucket.list_objects_v2.return_value = SimpleNamespace(
        object_list=[SimpleNamespace(key="media/a.mp3", last_modified=0, size=1)],
        is_truncated=False,
        next_continuation_token="",
    )
    bucket.get_object.side_effect = lambda key: FakeObject(body)
    monkeypatch.setattr(oss_store, "_bucket", lambda s: bucket)
    result = oss_store.list_objects(settings)
    assert [o["info"] for o in result["objects"]] == [{}]
    assert "catalog.json" in result["catalog_error"]
    with pytest.raises(UserError, match="停止写入"):
        oss_store.record_upload("media/b.mp3", {"title": "B"}, settings)
    bucket.put_object.assert_not_called()


def test_catalog_read_failure_is_a_listing_warning(settings, monkeypatch):
    bucket = Mock()
    bucket.list_objects_v2.return_value = SimpleNamespace(
        object_list=[], is_truncated=False, next_continuation_token=""
    )
    bucket.get_object.side_effect = RuntimeError("403 Signature=abc")
    monkeypatch.setattr(oss_store, "_bucket", lambda s: bucket)
    result = oss_store.list_objects(settings)
    assert result["objects"] == [] and "abc" not in result["catalog_error"]
    assert "按文件名显示" in result["catalog_error"]


def test_record_upload_merges_into_private_catalog(settings, monkeypatch):
    bucket = Mock()
    existing = {"media/old.mp3": {"title": "旧歌", "custom": "kept as stored"}}
    bucket.get_object.side_effect = lambda key: FakeObject(catalog_body(existing))
    bucket.put_object.return_value = SimpleNamespace(status=200)
    monkeypatch.setattr(oss_store, "_bucket", lambda s: bucket)
    entry = oss_store.record_upload(
        "media/new.mp3",
        {
            "title": " 晴天\x00 ",
            "artist": None,
            "duration": 269.47,
            "source": "yt-dlp · BiliBili",
            "source_host": "www.bilibili.com",
            "mode": "audio",
            "size": 1234,
            "url": "https://cdn.example.com/a.mp3?sig=1",
        },
        settings,
    )
    key, body = bucket.put_object.call_args.args
    headers = bucket.put_object.call_args.kwargs["headers"]
    assert key == "media/catalog.json"
    assert headers["x-oss-object-acl"] == "private" and headers["Content-Type"].startswith("application/json")
    stored = json.loads(body.decode("utf-8"))
    assert stored["version"] == 1 and stored["updated_at"] == entry["uploaded_at"]
    assert stored["files"]["media/old.mp3"] == existing["media/old.mp3"]
    assert stored["files"]["media/new.mp3"] == entry
    assert entry["title"] == "晴天" and entry["duration"] == 269.5 and entry["size"] == 1234
    assert entry["content_type"] == "audio/mpeg" and entry["uploaded_at"].endswith("Z")
    assert "artist" not in entry and "url" not in entry
    assert "晴天" in body.decode("utf-8")  # Readable UTF-8, not \\u escapes.


def test_record_upload_creates_catalog_and_reports_failures(settings, monkeypatch):
    bucket = Mock()
    bucket.get_object.side_effect = missing_catalog
    bucket.put_object.return_value = SimpleNamespace(status=200)
    monkeypatch.setattr(oss_store, "_bucket", lambda s: bucket)
    oss_store.record_upload("media/a.mp3", {"title": "A"}, settings)
    stored = json.loads(bucket.put_object.call_args.args[1])
    assert list(stored["files"]) == ["media/a.mp3"]
    bucket.put_object.side_effect = RuntimeError("403 secret-token=abc")
    with pytest.raises(UserError) as error:
        oss_store.record_upload("media/b.mp3", {"title": "B"}, settings)
    assert "abc" not in str(error.value) and "曲目信息" in str(error.value)


def deletable_bucket(monkeypatch, files):
    bucket = Mock()
    if files is None:
        bucket.get_object.side_effect = missing_catalog
    else:
        bucket.get_object.side_effect = lambda key: FakeObject(catalog_body(files))
    bucket.delete_object.return_value = SimpleNamespace(status=204, request_id="req-d")
    bucket.put_object.return_value = SimpleNamespace(status=200)
    monkeypatch.setattr(oss_store, "_bucket", lambda s: bucket)
    return bucket


def test_delete_object_removes_catalog_entry(settings, monkeypatch):
    files = {"media/a.mp3": {"title": "A"}, "media/b.mp3": {"title": "B", "custom": 1}}
    bucket = deletable_bucket(monkeypatch, files)
    assert oss_store.delete_object("media/a.mp3", settings) == {
        "key": "media/a.mp3",
        "catalog": True,
        "warning": None,
    }
    bucket.delete_object.assert_called_once_with("media/a.mp3")
    key, body = bucket.put_object.call_args.args
    assert key == "media/catalog.json"
    assert bucket.put_object.call_args.kwargs["headers"]["x-oss-object-acl"] == "private"
    assert json.loads(body)["files"] == {"media/b.mp3": files["media/b.mp3"]}


@pytest.mark.parametrize("files", [None, {"media/other.mp3": {"title": "O"}}])
def test_delete_object_without_catalog_entry_leaves_catalog_alone(settings, monkeypatch, files):
    bucket = deletable_bucket(monkeypatch, files)
    result = oss_store.delete_object("media/a.mp3", settings)
    assert result == {"key": "media/a.mp3", "catalog": False, "warning": None}
    bucket.delete_object.assert_called_once_with("media/a.mp3")
    bucket.put_object.assert_not_called()


@pytest.mark.parametrize("body", [b"not json", b'{"files": []}'])
def test_delete_object_never_overwrites_broken_catalog(settings, monkeypatch, body):
    bucket = deletable_bucket(monkeypatch, {})
    bucket.get_object.side_effect = lambda key: FakeObject(body)
    result = oss_store.delete_object("media/a.mp3", settings)
    assert result["catalog"] is False and "未同步" in result["warning"]
    bucket.delete_object.assert_called_once_with("media/a.mp3")
    bucket.put_object.assert_not_called()


def test_delete_object_reports_catalog_write_failure_as_warning(settings, monkeypatch):
    bucket = deletable_bucket(monkeypatch, {"media/a.mp3": {"title": "A"}})
    bucket.put_object.side_effect = RuntimeError("403 secret-token=abc")
    result = oss_store.delete_object("media/a.mp3", settings)
    assert result["catalog"] is False and "未同步" in result["warning"] and "abc" not in result["warning"]


def test_delete_failure_is_redacted_and_keeps_catalog(settings, monkeypatch):
    bucket = deletable_bucket(monkeypatch, {"media/a.mp3": {"title": "A"}})
    bucket.delete_object.side_effect = RuntimeError("403 Signature=abc")
    with pytest.raises(UserError) as error:
        oss_store.delete_object("media/a.mp3", settings)
    assert "abc" not in str(error.value) and "删除 OSS 文件失败" in str(error.value)
    bucket.delete_object.side_effect = None
    bucket.delete_object.return_value = SimpleNamespace(status=500)
    with pytest.raises(UserError, match="未确认删除"):
        oss_store.delete_object("media/a.mp3", settings)
    bucket.get_object.assert_not_called()
    bucket.put_object.assert_not_called()


@pytest.mark.parametrize("key", ["media/catalog.json", "other/a.mp3", "media/", "media/../a.mp3"])
def test_delete_object_rejects_catalog_and_foreign_keys(settings, monkeypatch, key):
    bucket = deletable_bucket(monkeypatch, {})
    with pytest.raises(UserError):
        oss_store.delete_object(key, settings)
    bucket.delete_object.assert_not_called()


def test_catalog_writes_wait_for_the_cross_process_lock(settings, monkeypatch, catalog_lock):
    bucket = deletable_bucket(monkeypatch, {"media/a.mp3": {"title": "A"}})
    monkeypatch.setattr(oss_store, "CATALOG_LOCK_SECONDS", 0.2)
    catalog_lock.parent.mkdir()
    with catalog_lock.open("a") as holder:
        fcntl.flock(holder, fcntl.LOCK_EX)  # Another process (an upload worker) is writing.
        result = oss_store.delete_object("media/a.mp3", settings)
        assert result["catalog"] is False and "稍后重试" in result["warning"]
        with pytest.raises(UserError, match="稍后重试"):
            oss_store.record_upload("media/b.mp3", {"title": "B"}, settings)
        bucket.put_object.assert_not_called()
    oss_store.record_upload("media/b.mp3", {"title": "B"}, settings)
    bucket.put_object.assert_called_once()
