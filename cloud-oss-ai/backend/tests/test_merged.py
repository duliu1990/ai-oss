"""Behavior that only exists because drive, notes and music now share one backend."""

import pytest
from fastapi.testclient import TestClient

from app import create_app
from tests.conftest import AUTH_PASSWORD, AUTH_USERNAME, WEB_CLIENT, bearer

WRITES = [
    ("POST", "/api/files/create", {"json": {"prefix": "drive/", "name": "a", "content": "x"}}),
    ("PUT", "/api/files/edit", {"json": {"key": "drive/a.txt", "content": "x", "force": True}}),
    ("POST", "/api/files/folder", {"json": {"prefix": "drive/new/"}}),
    ("DELETE", "/api/files?key=drive/a.txt", {}),
    ("POST", "/api/files/upload/init", {"json": {"prefix": "drive/", "name": "a.bin", "size": 1}}),
    ("POST", "/api/notes", {"json": {"name": "n"}}),
    ("PUT", "/api/notes", {"json": {"key": "notes/n.md", "content": "x", "force": True}}),
    ("DELETE", "/api/notes?key=notes/n.md", {}),
    ("PUT", "/api/tracks/meta", {"json": {"key": "media/a.mp3", "favorite": True}}),
    ("POST", "/api/auth/login", {"json": {"username": AUTH_USERNAME, "password": AUTH_PASSWORD}}),
]


@pytest.fixture
def seeded(fake_bucket):
    fake_bucket.objects.update(
        {
            "drive/a.txt": b"drive text",
            "drive/song.mp3": b"not music",
            "notes/n.md": b"# note",
            "media/a.mp3": b"0123456789",
            "media/secret.txt": b"media text",
        }
    )
    return fake_bucket


@pytest.fixture
def anonymous(settings, seeded):
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_config_describes_every_module_without_secrets(client):
    response = client.get("/api/config")

    assert response.status_code == 200
    assert response.json() == {
        "bucket": "test-bucket",
        "oss_ready": True,
        "oss_missing": [],
        "drive_prefix": "drive/",
        "note_prefix": "notes/",
        "media_prefix": "media/",
    }
    assert "test-secret" not in response.text


@pytest.mark.parametrize("path", ["/api/config", "/api/files", "/api/notes", "/api/tracks"])
def test_every_module_requires_login(anonymous, path):
    assert anonymous.get(path).status_code == 401


def test_one_login_token_opens_every_module(anonymous):
    login = anonymous.post(
        "/api/auth/login",
        json={"username": AUTH_USERNAME, "password": AUTH_PASSWORD},
        headers=WEB_CLIENT,
    )
    assert login.status_code == 200
    token = login.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    for path in ("/api/config", "/api/files", "/api/notes", "/api/tracks"):
        assert anonymous.get(path, headers=headers).status_code == 200, path
    assert (
        anonymous.get("/api/notes/content", params={"key": "notes/n.md"}, headers=headers).status_code == 200
    )

    # Media elements and download links cannot set headers, so both accept the same token as ?token=.
    download = anonymous.get("/api/files/download", params={"key": "drive/a.txt", "token": token})
    assert download.status_code == 200
    assert download.content == b"drive text"
    stream = anonymous.get(
        "/api/stream", params={"key": "media/a.mp3", "token": token}, headers={"Range": "bytes=2-5"}
    )
    assert stream.status_code == 206
    assert stream.content == b"2345"


@pytest.mark.parametrize(("method", "path", "body"), WRITES)
def test_writes_without_client_marker_are_forbidden(settings, seeded, method, path, body):
    with TestClient(create_app(settings), headers=bearer(settings)) as unmarked:
        response = unmarked.request(method, path, **body)

    assert response.status_code == 403
    assert seeded.objects["drive/a.txt"] == b"drive text"
    assert seeded.objects["notes/n.md"] == b"# note"
    assert not settings.library_path.exists()


@pytest.mark.parametrize("marker", ["native", "", "WEB"])
def test_only_the_web_marker_is_accepted(settings, seeded, marker):
    with TestClient(create_app(settings), headers=bearer(settings)) as test_client:
        response = test_client.put(
            "/api/tracks/meta", json={"key": "media/a.mp3"}, headers={"X-App-Client": marker}
        )
    assert response.status_code == 403


def test_reads_do_not_need_the_client_marker(settings, seeded):
    with TestClient(create_app(settings), headers=bearer(settings)) as test_client:
        assert test_client.get("/api/files").status_code == 200
        assert test_client.get("/api/tracks").status_code == 200


def test_drive_cannot_reach_media_or_notes_objects(client, seeded):
    listing = client.get("/api/files").json()
    keys = {item["key"] for item in listing.get("files", [])} | set(listing.get("folders", []))
    assert all(key.startswith("drive/") for key in keys)
    for key in ("media/a.mp3", "media/secret.txt"):
        response = client.get("/api/files/download", params={"key": key})
        assert response.status_code == 400, key
        assert response.content != seeded.objects[key]
    assert client.delete("/api/files", params={"key": "media/a.mp3"}).status_code == 400
    assert "media/a.mp3" in seeded.objects


def test_music_cannot_reach_drive_or_note_objects(client, seeded):
    tracks = client.get("/api/tracks").json()["tracks"]
    assert [track["key"] for track in tracks] == ["media/a.mp3"]
    for key in ("drive/song.mp3", "notes/n.md", "media/secret.txt"):
        response = client.get("/api/stream", params={"key": key})
        assert response.status_code == 400, key
    meta = client.put("/api/tracks/meta", json={"key": "drive/song.mp3", "favorite": True})
    assert meta.status_code == 400


def test_notes_stay_inside_the_note_prefix(client, seeded):
    for key in ("drive/a.txt", "media/a.mp3"):
        assert client.get("/api/notes/content", params={"key": key}).status_code == 400, key
    created = client.post("/api/notes", json={"name": "fresh"})
    assert created.status_code == 201
    assert created.json()["key"] == "notes/fresh.md"


def test_small_bodies_are_capped_for_login_and_meta(client):
    padding = "x" * 5000
    login = client.post("/api/auth/login", json={"username": AUTH_USERNAME, "password": padding})
    assert login.status_code == 413
    meta = client.put("/api/tracks/meta", json={"key": "media/a.mp3", "title": padding})
    assert meta.status_code == 413
