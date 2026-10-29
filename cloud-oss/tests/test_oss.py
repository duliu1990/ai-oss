import time
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

import pytest
from oss2.exceptions import ServerError
from pydantic import ValidationError

import oss_store
from config import Settings


@pytest.mark.parametrize(
    "key",
    [
        "",
        "/leading.txt",
        "back\\slash.txt",
        "../escape.txt",
        "folder/../escape.txt",
        "folder/./file.txt",
        "folder//file.txt",
        "control\x00.txt",
        "folder/",
        "a" * 1024,
    ],
)
def test_validate_key_rejects_illegal_keys(key):
    with pytest.raises(oss_store.UserError):
        oss_store.validate_key(key)


def test_validate_key_allows_explicit_folder_marker():
    assert oss_store.validate_key("folder/", allow_folder=True) == "folder/"


def test_object_prefix_is_normalized(settings):
    assert oss_store.object_prefix(settings) == "drive/"
    assert oss_store.resolve_directory_prefix("", settings) == "drive/"
    assert oss_store.resolve_directory_prefix("docs", settings) == "drive/docs/"
    assert oss_store.resolve_directory_prefix("drive/docs/", settings) == "drive/docs/"


@pytest.mark.parametrize("field_name", ["oss_prefix", "note_oss_prefix"])
@pytest.mark.parametrize("prefix", ["../", "safe/../bad", "bad\\prefix", "bad\x00prefix"])
def test_settings_rejects_invalid_prefix(field_name, prefix):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{field_name: prefix})


@pytest.mark.parametrize("field_name", ["oss_prefix", "note_oss_prefix"])
def test_settings_rejects_overlong_prefix(field_name):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{field_name: "a" * 1023})


def test_settings_normalizes_note_prefix():
    settings = Settings(_env_file=None, note_oss_prefix=" /notes ")

    assert settings.note_oss_prefix == "notes/"


def test_scope_rejects_keys_outside_configured_prefix(settings):
    with pytest.raises(oss_store.UserError, match="outside"):
        oss_store.ensure_scoped_key("other/file.txt", settings)
    with pytest.raises(oss_store.UserError, match="prefix itself"):
        oss_store.ensure_scoped_key("drive/", settings, allow_folder=True)


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        (None, None),
        ("", None),
        ("bytes=0-9", (0, 9)),
        ("bytes=10-", (10, None)),
        ("bytes=-25", (None, 25)),
        (" bytes=1-2 ", (1, 2)),
    ],
)
def test_parse_range_valid_forms(header, expected):
    assert oss_store.parse_range(header) == expected


@pytest.mark.parametrize(
    "header",
    ["items=0-1", "bytes=", "bytes=-0", "bytes=9-2", "bytes=a-b", "bytes=1-2,4-5"],
)
def test_parse_range_rejects_invalid_forms(header):
    assert oss_store.parse_range(header) is None


def test_list_directory_splits_files_and_folders(settings, fake_bucket):
    fake_bucket.objects.update(
        {
            "drive/": b"",
            "drive/a.txt": b"a",
            "drive/folder/b.txt": b"b",
            "unscoped.txt": b"outside",
        }
    )

    result = oss_store.list_directory("", "", settings, bucket=fake_bucket)

    assert [item["key"] for item in result["files"]] == ["drive/a.txt"]
    assert result["folders"] == [{"prefix": "drive/folder/", "name": "folder"}]
    assert result["common_prefixes"] == ["drive/folder/"]


def test_list_directory_paginates(settings, fake_bucket):
    fake_bucket.page_size = 1
    fake_bucket.objects.update({"drive/a.txt": b"a", "drive/b.txt": b"b"})

    first = oss_store.list_directory("", "", settings, bucket=fake_bucket)
    second = oss_store.list_directory("", first["next_marker"], settings, bucket=fake_bucket)

    assert first["truncated"] is True
    assert first["next_marker"] == "1"
    assert [item["name"] for item in first["files"]] == ["a.txt"]
    assert second["truncated"] is False
    assert [item["name"] for item in second["files"]] == ["b.txt"]


