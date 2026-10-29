import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import MAX_TEXT_JSON_BODY_SIZE, create_app
from config import Settings


def test_health_is_independent_of_oss(client):
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_config_exposes_only_public_values(client):
    response = client.get("/api/config")

    assert response.status_code == 200
    assert response.json() == {"bucket": "test-bucket", "prefix": "drive/", "port": 9876}
    serialized = response.text.casefold()
    assert "secret" not in serialized
    assert "access" not in serialized
    assert "test-id" not in serialized


def test_regular_api_denies_framing(client):
    response = client.get("/api/config")

    assert response.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


def test_list_root_separates_files_and_folders(client, fake_bucket):
    fake_bucket.objects.update(
        {
            "drive/readme.txt": b"readme",
            "drive/music/song.mp3": b"song",
            "drive/photos/image.jpg": b"image",
        }
    )

    response = client.get("/api/files")

    assert response.status_code == 200
    payload = response.json()
    assert payload["prefix"] == "drive/"
    assert [item["key"] for item in payload["files"]] == ["drive/readme.txt"]
    assert payload["folders"] == [
        {"prefix": "drive/music/", "name": "music"},
        {"prefix": "drive/photos/", "name": "photos"},
    ]
    assert payload["next_marker"] is None
    assert payload["truncated"] is False


def test_list_subdirectory(client, fake_bucket):
    fake_bucket.objects.update(
        {
            "drive/docs/guide.pdf": b"guide",
            "drive/docs/archive/old.pdf": b"old",
            "drive/outside.txt": b"outside",
        }
    )

    response = client.get("/api/files", params={"prefix": "drive/docs/"})

    assert response.status_code == 200
    payload = response.json()
    assert [item["name"] for item in payload["files"]] == ["guide.pdf"]
    assert payload["folders"] == [{"prefix": "drive/docs/archive/", "name": "archive"}]


def test_list_uses_continuation_token(client, fake_bucket):
    fake_bucket.page_size = 2
    fake_bucket.objects.update(
        {
            "drive/a.txt": b"a",
            "drive/b.txt": b"b",
            "drive/c.txt": b"c",
        }
    )

    first = client.get("/api/files").json()
    second = client.get("/api/files", params={"marker": first["next_marker"]}).json()

    assert first["truncated"] is True
    assert first["next_marker"] == "2"
    assert [item["name"] for item in first["files"]] == ["a.txt", "b.txt"]
    assert second["truncated"] is False
    assert [item["name"] for item in second["files"]] == ["c.txt"]


def test_search_is_case_insensitive_and_prefix_confined(client, fake_bucket):
    fake_bucket.objects.update(
        {
            "drive/docs/Quarterly-REPORT.PDF": b"report",
            "drive/docs/report-notes.txt": b"notes",
            "drive/music/report.mp3": b"music",
        }
    )

    response = client.get("/api/files/search", params={"q": "report", "prefix": "drive/docs/"})

    assert response.status_code == 200
    assert [item["key"] for item in response.json()["results"]] == [
        "drive/docs/Quarterly-REPORT.PDF",
        "drive/docs/report-notes.txt",
    ]


def test_download_complete_file(client, fake_bucket):
    fake_bucket.objects["drive/hello.txt"] = b"hello world"

    response = client.get("/api/files/download", params={"key": "drive/hello.txt"})

    assert response.status_code == 200
    assert response.content == b"hello world"
    assert response.headers["content-type"].startswith("text/plain")
    assert response.headers["content-length"] == "11"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["x-frame-options"] == "SAMEORIGIN"
    assert "frame-ancestors 'self'" in response.headers["content-security-policy"]


def test_download_pdf_with_special_characters_is_inline(client, fake_bucket):
    key = "drive/季度 报告+最终版.pdf"
    fake_bucket.objects[key] = b"%PDF-1.7 test"

    response = client.get("/api/files/download", params={"key": key})

    assert response.status_code == 200
    assert response.content == b"%PDF-1.7 test"
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"].startswith("inline;")
    assert response.headers["x-frame-options"] == "SAMEORIGIN"
    assert "frame-ancestors 'self'" in response.headers["content-security-policy"]


