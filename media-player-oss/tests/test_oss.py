import json

import pytest
from oss2.exceptions import ServerError

import oss_store
from security import UserError
from tests.conftest import FakeBucket


def catalog(files) -> bytes:
    return json.dumps({"version": 1, "files": files}, ensure_ascii=False).encode("utf-8")


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        (None, None),
        ("", None),
        ("bytes=0-", (0, None)),
        ("bytes=100-199", (100, 199)),
        ("bytes=-500", (None, 500)),
        ("bytes=-0", None),
        ("bytes=5-1", None),
        ("bytes=0-1,5-9", None),
        ("items=0-1", None),
        ("bytes=-", None),
    ],
)
def test_parse_range(header, expected):
    assert oss_store.parse_range(header) == expected


@pytest.mark.parametrize(
    "key",
    ["other/a.mp3", "media/../secret.mp3", "/media/a.mp3", "media//a.mp3", "media/a.txt", "media/a.mp4", ""],
)
def test_ensure_audio_key_rejects(key, settings):
    with pytest.raises(UserError):
        oss_store.ensure_audio_key(key, settings)


def test_ensure_audio_key_accepts_nested_audio(settings):
    assert oss_store.ensure_audio_key("media/album/Song.FLAC", settings) == "media/album/Song.FLAC"


def test_list_audio_filters_sorts_and_paginates(settings):
    bucket = FakeBucket(
        {
            "media/old.mp3": b"a",
            "media/new.m4a": b"bb",
            "media/video.mp4": b"v",
            "media/notes.txt": b"t",
            "media/folder/": b"",
            "media/folder/deep.flac": b"ccc",
        },
        page_size=2,
        modified={"media/old.mp3": 1_600_000_000, "media/new.m4a": 1_800_000_000},
    )
    result = oss_store.list_audio(settings, bucket)
    assert [t["key"] for t in result["tracks"]] == [
        "media/new.m4a",
        "media/folder/deep.flac",
        "media/old.mp3",
    ]
    assert result["tracks"][1]["name"] == "folder/deep.flac"
    assert result["tracks"][0]["size"] == 2
    assert result["tracks"][0]["last_modified"].endswith("Z")
    assert result["truncated"] is False


def test_list_audio_reports_cap(settings, monkeypatch):
    monkeypatch.setattr(oss_store, "MAX_LIST_PAGES", 1)
    bucket = FakeBucket({f"media/{i}.mp3": b"x" for i in range(3)}, page_size=2)
    result = oss_store.list_audio(settings, bucket)
    assert len(result["tracks"]) == 2
    assert result["truncated"] is True


def test_list_audio_attaches_catalog_info(settings):
    files = {
        "media/a.mp3": {
            "title": "  晴天\n(Live) ",
            "artist": "周杰伦",
            "duration": 269.5,
            "source": "yt-dlp · Youtube",
            "source_host": "www.youtube.com",
            "secret": "must not leak",
        },
        "media/b.mp3": {"title": 123, "artist": "", "duration": True},
        "media/gone.mp3": {"title": "已删除"},
    }
    bucket = FakeBucket({"media/a.mp3": b"a", "media/b.mp3": b"b", "media/catalog.json": catalog(files)})
    result = oss_store.list_audio(settings, bucket)
    tracks = {t["key"]: t for t in result["tracks"]}
    # catalog.json itself is not audio, and entries for deleted objects are ignored.
    assert set(tracks) == {"media/a.mp3", "media/b.mp3"}
    assert tracks["media/a.mp3"]["info"] == {
        "title": "晴天 (Live)",
        "artist": "周杰伦",
        "duration": 269.5,
        "source": "yt-dlp · Youtube",
        "source_host": "www.youtube.com",
    }
    assert tracks["media/b.mp3"]["info"] == {}
    assert result["catalog_error"] is None
    assert ("media/catalog.json", None, None) in bucket.requests


def test_list_audio_without_catalog(settings):
    result = oss_store.list_audio(settings, FakeBucket({"media/a.mp3": b"a"}))
    assert result["tracks"][0]["info"] == {}
    assert result["catalog_error"] is None