def test_search_objects_is_case_insensitive_and_scoped(settings, fake_bucket):
    fake_bucket.page_size = 1
    fake_bucket.objects.update(
        {
            "drive/docs/REPORT.pdf": b"one",
            "drive/docs/my-report.txt": b"two",
            "drive/other/report.txt": b"outside",
        }
    )

    result = oss_store.search_objects("report", "drive/docs/", settings, bucket=fake_bucket)

    assert [item["key"] for item in result["results"]] == [
        "drive/docs/REPORT.pdf",
        "drive/docs/my-report.txt",
    ]
    assert result["truncated"] is False


def test_get_bucket_uses_mocked_oss_bucket(settings, fake_bucket):
    assert oss_store.get_bucket(settings) is fake_bucket
    assert oss_store.get_bucket(settings) is fake_bucket


def test_put_delete_and_copy(settings, fake_bucket):
    uploaded = oss_store.put_object(
        "drive/source.txt",
        BytesIO(b"source"),
        settings,
        content_type="text/plain",
        bucket=fake_bucket,
    )
    copied = oss_store.copy_object(
        "drive/source.txt",
        "drive/copy.txt",
        settings,
        bucket=fake_bucket,
    )
    oss_store.delete_object("drive/source.txt", settings, bucket=fake_bucket)

    assert uploaded["key"] == "drive/source.txt"
    assert copied["key"] == "drive/copy.txt"
    assert fake_bucket.objects == {"drive/copy.txt": b"source"}
    put_call = next(call for call in fake_bucket.calls if call[0] == "put")
    assert put_call[3]["Content-Type"] == "text/plain"
    assert put_call[3]["x-oss-object-acl"] == "private"


def test_batch_delete(settings, fake_bucket):
    fake_bucket.objects.update({"drive/a": b"a", "drive/b": b"b", "drive/c": b"c"})

    deleted = oss_store.batch_delete_objects(
        ["drive/a", "drive/c"],
        settings,
        bucket=fake_bucket,
    )

    assert deleted == 2
    assert fake_bucket.objects == {"drive/b": b"b"}


def test_multipart_lifecycle(settings, fake_bucket):
    upload_id = oss_store.init_multipart_upload(
        "drive/large.bin",
        settings,
        content_type="application/octet-stream",
        bucket=fake_bucket,
    )
    first_etag = oss_store.upload_part(
        "drive/large.bin",
        upload_id,
        1,
        b"hello ",
        settings,
        bucket=fake_bucket,
    )
    second_etag = oss_store.upload_part(
        "drive/large.bin",
        upload_id,
        2,
        b"world",
        settings,
        bucket=fake_bucket,
    )
    result = oss_store.complete_multipart_upload(
        "drive/large.bin",
        upload_id,
        [(1, first_etag), (2, second_etag)],
        settings,
        bucket=fake_bucket,
    )

    assert result["key"] == "drive/large.bin"
    assert fake_bucket.objects["drive/large.bin"] == b"hello world"
    with pytest.raises(oss_store.UserError, match="Unknown or expired"):
        oss_store.multipart_key(upload_id)


def test_abort_multipart_lifecycle(settings, fake_bucket):
    upload_id = oss_store.init_multipart_upload(
        "drive/cancel.bin",
        settings,
        bucket=fake_bucket,
    )

    oss_store.abort_multipart_upload(
        "drive/cancel.bin",
        upload_id,
        settings,
        bucket=fake_bucket,
    )

    assert upload_id not in fake_bucket.multipart
    with pytest.raises(oss_store.UserError, match="Unknown or expired"):
        oss_store.multipart_key(upload_id)