def test_download_byte_range(client, fake_bucket):
    fake_bucket.objects["drive/data.bin"] = bytes(range(32))

    response = client.get(
        "/api/files/download",
        params={"key": "drive/data.bin"},
        headers={"Range": "bytes=0-9"},
    )

    assert response.status_code == 206
    assert response.content == bytes(range(10))
    assert response.headers["content-range"] == "bytes 0-9/32"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-length"] == "10"


def test_download_out_of_bounds_range(client, fake_bucket):
    fake_bucket.objects["drive/data.bin"] = b"short"

    response = client.get(
        "/api/files/download",
        params={"key": "drive/data.bin"},
        headers={"Range": "bytes=50-60"},
    )

    assert response.status_code == 416
    assert response.headers["content-range"] == "bytes */5"
    assert response.headers["accept-ranges"] == "bytes"


def test_download_attachment(client, fake_bucket):
    fake_bucket.objects["drive/my file.txt"] = b"content"

    response = client.get(
        "/api/files/download",
        params={"key": "drive/my file.txt", "download": "true"},
    )

    assert response.status_code == 200
    assert response.headers["content-disposition"].startswith('attachment; filename="my file.txt"')
    assert response.headers["x-frame-options"] == "SAMEORIGIN"
    assert "frame-ancestors 'self'" in response.headers["content-security-policy"]


def test_delete_file_and_missing_file_are_idempotent(client, fake_bucket):
    fake_bucket.objects["drive/remove.txt"] = b"remove"

    first = client.delete("/api/files", params={"key": "drive/remove.txt"})
    second = client.delete("/api/files", params={"key": "drive/missing.txt"})

    assert first.status_code == 200
    assert first.json() == {"ok": True}
    assert second.status_code == 200
    assert "drive/remove.txt" not in fake_bucket.objects


def test_create_folder_marker(client, fake_bucket):
    response = client.post("/api/files/folder", json={"prefix": "new-folder"})

    assert response.status_code == 201
    assert response.json() == {"prefix": "drive/new-folder/"}
    assert fake_bucket.objects["drive/new-folder/"] == b""


def test_delete_folder_recursively(client, fake_bucket):
    fake_bucket.objects.update(
        {
            "drive/archive/": b"",
            "drive/archive/a.txt": b"a",
            "drive/archive/nested/b.txt": b"b",
            "drive/keep.txt": b"keep",
        }
    )

    response = client.delete("/api/files/folder", params={"prefix": "drive/archive/"})

    assert response.status_code == 200
    assert response.json() == {"deleted": 3}
    assert fake_bucket.objects == {"drive/keep.txt": b"keep"}