@pytest.mark.parametrize("body", [b"{not json", b"\xff\xfe", b"[]", b'{"files": []}'])
def test_broken_catalog_keeps_listing(settings, body):
    bucket = FakeBucket({"media/a.mp3": b"a", "media/catalog.json": body})
    result = oss_store.list_audio(settings, bucket)
    assert [t["key"] for t in result["tracks"]] == ["media/a.mp3"]
    assert result["tracks"][0]["info"] == {}
    assert "catalog.json 无法解析" in result["catalog_error"]


def test_oversized_catalog_is_not_read(settings, monkeypatch):
    monkeypatch.setattr(oss_store, "MAX_CATALOG_BYTES", 10)
    bucket = FakeBucket({"media/a.mp3": b"a", "media/catalog.json": catalog({})})
    result = oss_store.list_audio(settings, bucket)
    assert "无法解析" in result["catalog_error"]


def test_catalog_read_failure_is_a_warning(settings):
    bucket = FakeBucket({"media/a.mp3": b"a"})
    original = bucket.get_object

    def failing(key, *args, **kwargs):
        if key == "media/catalog.json":
            raise ServerError(
                403, {}, b"", {"Code": "AccessDenied", "Message": "OSSAccessKeyId=LTAI5tABCDEFGHIJKLMN"}
            )
        return original(key, *args, **kwargs)

    bucket.get_object = failing
    result = oss_store.list_audio(settings, bucket)
    assert len(result["tracks"]) == 1
    assert result["catalog_error"].startswith("读取 catalog.json 失败")
    assert "LTAI5tABCDEFGHIJKLMN" not in result["catalog_error"]


def test_list_audio_requires_config():
    from config import Settings

    with pytest.raises(UserError, match="OSS 配置不完整"):
        oss_store.list_audio(Settings(_env_file=None))


def test_open_stream_full_and_range(settings):
    data = bytes(range(256)) * 1024
    bucket = FakeBucket({"media/a.mp3": data})

    full = oss_store.open_stream("media/a.mp3", None, settings, bucket)
    assert full.status == 200
    assert full.headers["Content-Length"] == str(len(data))
    assert full.headers["Content-Type"] == "audio/mpeg"
    assert b"".join(full.body) == data
    assert bucket.requests[-1] == ("media/a.mp3", None, None)

    part = oss_store.open_stream("media/a.mp3", "bytes=1000-", settings, bucket)
    assert part.status == 206
    assert part.headers["Content-Range"] == f"bytes 1000-{len(data) - 1}/{len(data)}"
    assert b"".join(part.body) == data[1000:]
    assert bucket.requests[-1][2] == {"x-oss-range-behavior": "standard"}


def test_open_stream_closes_result_when_client_stops(settings):
    bucket = FakeBucket({"media/a.mp3": b"x" * (oss_store.CHUNK_SIZE * 3)})
    results = []
    original = bucket.get_object

    def tracking(*args, **kwargs):
        results.append(original(*args, **kwargs))
        return results[-1]

    bucket.get_object = tracking
    stream = oss_store.open_stream("media/a.mp3", None, settings, bucket)
    next(stream.body)
    stream.body.close()
    assert results[0].closed


def test_open_stream_out_of_range(settings):
    bucket = FakeBucket({"media/a.mp3": b"abc"})
    with pytest.raises(oss_store.RangeNotSatisfiable) as info:
        oss_store.open_stream("media/a.mp3", "bytes=10-", settings, bucket)
    assert info.value.size == 3


def test_open_stream_missing_object(settings):
    with pytest.raises(UserError, match="找不到该文件"):
        oss_store.open_stream("media/gone.mp3", None, settings, FakeBucket({}))


def test_bucket_uses_https_endpoint(settings):
    settings.oss_endpoint = "oss-cn-hangzhou.aliyuncs.com"
    bucket = oss_store._make_bucket(settings)
    assert bucket.endpoint == "https://oss-cn-hangzhou.aliyuncs.com"
    assert bucket.bucket_name == "bucket"