@pytest.mark.parametrize("part_number", [0, 10001])
def test_upload_part_rejects_invalid_number(settings, fake_bucket, part_number):
    upload_id = oss_store.init_multipart_upload(
        "drive/large.bin",
        settings,
        bucket=fake_bucket,
    )

    with pytest.raises(oss_store.UserError, match="between 1 and 10000"):
        oss_store.upload_part(
            "drive/large.bin",
            upload_id,
            part_number,
            b"data",
            settings,
            bucket=fake_bucket,
        )


def _read_stream(stream: oss_store.ObjectStream) -> bytes:
    return b"".join(stream.body)


def test_open_stream_full_object(settings, fake_bucket):
    fake_bucket.objects["drive/data.bin"] = bytes(range(20))

    stream = oss_store.open_stream("drive/data.bin", None, settings, bucket=fake_bucket)

    assert stream.status == 200
    assert stream.headers["Content-Length"] == "20"
    assert _read_stream(stream) == bytes(range(20))


def test_open_stream_explicit_range(settings, fake_bucket):
    fake_bucket.objects["drive/data.bin"] = bytes(range(20))

    stream = oss_store.open_stream("drive/data.bin", "bytes=0-9", settings, bucket=fake_bucket)

    assert stream.status == 206
    assert stream.headers["Content-Range"] == "bytes 0-9/20"
    assert _read_stream(stream) == bytes(range(10))


def test_open_stream_open_ended_range(settings, fake_bucket):
    fake_bucket.objects["drive/data.bin"] = bytes(range(20))

    stream = oss_store.open_stream("drive/data.bin", "bytes=15-", settings, bucket=fake_bucket)

    assert stream.status == 206
    assert stream.headers["Content-Range"] == "bytes 15-19/20"
    assert _read_stream(stream) == bytes(range(15, 20))


def test_open_stream_suffix_range(settings, fake_bucket):
    fake_bucket.objects["drive/data.bin"] = bytes(range(20))

    stream = oss_store.open_stream("drive/data.bin", "bytes=-4", settings, bucket=fake_bucket)

    assert stream.status == 206
    assert stream.headers["Content-Range"] == "bytes 16-19/20"
    assert _read_stream(stream) == bytes(range(16, 20))


def test_open_stream_out_of_range_includes_size(settings, fake_bucket):
    fake_bucket.objects["drive/data.bin"] = b"short"

    with pytest.raises(oss_store.RangeNotSatisfiable) as caught:
        oss_store.open_stream("drive/data.bin", "bytes=20-30", settings, bucket=fake_bucket)

    assert caught.value.size == 5


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        ("drive/photo.jpg", "image/jpeg"),
        ("drive/song.mp3", "audio/mpeg"),
        ("drive/no-extension", "application/octet-stream"),
    ],
)
def test_mime_type_inference(settings, fake_bucket, key, expected):
    fake_bucket.objects[key] = b"content"

    metadata = oss_store.head_object(key, settings, bucket=fake_bucket)
    stream = oss_store.open_stream(key, None, settings, bucket=fake_bucket)

    assert metadata["content_type"] == expected
    assert stream.headers["Content-Type"] == expected
    assert _read_stream(stream) == b"content"


@pytest.mark.parametrize(
    ("remote_status", "expected_status", "expects_head"),
    [
        (None, "NeverEnabled", False),
        ("Enabled", "Enabled", True),
        ("Suspended", "Suspended", True),
    ],
)
def test_create_if_absent_uses_versioning_capability(
    settings,
    fake_bucket,
    remote_status,
    expected_status,
    expects_head,
):
    fake_bucket.versioning_status = remote_status

    result = oss_store.put_object_if_absent(
        "drive/new.txt",
        b"new",
        settings,
        content_type="text/plain",
        bucket=fake_bucket,
    )
    status = oss_store.bucket_versioning_status(settings, bucket=fake_bucket)

    assert result["etag"] == fake_bucket._etag(b"new")
    assert status == expected_status
    assert sum(call[0] == "versioning" for call in fake_bucket.calls) == 1
    assert any(call[0] == "head" for call in fake_bucket.calls) is expects_head
    put_call = next(call for call in fake_bucket.calls if call[0] == "put")
    assert put_call[3]["x-oss-forbid-overwrite"] == "true"