def test_rename_file(client, fake_bucket):
    fake_bucket.objects["drive/docs/old.txt"] = b"contents"

    response = client.post(
        "/api/files/rename",
        json={"key": "drive/docs/old.txt", "new_name": "new.txt"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "old_key": "drive/docs/old.txt",
        "new_key": "drive/docs/new.txt",
    }
    assert fake_bucket.objects["drive/docs/new.txt"] == b"contents"
    assert "drive/docs/old.txt" not in fake_bucket.objects


def test_rename_folder_recursively(client, fake_bucket):
    fake_bucket.objects.update(
        {
            "drive/old/": b"",
            "drive/old/a.txt": b"a",
            "drive/old/nested/b.txt": b"b",
        }
    )

    response = client.post(
        "/api/files/rename",
        json={"key": "drive/old/", "new_name": "new"},
    )

    assert response.status_code == 200
    assert fake_bucket.objects == {
        "drive/new/": b"",
        "drive/new/a.txt": b"a",
        "drive/new/nested/b.txt": b"b",
    }


def test_move_file(client, fake_bucket):
    fake_bucket.objects["drive/source.txt"] = b"source"

    response = client.post(
        "/api/files/move",
        json={"key": "drive/source.txt", "destination": "drive/destination/"},
    )

    assert response.status_code == 200
    assert response.json()["new_key"] == "drive/destination/source.txt"
    assert fake_bucket.objects["drive/destination/source.txt"] == b"source"
    assert "drive/source.txt" not in fake_bucket.objects


def test_move_folder_recursively(client, fake_bucket):
    fake_bucket.objects.update(
        {
            "drive/source/": b"",
            "drive/source/a.txt": b"a",
            "drive/source/nested/b.txt": b"b",
        }
    )

    response = client.post(
        "/api/files/move",
        json={"key": "drive/source/", "destination": "drive/target/"},
    )

    assert response.status_code == 200
    assert fake_bucket.objects == {
        "drive/target/source/": b"",
        "drive/target/source/a.txt": b"a",
        "drive/target/source/nested/b.txt": b"b",
    }


@pytest.mark.parametrize(
    "key",
    ["../escape.txt", "/drive/escape.txt", "drive\\escape.txt", "outside/escape.txt"],
)
def test_key_escape_attempts_are_rejected(client, key):
    response = client.delete("/api/files", params={"key": key})

    assert response.status_code in {400, 422}


@pytest.mark.parametrize("prefix", ["../", "drive/../", "drive\\bad/"])
def test_invalid_prefixes_are_rejected(client, prefix):
    response = client.get("/api/files", params={"prefix": prefix})

    assert response.status_code in {400, 422}


def test_leading_slash_prefix_is_rejected(client):
    response = client.get("/api/files", params={"prefix": "/docs/"})

    assert response.status_code in {400, 422}


def test_unconfigured_oss_returns_friendly_error(unconfigured_settings, fake_bucket):
    with TestClient(create_app(unconfigured_settings)) as test_client:
        response = test_client.get("/api/files")

    assert response.status_code == 400
    assert response.json()["detail"].startswith("OSS configuration is incomplete:")
    assert "Internal server error" not in response.text


def test_missing_static_index_returns_503(monkeypatch, settings, tmp_path: Path):
    monkeypatch.setattr(Settings, "frontend_path", property(lambda self: tmp_path))

    with TestClient(create_app(settings)) as test_client:
        response = test_client.get("/")

    assert response.status_code == 503
    assert response.json() == {"detail": "Frontend build missing. Build frontend/dist first."}


@pytest.mark.parametrize(
    ("extension", "content", "expected_type"),
    [
        ("md", "# Title\n", "text/markdown; charset=utf-8"),
        ("txt", "plain text", "text/plain; charset=utf-8"),
    ],
)
def test_create_text_file_with_initial_content(client, fake_bucket, extension, content, expected_type):
    response = client.post(
        "/api/files/create",
        json={"prefix": "drive/docs/", "name": "notes", "extension": extension, "content": content},
    )

    body = content.encode()
    assert response.status_code == 201
    assert response.json() == {
        "key": f"drive/docs/notes.{extension}",
        "etag": fake_bucket._etag(body),
        "size": len(body),
    }
    assert fake_bucket.objects[f"drive/docs/notes.{extension}"] == body
    headers = fake_bucket.object_headers[f"drive/docs/notes.{extension}"]
    assert headers["Content-Type"] == expected_type
    assert headers["x-oss-forbid-overwrite"] == "true"


def test_create_text_file_defaults_to_empty_content(client, fake_bucket):
    response = client.post(
        "/api/files/create",
        json={"prefix": "", "name": "empty", "extension": "txt"},
    )

    assert response.status_code == 201
    assert response.json()["size"] == 0
    assert fake_bucket.objects["drive/empty.txt"] == b""


def test_create_text_file_does_not_overwrite_existing_object(client, fake_bucket):
    fake_bucket.objects["drive/existing.md"] = b"original"

    response = client.post(
        "/api/files/create",
        json={"prefix": "", "name": "existing", "extension": "md", "content": "replacement"},
    )

    assert response.status_code == 409
    assert fake_bucket.objects["drive/existing.md"] == b"original"


@pytest.mark.parametrize("extension", ["html", "MD", ""])
def test_create_text_file_rejects_unsupported_extension(client, extension):
    response = client.post(
        "/api/files/create",
        json={"prefix": "", "name": "notes", "extension": extension},
    )

    assert response.status_code == 422


@pytest.mark.parametrize("name", ["notes.md", "NOTES.TXT"])
def test_create_text_file_rejects_name_with_text_extension(client, name):
    response = client.post(
        "/api/files/create",
        json={"prefix": "", "name": name, "extension": "md"},
    )

    assert response.status_code == 400


@pytest.mark.parametrize("name", ["../notes", "bad/name", "bad\\name", " "])
def test_create_text_file_rejects_invalid_name(client, name):
    response = client.post(
        "/api/files/create",
        json={"prefix": "", "name": name, "extension": "txt"},
    )

    assert response.status_code in {400, 422}


@pytest.mark.parametrize("prefix", ["/outside/", "drive/../outside/"])
def test_create_text_file_rejects_prefix_escape(client, prefix):
    response = client.post(
        "/api/files/create",
        json={"prefix": prefix, "name": "notes", "extension": "txt"},
    )

    assert response.status_code == 400


def test_create_text_file_accepts_one_mibibyte(client, fake_bucket):
    content = "a" * (1024 * 1024)

    response = client.post(
        "/api/files/create",
        json={"prefix": "", "name": "boundary", "extension": "txt", "content": content},
    )

    assert response.status_code == 201
    assert response.json()["size"] == 1024 * 1024
    assert len(fake_bucket.objects["drive/boundary.txt"]) == 1024 * 1024


def test_create_text_file_rejects_content_over_one_mibibyte(client):
    response = client.post(
        "/api/files/create",
        json={
            "prefix": "",
            "name": "too-large",
            "extension": "txt",
            "content": "a" * (1024 * 1024 + 1),
        },
    )

    assert response.status_code == 413


@pytest.mark.parametrize(
    ("key", "stored", "expected"),
    [
        ("drive/normal.md", b"line one\nline two", "line one\nline two"),
        ("drive/bom.txt", b"\xef\xbb\xbfhello", "hello"),
        ("drive/empty.txt", b"", ""),
    ],
)
def test_read_text_file(client, fake_bucket, key, stored, expected):
    fake_bucket.objects[key] = stored

    response = client.get("/api/files/edit", params={"key": key})

    assert response.status_code == 200
    assert response.json() == {
        "key": key,
        "content": expected,
        "etag": fake_bucket._etag(stored),
        "size": len(stored),
        "content_type": "text/markdown; charset=utf-8"
        if key.endswith(".md")
        else "text/plain; charset=utf-8",
    }


def test_read_text_file_accepts_uppercase_extension(client, fake_bucket):
    fake_bucket.objects["drive/NOTES.MD"] = b"content"

    response = client.get("/api/files/edit", params={"key": "drive/NOTES.MD"})

    assert response.status_code == 200
    assert response.json()["content_type"] == "text/markdown; charset=utf-8"


def test_read_text_file_rejects_non_utf8_content(client, fake_bucket):
    fake_bucket.objects["drive/binary.txt"] = b"\xff\xfe"

    response = client.get("/api/files/edit", params={"key": "drive/binary.txt"})

    assert response.status_code == 400


def test_read_text_file_rejects_oversize_object_from_get_metadata(client, fake_bucket):
    fake_bucket.objects["drive/large.txt"] = b"a" * (1024 * 1024 + 1)

    response = client.get("/api/files/edit", params={"key": "drive/large.txt"})

    assert response.status_code == 413
    assert sum(call[0] == "get" for call in fake_bucket.calls) == 1
    assert not any(call[0] == "head" for call in fake_bucket.calls)


def test_read_text_file_returns_404_for_missing_object(client):
    response = client.get("/api/files/edit", params={"key": "drive/missing.txt"})

    assert response.status_code == 404
    assert response.json() == {"detail": "Object not found."}


@pytest.mark.parametrize("key", ["drive/image.png", "drive/no-extension"])
def test_read_text_file_rejects_non_text_extension(client, fake_bucket, key):
    fake_bucket.objects[key] = b"content"

    response = client.get("/api/files/edit", params={"key": key})

    assert response.status_code == 400


def test_save_text_file_changes_etag_and_preserves_newlines(client, fake_bucket):
    key = "drive/notes.md"
    original = b"old"
    content = "new\ncontent\n"
    fake_bucket.objects[key] = original

    response = client.put(
        "/api/files/edit",
        json={"key": key, "content": content, "expected_etag": fake_bucket._etag(original)},
    )

    encoded = content.encode()
    assert response.status_code == 200
    assert response.json() == {"key": key, "etag": fake_bucket._etag(encoded), "size": len(encoded)}
    assert response.json()["etag"] != fake_bucket._etag(original)
    assert fake_bucket.objects[key] == encoded
    assert fake_bucket.object_headers[key]["Content-Type"] == "text/markdown; charset=utf-8"


def test_save_text_file_returns_current_etag_on_conflict(client, fake_bucket):
    key = "drive/notes.txt"
    fake_bucket.objects[key] = b"external change"
    current_etag = fake_bucket._etag(fake_bucket.objects[key])

    response = client.put(
        "/api/files/edit",
        json={"key": key, "content": "mine", "expected_etag": "stale-etag"},
    )

    assert response.status_code == 412
    assert response.json() == {
        "detail": "文件已被外部修改，请刷新后重试。",
        "current_etag": current_etag,
    }
    assert fake_bucket.objects[key] == b"external change"


def test_save_text_file_force_overwrites_etag_conflict(client, fake_bucket):
    key = "drive/notes.txt"
    fake_bucket.objects[key] = b"external change"

    response = client.put(
        "/api/files/edit",
        json={"key": key, "content": "forced", "expected_etag": "stale-etag", "force": True},
    )

    assert response.status_code == 200
    assert fake_bucket.objects[key] == b"forced"


def test_save_text_file_allows_empty_content(client, fake_bucket):
    key = "drive/notes.txt"
    fake_bucket.objects[key] = b"not empty"

    response = client.put(
        "/api/files/edit",
        json={"key": key, "content": "", "expected_etag": fake_bucket._etag(b"not empty")},
    )

    assert response.status_code == 200
    assert response.json()["size"] == 0
    assert fake_bucket.objects[key] == b""


def test_save_text_file_returns_404_after_deletion(client, fake_bucket):
    response = client.put(
        "/api/files/edit",
        json={"key": "drive/deleted.md", "content": "new", "expected_etag": "old-etag"},
    )

    assert response.status_code == 404
    assert "drive/deleted.md" not in fake_bucket.objects


def test_save_text_file_rejects_content_over_one_mibibyte(client, fake_bucket):
    key = "drive/large.txt"
    fake_bucket.objects[key] = b"old"

    response = client.put(
        "/api/files/edit",
        json={
            "key": key,
            "content": "é" * (1024 * 1024 // 2 + 1),
            "expected_etag": fake_bucket._etag(b"old"),
        },
    )

    assert response.status_code == 413
    assert fake_bucket.objects[key] == b"old"


@pytest.mark.parametrize(
    "key",
    ["../escape.txt", "/drive/escape.txt", "drive\\escape.txt", "outside/escape.txt"],
)
def test_save_text_file_rejects_path_attack(client, key):
    response = client.put(
        "/api/files/edit",
        json={"key": key, "content": "attack", "expected_etag": "etag"},
    )

    assert response.status_code == 400


def test_read_text_file_uses_content_and_etag_from_same_get(client, fake_bucket, monkeypatch):
    key = "drive/snapshot.txt"
    current = b"new snapshot"
    fake_bucket.objects[key] = current

    def stale_head(_key):
        fake_bucket.calls.append(("head", _key))
        return SimpleNamespace(content_length=3, etag="stale-etag")

    monkeypatch.setattr(fake_bucket, "head_object", stale_head)

    response = client.get("/api/files/edit", params={"key": key})

    assert response.status_code == 200
    assert response.json()["content"] == "new snapshot"
    assert response.json()["etag"] == fake_bucket._etag(current)
    assert not any(call[0] == "head" for call in fake_bucket.calls)


def test_text_json_content_length_over_limit_returns_413_before_parsing(client):
    response = client.post(
        "/api/files/create",
        content=b"{}",
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(MAX_TEXT_JSON_BODY_SIZE + 1),
        },
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Request body exceeds the 7 MiB limit."}


def test_text_json_chunked_body_over_limit_returns_413(client):
    def chunks():
        yield b'{"content":"'
        yield b"a" * MAX_TEXT_JSON_BODY_SIZE
        yield b'"}'

    response = client.post(
        "/api/files/create",
        content=chunks(),
        headers={"Content-Type": "application/json", "Transfer-Encoding": "chunked"},
    )

    assert response.status_code == 413


def test_text_json_rejects_small_extra_field(client):
    response = client.post(
        "/api/files/create",
        json={
            "prefix": "",
            "name": "extra",
            "extension": "txt",
            "content": "valid",
            "unused": "not accepted",
        },
    )

    assert response.status_code == 422


def test_text_json_huge_extra_field_is_stopped_by_body_limit(client):
    payload = {
        "prefix": "",
        "name": "extra",
        "extension": "txt",
        "content": "valid",
        "unused": "x" * (8 * 1024 * 1024),
    }

    response = client.post("/api/files/create", json=payload)

    assert response.status_code == 413


def test_create_accepts_one_mibibyte_of_maximally_escaped_json(client, fake_bucket):
    content = "\x00" * (1024 * 1024)
    encoded = json.dumps({"prefix": "", "name": "escaped", "extension": "txt", "content": content}).encode()
    assert len(encoded) < MAX_TEXT_JSON_BODY_SIZE

    response = client.post(
        "/api/files/create",
        content=encoded,
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 201
    assert response.json()["size"] == 1024 * 1024
    assert fake_bucket.objects["drive/escaped.txt"] == b"\x00" * (1024 * 1024)


@pytest.mark.parametrize(
    ("path", "method", "payload"),
    [
        (
            "/api/files/create",
            "post",
            b'{"prefix":"","name":"valid","extension":"txt","content":"\\ud800"}',
        ),
        (
            "/api/files/create",
            "post",
            b'{"prefix":"","name":"\\ud800","extension":"txt","content":""}',
        ),
        (
            "/api/files/edit",
            "put",
            b'{"key":"drive/\\ud800.txt","content":"valid","expected_etag":"etag"}',
        ),
    ],
)
def test_text_json_lone_surrogate_returns_400(client, path, method, payload):
    response = getattr(client, method)(
        path,
        content=payload,
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 400


# ── Notes API ──────────────────────────────────────────────────────────


def test_notes_missing_directory_returns_configured_prefix(client, fake_bucket):
    fake_bucket.objects["drive/outside.md"] = b"outside"

    response = client.get("/api/notes")

    assert response.status_code == 200
    assert response.json() == {"prefix": "notes/", "notes": []}


def test_notes_returns_only_top_level_markdown_files_in_configured_prefix(client, fake_bucket):
    fake_bucket.objects.update(
        {
            "notes/note.MD": b"hello",
            "notes/plain.txt": b"plain text",
            "notes/archive/nested.md": b"nested",
            "drive/my-note/legacy.md": b"legacy",
            "drive/outside.md": b"outside",
        }
    )

    response = client.get("/api/notes")

    assert response.status_code == 200
    assert response.json() == {
        "prefix": "notes/",
        "notes": [
            {
                "key": "notes/note.MD",
                "name": "note.MD",
                "folder": "notes/",
                "size": 5,
                "last_modified": "2026-01-02T00:00:00Z",
            }
        ],
    }


def test_notes_sorted_by_last_modified_descending(client, fake_bucket):
    fake_bucket.objects.update(
        {
            "notes/old.md": b"old",
            "notes/new.md": b"new",
            "notes/mid.md": b"mid",
        }
    )
    fake_bucket.modified.update(
        {
            "notes/old.md": datetime(2025, 1, 1, tzinfo=UTC),
            "notes/new.md": datetime(2026, 6, 15, tzinfo=UTC),
            "notes/mid.md": datetime(2026, 3, 1, tzinfo=UTC),
        }
    )

    response = client.get("/api/notes")

    assert response.status_code == 200
    keys = [note["key"] for note in response.json()["notes"]]
    assert keys == [
        "notes/new.md",
        "notes/mid.md",
        "notes/old.md",
    ]


def test_notes_create_read_save_and_delete_in_configured_prefix(client, fake_bucket):
    created = client.post("/api/notes", json={"name": "work", "content": "first"})

    assert created.status_code == 201
    assert created.json()["key"] == "notes/work.md"
    assert fake_bucket.objects["notes/work.md"] == b"first"

    read = client.get("/api/notes/content", params={"key": "notes/work.md"})
    assert read.status_code == 200
    assert read.json()["content"] == "first"

    saved = client.put(
        "/api/notes",
        json={
            "key": "notes/work.md",
            "content": "updated",
            "expected_etag": created.json()["etag"],
        },
    )
    assert saved.status_code == 200
    assert fake_bucket.objects["notes/work.md"] == b"updated"

    deleted = client.delete("/api/notes", params={"key": "notes/work.md"})
    assert deleted.status_code == 200
    assert "notes/work.md" not in fake_bucket.objects


def test_note_operations_reject_file_prefix_and_nested_keys(client, fake_bucket):
    fake_bucket.objects["drive/file.md"] = b"file"
    fake_bucket.objects["notes/nested/note.md"] = b"nested"

    outside = client.get("/api/notes/content", params={"key": "drive/file.md"})
    nested = client.delete("/api/notes", params={"key": "notes/nested/note.md"})

    assert outside.status_code == 400
    assert nested.status_code == 400
    assert "notes/nested/note.md" in fake_bucket.objects


def test_notes_derive_prefix_when_note_prefix_is_empty(fake_bucket):
    fallback_settings = Settings(
        _env_file=None,
        oss_endpoint="https://oss-cn-hangzhou.aliyuncs.com",
        oss_bucket="test-bucket",
        oss_access_key_id="test-id",
        oss_access_key_secret="test-secret",
        oss_prefix="drive/",
        note_oss_prefix="",
        port=9876,
    )

    with TestClient(create_app(fallback_settings)) as fallback_client:
        response = fallback_client.get("/api/notes")
        created = fallback_client.post("/api/notes", json={"name": "fallback"})

    assert response.json() == {"prefix": "drive-note/", "notes": []}
    assert created.status_code == 201
    assert created.json()["key"] == "drive-note/fallback.md"


def test_notes_use_legacy_fallback_when_oss_prefix_is_empty(fake_bucket):
    no_prefix = Settings(
        _env_file=None,
        oss_endpoint="https://oss-cn-hangzhou.aliyuncs.com",
        oss_bucket="test-bucket",
        oss_access_key_id="test-id",
        oss_access_key_secret="test-secret",
        oss_prefix="",
        port=9876,
    )

    with TestClient(create_app(no_prefix)) as no_prefix_client:
        response = no_prefix_client.get("/api/notes")
        created = no_prefix_client.post("/api/notes", json={"name": "fallback"})

    assert response.json() == {"prefix": "my-note/", "notes": []}
    assert created.status_code == 201
    assert created.json()["key"] == "my-note/fallback.md"