def test_versioning_403_is_cached_and_degrades_to_head(settings, fake_bucket, caplog):
    fake_bucket.versioning_error = ServerError(403, {}, b"", {"Code": "AccessDenied"})

    first = oss_store.bucket_versioning_status(settings, bucket=fake_bucket)
    second = oss_store.bucket_versioning_status(settings, bucket=fake_bucket)
    result = oss_store.put_object_if_absent(
        "drive/degraded.txt",
        b"safe",
        settings,
        bucket=fake_bucket,
    )

    assert first == second == "Unknown"
    assert result["etag"] == fake_bucket._etag(b"safe")
    assert sum(call[0] == "versioning" for call in fake_bucket.calls) == 1
    assert ("head", "drive/degraded.txt") in fake_bucket.calls
    assert "test-secret" not in caplog.text
    assert "test-id" not in caplog.text


def test_concurrent_same_key_create_is_serialized_in_process(settings, fake_bucket, monkeypatch):
    fake_bucket.versioning_status = "Enabled"
    original_put = fake_bucket.put_object

    def slow_put(key, data, headers=None):
        time.sleep(0.05)
        return original_put(key, data, headers=headers)

    monkeypatch.setattr(fake_bucket, "put_object", slow_put)

    def create(body: bytes):
        try:
            oss_store.put_object_if_absent(
                "drive/concurrent.txt",
                body,
                settings,
                bucket=fake_bucket,
            )
            return "created"
        except oss_store.ConflictError:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(create, [b"first", b"second"]))

    assert sorted(outcomes) == ["conflict", "created"]
    assert sum(call[0] == "put" for call in fake_bucket.calls) == 1
    assert fake_bucket.objects["drive/concurrent.txt"] in {b"first", b"second"}
    assert oss_store._create_locks == {}


class _BoundedBody:
    def __init__(self, data: bytes, content_length: int | None):
        self._stream = BytesIO(data)
        self.content_length = content_length
        self.etag = "same-get-etag"
        self.read_amounts: list[int | None] = []
        self.closed = False

    def read(self, amount=None):
        self.read_amounts.append(amount)
        return self._stream.read(amount)

    def close(self):
        self.closed = True
        self._stream.close()


def test_bounded_read_accepts_missing_content_length(settings, fake_bucket, monkeypatch):
    result_body = _BoundedBody(b"snapshot", None)
    monkeypatch.setattr(fake_bucket, "get_object", lambda key: result_body)

    result = oss_store.read_object_bounded("drive/snapshot.txt", 8, settings, bucket=fake_bucket)

    assert result == {
        "key": "drive/snapshot.txt",
        "body": b"snapshot",
        "etag": "same-get-etag",
        "size": 8,
    }
    assert result_body.read_amounts == [9]
    assert result_body.closed is True


@pytest.mark.parametrize("reported_length", [None, 1])
def test_bounded_read_rejects_stream_over_limit(
    settings,
    fake_bucket,
    monkeypatch,
    reported_length,
):
    result_body = _BoundedBody(b"123456", reported_length)
    monkeypatch.setattr(fake_bucket, "get_object", lambda key: result_body)

    with pytest.raises(oss_store.TooLargeError):
        oss_store.read_object_bounded("drive/large.txt", 5, settings, bucket=fake_bucket)

    assert result_body.read_amounts == [6]
    assert result_body.closed is True


def test_bounded_read_rejects_declared_oversize_before_stream_read(settings, fake_bucket, monkeypatch):
    result_body = _BoundedBody(b"ignored", 6)
    monkeypatch.setattr(fake_bucket, "get_object", lambda key: result_body)

    with pytest.raises(oss_store.TooLargeError):
        oss_store.read_object_bounded("drive/large.txt", 5, settings, bucket=fake_bucket)

    assert result_body.read_amounts == []
    assert result_body.closed is True
