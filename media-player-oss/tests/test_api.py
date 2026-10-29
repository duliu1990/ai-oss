import json
import runpy
import sys
from types import SimpleNamespace
from unittest.mock import Mock, call
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

import app as app_module
import oss_store
from config import DEV_ORIGIN, ROOT, Settings
from tests.conftest import FakeBucket

WEB = {"X-Player-Client": "web"}
NATIVE_ORIGINS = ["capacitor://localhost", "https://localhost"]
ASSET = "/assets/index-Ab12_cd3.js"


@pytest.fixture
def bucket(monkeypatch):
    fake = FakeBucket({"media/a.mp3": bytes(range(256)) * 40, "media/b.flac": b"flac", "media/c.mp4": b"v"})
    monkeypatch.setattr(oss_store, "get_bucket", lambda _settings: fake)
    return fake


@pytest.fixture
def frontend_build(tmp_path):
    build = tmp_path / "frontend-dist"
    (build / "assets").mkdir(parents=True)
    (build / ASSET.lstrip("/")).write_text("console.log('built player');", encoding="utf-8")
    (build / "index.html").write_text(
        f'<!doctype html><html><body>Built Player<script type="module" src="{ASSET}"></script></body></html>',
        encoding="utf-8",
    )
    return build


@pytest.fixture
def app_settings(settings, tmp_path, frontend_build):
    return Settings(
        _env_file=None,
        **(
            settings.model_dump()
            | {
                "library_file": str(tmp_path / "library.json"),
                "frontend_dist": str(frontend_build),
                "allowed_hosts": ["localhost", "127.0.0.1"],
                "allowed_origins": [],
                "enable_dev_origin": False,
            }
        ),
    )


@pytest.fixture
def application(bucket, app_settings):
    return app_module.create_app(app_settings)


@pytest.fixture
def client(application):
    with TestClient(application, base_url="http://127.0.0.1:8767") as test_client:
        yield test_client


@pytest.fixture
def native_client(bucket, app_settings):
    app_settings.allowed_origins = NATIVE_ORIGINS.copy()
    with TestClient(app_module.create_app(app_settings), base_url="http://127.0.0.1:8767") as test_client:
        yield test_client


def test_index_and_security_headers(client, frontend_build):
    response = client.get("/")
    assert response.status_code == 200
    assert response.text == (frontend_build / "index.html").read_text(encoding="utf-8")
    assert response.headers["content-type"].startswith("text/html")
    assert "media-src 'self'" in response.headers["content-security-policy"]
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["cache-control"] == "no-store"
    assert client.head("/").content == b""
    asset = client.get(ASSET)
    assert asset.status_code == 200
    assert asset.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert "javascript" in asset.headers["content-type"]
    cached = client.get(ASSET, headers={"If-None-Match": asset.headers["etag"]})
    assert cached.status_code == 304
    assert cached.headers["cache-control"] == asset.headers["cache-control"]
    assert client.head(ASSET).content == b""


def test_tracks_use_catalog_names_with_local_override(client, bucket):
    bucket.objects["media/catalog.json"] = json.dumps(
        {"files": {"media/a.mp3": {"title": "晴天", "artist": "周杰伦"}, "media/b.flac": {"title": "夜曲"}}}
    ).encode()
    client.put("/api/tracks/meta", json={"key": "media/b.flac", "title": "夜曲（自定义）"}, headers=WEB)
    data = client.get("/api/tracks").json()
    tracks = {t["key"]: t for t in data["tracks"]}
    assert data["catalog_error"] is None
    assert tracks["media/a.mp3"]["info"] == {"title": "晴天", "artist": "周杰伦"}
    assert tracks["media/a.mp3"]["title"] == ""
    assert tracks["media/b.flac"]["title"] == "夜曲（自定义）"
    assert tracks["media/b.flac"]["info"]["title"] == "夜曲"


def test_config(client):
    data = client.get("/api/config").json()
    assert data == {"oss_ready": True, "oss_missing": [], "bucket": "bucket", "prefix": "media/"}


def test_tracks_merge_library(client):
    client.put(
        "/api/tracks/meta", json={"key": "media/a.mp3", "title": "晴天", "favorite": True}, headers=WEB
    )
    data = client.get("/api/tracks").json()
    tracks = {t["key"]: t for t in data["tracks"]}
    assert set(tracks) == {"media/a.mp3", "media/b.flac"}
    assert tracks["media/a.mp3"]["title"] == "晴天"
    assert tracks["media/a.mp3"]["favorite"] is True
    assert tracks["media/b.flac"]["title"] == ""
    assert client.get("/api/tracks").headers["cache-control"] == "no-store"


def test_stream_full_and_range(client, bucket):
    data = bucket.objects["media/a.mp3"]
    full = client.get("/api/stream", params={"key": "media/a.mp3"})
    assert full.status_code == 200
    assert full.content == data
    assert full.headers["accept-ranges"] == "bytes"
    assert full.headers["content-type"] == "audio/mpeg"

    part = client.get("/api/stream", params={"key": "media/a.mp3"}, headers={"Range": "bytes=10-19"})
    assert part.status_code == 206
    assert part.content == data[10:20]
    assert part.headers["content-range"] == f"bytes 10-19/{len(data)}"
    assert part.headers["content-length"] == "10"


def test_stream_out_of_range(client):
    response = client.get("/api/stream", params={"key": "media/b.flac"}, headers={"Range": "bytes=100-"})
    assert response.status_code == 416
    assert response.headers["content-range"] == "bytes */4"


@pytest.mark.parametrize("key", ["media/c.mp4", "other/x.mp3", "media/../x.mp3"])
def test_stream_rejects_keys(client, key):
    response = client.get("/api/stream", params={"key": key})
    assert response.status_code == 400
    assert response.json()["detail"]


def test_stream_missing_object(client):
    response = client.get("/api/stream", params={"key": "media/gone.mp3"})
    assert response.status_code == 400
    assert "找不到" in response.json()["detail"]


def test_cross_site_requests_are_blocked(client):
    response = client.get(
        "/api/stream", params={"key": "media/a.mp3"}, headers={"Sec-Fetch-Site": "cross-site"}
    )
    assert response.status_code == 403
    response = client.get("/api/tracks", headers={"Origin": "https://evil.example"})
    assert response.status_code == 403


def test_untrusted_host_is_rejected(application):
    with TestClient(application, base_url="http://evil.example") as other:
        assert other.get("/api/config").status_code == 400


def test_meta_requires_client_header(client):
    response = client.put("/api/tracks/meta", json={"key": "media/a.mp3", "title": "x"})
    assert response.status_code == 403


def test_meta_update_and_validation(client):
    response = client.put(
        "/api/tracks/meta", json={"key": "media/a.mp3", "title": "七里香", "artist": "周杰伦"}, headers=WEB
    )
    assert response.status_code == 200
    assert response.json() == {"key": "media/a.mp3", "title": "七里香", "artist": "周杰伦", "favorite": False}

    assert (
        client.put("/api/tracks/meta", json={"key": "other/a.mp3", "title": "x"}, headers=WEB).status_code
        == 400
    )
    too_long = client.put("/api/tracks/meta", json={"key": "media/a.mp3", "title": "x" * 201}, headers=WEB)
    assert too_long.status_code == 400


def test_tracks_response_contract(client):
    data = client.get("/api/tracks").json()
    assert set(data) == {"tracks", "prefix", "truncated", "catalog_error"}
    assert data["prefix"] == "media/"
    assert data["truncated"] is False
    assert data["catalog_error"] is None
    for track in data["tracks"]:
        assert set(track) == {"key", "name", "size", "last_modified", "info", "title", "artist", "favorite"}
        assert all(
            isinstance(track[field], str) for field in ["key", "name", "last_modified", "title", "artist"]
        )
        assert type(track["size"]) is int
        assert type(track["favorite"]) is bool
        assert track["info"] == {}


def test_meta_null_omitted_and_empty_overrides(client, bucket):
    bucket.objects["media/catalog.json"] = json.dumps(
        {"files": {"media/a.mp3": {"title": "Catalog title", "artist": "Catalog artist", "duration": 9.5}}}
    ).encode()
    original = {"key": "media/a.mp3", "title": "My title", "artist": "My artist", "favorite": True}
    assert client.put("/api/tracks/meta", json=original, headers=WEB).json() == original
    for change in (
        {"key": original["key"]},
        {"key": original["key"], "title": None, "artist": None, "favorite": None},
    ):
        assert client.put("/api/tracks/meta", json=change, headers=WEB).json() == original
    cleared = {"key": original["key"], "title": "", "artist": "", "favorite": False}
    assert client.put("/api/tracks/meta", json=cleared, headers=WEB).json() == cleared
    track = next(t for t in client.get("/api/tracks").json()["tracks"] if t["key"] == original["key"])
    assert track["title"] == track["artist"] == ""
    assert track["favorite"] is False
    assert track["info"] == {"title": "Catalog title", "artist": "Catalog artist", "duration": 9.5}


@pytest.mark.parametrize("payload", [{}, {"key": None}, {"key": 123}, {"key": "media/a.mp3", "title": 1}])
def test_meta_invalid_request_contract(client, payload):
    response = client.put("/api/tracks/meta", json=payload, headers=WEB)
    assert response.status_code == 422
    assert set(response.json()) == {"detail"}


def test_stream_encoded_object_key(client, bucket):
    key = "media/夜曲 + &?#100%.mp3"
    bucket.objects[key] = b"encoded audio"
    response = client.get(f"/api/stream?key={quote(key, safe='')}")
    assert response.status_code == 200
    assert response.content == bucket.objects[key]
    assert bucket.requests[-1][0] == key


@pytest.mark.parametrize("header", ["bytes=1-2,4-5", "bytes=bad", "bytes=5-1"])
def test_malformed_range_still_returns_full_audio(client, bucket, header):
    response = client.get("/api/stream", params={"key": "media/a.mp3"}, headers={"Range": header})
    assert response.status_code == 200
    assert response.content == bucket.objects["media/a.mp3"]


@pytest.mark.parametrize("origin", NATIVE_ORIGINS)
@pytest.mark.parametrize(("byte_range", "status"), [(None, 200), ("bytes=0-1", 206), ("bytes=100-", 416)])
def test_native_origin_range_and_exposed_headers(native_client, origin, byte_range, status):
    headers = {"Origin": origin, "Sec-Fetch-Site": "cross-site"}
    if byte_range:
        headers["Range"] = byte_range
    response = native_client.get("/api/stream", params={"key": "media/b.flac"}, headers=headers)
    assert response.status_code == status
    assert response.headers["access-control-allow-origin"] == origin
    assert "access-control-allow-credentials" not in response.headers
    exposed = {part.strip().lower() for part in response.headers["access-control-expose-headers"].split(",")}
    assert {"accept-ranges", "content-range", "content-length"} <= exposed
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["cache-control"] == "no-store"
    assert "origin" in response.headers["vary"].lower()
    if status == 206:
        assert response.content == b"fl"
        assert response.headers["content-range"] == "bytes 0-1/4"
    elif status == 416:
        assert response.headers["content-range"] == "bytes */4"


@pytest.mark.parametrize("origin", NATIVE_ORIGINS)
@pytest.mark.parametrize(
    ("method", "requested_headers"), [("GET", "Range"), ("PUT", "Content-Type,X-Player-Client")]
)
def test_native_preflight_without_write_marker(
    native_client, app_settings, origin, method, requested_headers
):
    response = native_client.options(
        "/api/tracks/meta" if method == "PUT" else "/api/stream",
        headers={
            "Origin": origin,
            "Sec-Fetch-Site": "cross-site",
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": requested_headers,
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert method in response.headers["access-control-allow-methods"]
    assert "x-player-client" in response.headers["access-control-allow-headers"].lower()
    assert "range" in response.headers["access-control-allow-headers"].lower()
    assert "access-control-allow-credentials" not in response.headers
    assert response.headers["cache-control"] == "no-store"
    assert not app_settings.library_path.exists()


@pytest.mark.parametrize("origin", NATIVE_ORIGINS)
def test_native_write_marker_and_error_cors(native_client, origin):
    headers = {"Origin": origin, "Sec-Fetch-Site": "cross-site"}
    body = {"key": "media/a.mp3", "favorite": True}
    for marker in (None, "native", "invalid"):
        request_headers = headers | ({"X-Player-Client": marker} if marker else {})
        denied = native_client.put("/api/tracks/meta", json=body, headers=request_headers)
        assert denied.status_code == 403
        assert denied.headers["access-control-allow-origin"] == origin
    assert native_client.put("/api/tracks/meta", json=body, headers=headers | WEB).status_code == 200
    invalid = native_client.put("/api/tracks/meta", json={}, headers=headers | WEB)
    assert invalid.status_code == 422
    assert invalid.headers["access-control-allow-origin"] == origin
    missing = native_client.get("/api/stream", params={"key": "media/missing.mp3"}, headers=headers)
    assert missing.status_code == 400
    assert missing.headers["access-control-allow-origin"] == origin


@pytest.mark.parametrize(
    "origin", ["null", "https://localhost.evil.example", "http://localhost", "https://localhost/"]
)
def test_origin_allowlist_is_exact(native_client, origin):
    response = native_client.get("/api/tracks", headers={"Origin": origin})
    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers


@pytest.mark.parametrize("origin", NATIVE_ORIGINS)
def test_native_origins_are_not_enabled_by_default(client, origin):
    assert client.get("/api/tracks", headers={"Origin": origin}).status_code == 403


@pytest.mark.parametrize(
    ("origin", "method", "header"),
    [
        ("https://evil.example", "GET", "Range"),
        ("https://localhost", "DELETE", "Content-Type"),
        ("https://localhost", "PUT", "Authorization"),
    ],
)
def test_disallowed_preflights(native_client, origin, method, header):
    response = native_client.options(
        "/api/tracks/meta",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": header,
        },
    )
    assert response.status_code == 400
    if origin == "https://evil.example":
        assert "access-control-allow-origin" not in response.headers


@pytest.mark.parametrize(
    "host",
    ["evil.example", "127.0.0.1:99999", "127.0.0.1:65536", "127.0.0.1:invalid", "127.0.0.1:-1"],
)
@pytest.mark.parametrize("method", ["OPTIONS", "GET"])
def test_host_guard_runs_before_cors_preflight(native_client, host, method):
    response = native_client.request(
        method,
        "/api/tracks/meta" if method == "OPTIONS" else "/api/config",
        headers={"Host": host, "Origin": "https://localhost", "Access-Control-Request-Method": "PUT"},
    )
    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.1:8767", "127.0.0.1:65535"])
@pytest.mark.parametrize("method", ["OPTIONS", "GET"])
def test_host_guard_accepts_valid_ports(native_client, host, method):
    response = native_client.request(
        method,
        "/api/tracks/meta" if method == "OPTIONS" else "/api/config",
        headers={"Host": host, "Origin": "https://localhost", "Access-Control-Request-Method": "PUT"},
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://localhost"


def test_public_host_same_origin_and_forwarded_origin_spoof(bucket, app_settings):
    app_settings.allowed_hosts = ["music.example"]
    with TestClient(app_module.create_app(app_settings), base_url="https://music.example") as public:
        headers = {"Origin": "https://music.example", "Sec-Fetch-Site": "same-origin"}
        assert public.get("/api/tracks", headers=headers).status_code == 200
        saved = public.put("/api/tracks/meta", json={"key": "media/a.mp3"}, headers=headers | WEB)
        assert saved.status_code == 200
        assert public.get("/healthz").json() == {"status": "ok"}
        assert public.get("/api/config", headers={"Host": "music.example.evil"}).status_code == 400
        spoofed = {
            "Origin": "https://evil.example",
            "X-Forwarded-Host": "evil.example",
            "X-Forwarded-Proto": "https",
        }
        assert public.get("/api/tracks", headers=spoofed).status_code == 403


@pytest.mark.parametrize("enabled", [False, True])
def test_development_origin_requires_explicit_enablement(bucket, app_settings, enabled):
    app_settings.enable_dev_origin = enabled
    with TestClient(app_module.create_app(app_settings), base_url="http://127.0.0.1:8767") as dev:
        headers = {"Origin": DEV_ORIGIN}
        assert dev.get("/api/tracks", headers=headers).status_code == (200 if enabled else 403)
        response = dev.put("/api/tracks/meta", json={"key": "media/a.mp3"}, headers=headers | WEB)
        assert response.status_code == (200 if enabled else 403)
        preflight = dev.options(
            "/api/tracks/meta", headers=headers | {"Access-Control-Request-Method": "PUT"}
        )
        assert preflight.status_code == (200 if enabled else 400)
        for origin in ("http://localhost:5173", "http://127.0.0.1:5174"):
            assert dev.get("/api/tracks", headers={"Origin": origin}).status_code == 403


def test_anonymous_native_read_needs_no_origin_or_ticket(client):
    response = client.get(
        "/api/stream", params={"key": "media/b.flac"}, headers={"User-Agent": "NativeMedia"}
    )
    assert response.status_code == 200
    assert response.content == b"flac"
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize("length", ["4097", "-1", "invalid", "9" * 50])
def test_write_size_guard(native_client, length):
    headers = WEB | {"Origin": "https://localhost", "Content-Length": length}
    response = native_client.put("/api/tracks/meta", json={"key": "media/a.mp3"}, headers=headers)
    assert response.status_code == 413
    assert response.headers["access-control-allow-origin"] == "https://localhost"


def test_unexpected_error_keeps_cors_and_safe_body(native_client, monkeypatch):
    def fail(_settings):
        raise RuntimeError("internal-only failure")

    monkeypatch.setattr(oss_store, "list_audio", fail)
    response = native_client.get("/api/tracks", headers={"Origin": "https://localhost"})
    assert response.status_code == 500
    assert response.headers["access-control-allow-origin"] == "https://localhost"
    assert response.headers["cache-control"] == "no-store"
    assert "internal-only" not in response.text


def test_health_without_oss_configuration_or_frontend(app_settings, tmp_path, monkeypatch):
    app_settings.oss_access_key_id = SecretStr("")
    app_settings.frontend_dist = str(tmp_path / "missing-build")

    def unexpected_oss_call(*args, **kwargs):
        raise AssertionError("Health checks must not access OSS")

    monkeypatch.setattr(oss_store, "get_bucket", unexpected_oss_call)
    monkeypatch.setattr(oss_store, "list_audio", unexpected_oss_call)
    with TestClient(app_module.create_app(app_settings), base_url="http://127.0.0.1:8767") as offline:
        response = offline.get("/healthz")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
        assert response.headers["cache-control"] == "no-store"
        assert offline.get("/api/config").json()["oss_ready"] is False
        assert not app_settings.library_path.exists()


@pytest.mark.parametrize(
    "path", ["/api/missing", "/api/tracks/", "/assets/missing.js", "/assets", "/library", "/static/app.js"]
)
def test_missing_routes_and_assets_never_fall_back_to_spa(client, path):
    response = client.get(path)
    assert response.status_code == 404
    assert response.headers["cache-control"] == "no-store"
    assert "Built Player" not in response.text


def test_missing_frontend_is_diagnostic_not_legacy(bucket, app_settings, tmp_path):
    app_settings.frontend_dist = str(tmp_path / "missing-build")
    with TestClient(app_module.create_app(app_settings), base_url="http://127.0.0.1:8767") as missing:
        response = missing.get("/")
        assert response.status_code == 503
        assert "FRONTEND_DIST" in response.json()["detail"]
        assert response.headers["cache-control"] == "no-store"
        assert missing.get(ASSET).status_code == 404
        assert missing.get("/api/config").status_code == 200


def test_assets_cannot_escape_build(client, frontend_build, tmp_path):
    outside = tmp_path / "outside.js"
    outside.write_text("not a frontend asset", encoding="utf-8")
    (frontend_build / "assets" / "linked.js").symlink_to(outside)
    for path in ("/assets/%2e%2e/index.html", "/assets/linked.js"):
        response = client.get(path)
        assert response.status_code == 404
        assert "not a frontend asset" not in response.text


@pytest.mark.parametrize(
    ("field", "values"),
    [
        ("allowed_hosts", []),
        ("allowed_hosts", ["*"]),
        ("allowed_hosts", ["*.example.com"]),
        ("allowed_hosts", ["https://example.com"]),
        ("allowed_hosts", ["example.com:8767"]),
        ("allowed_hosts", ["example.com/path"]),
        ("allowed_hosts", ["bad host"]),
        ("allowed_origins", ["*"]),
        ("allowed_origins", ["https://*.example.com"]),
        ("allowed_origins", ["null"]),
        ("allowed_origins", ["https://example.com/"]),
        ("allowed_origins", ["https://example.com/path"]),
        ("allowed_origins", ["https://example.com?x=1"]),
        ("allowed_origins", ["https://example.com#fragment"]),
        ("allowed_origins", ["https://user:private@example.com"]),
        ("allowed_origins", ["capacitor://elsewhere"]),
        ("allowed_origins", ["file://localhost"]),
        ("allowed_origins", ["https://localhost:0"]),
        ("allowed_origins", ["https://localhost:65536"]),
        ("allowed_origins", ["https://localhost:443"]),
    ],
)
def test_access_configuration_rejects_unsafe_values(field, values):
    with pytest.raises(ValidationError) as error:
        Settings(_env_file=None, **{field: values})
    assert "user:private" not in str(error.value)


def test_configuration_environment_arrays_and_root_relative_paths(monkeypatch, tmp_path):
    monkeypatch.setenv("ALLOWED_HOSTS", '["music.example", "127.0.0.1"]')
    monkeypatch.setenv("ALLOWED_ORIGINS", json.dumps(NATIVE_ORIGINS))
    monkeypatch.setenv("ENABLE_DEV_ORIGIN", "true")
    monkeypatch.setenv("FRONTEND_DIST", "frontend/dist")
    monkeypatch.setenv("LIBRARY_FILE", "data/library.json")
    monkeypatch.chdir(tmp_path)
    configured = Settings(_env_file=None)
    assert configured.allowed_hosts == ["music.example", "127.0.0.1"]
    assert configured.allowed_origins == NATIVE_ORIGINS
    assert configured.cors_origins == [*NATIVE_ORIGINS, DEV_ORIGIN]
    assert configured.frontend_path == ROOT / "frontend/dist"
    assert configured.library_path == ROOT / "data/library.json"


@pytest.fixture
def startup_stubs(monkeypatch, tmp_path):
    # Re-execute the real entry point without reading .env, changing SSL, or listening.
    configured = SimpleNamespace(
        library_path=tmp_path / "library.json",
        frontend_path=tmp_path / "missing-dist",
        cors_origins=[],
        allowed_hosts=["127.0.0.1"],
    )
    startup = Mock()
    monkeypatch.setitem(sys.modules, "config", SimpleNamespace(Settings=Settings, settings=configured))
    monkeypatch.setitem(
        sys.modules,
        "logs",
        SimpleNamespace(setup_logging=Mock(), describe_error=app_module.describe_error),
    )
    monkeypatch.setitem(sys.modules, "truststore", SimpleNamespace(inject_into_ssl=startup.inject))
    monkeypatch.setitem(sys.modules, "uvicorn", SimpleNamespace(run=startup.run))
    return startup, configured


@pytest.mark.parametrize("environment_override", [False, True])
def test_startup_pins_single_worker_and_loopback_proxy_trust(
    monkeypatch, startup_stubs, environment_override
):
    startup, configured = startup_stubs
    for name, value in {"WEB_CONCURRENCY": "8", "FORWARDED_ALLOW_IPS": "*"}.items():
        if environment_override:
            monkeypatch.setenv(name, value)
        else:
            monkeypatch.delenv(name, raising=False)

    namespace = runpy.run_path(str(ROOT / "app.py"), run_name="__main__")

    assert namespace["app"].state.settings is configured
    assert not configured.library_path.exists()
    assert startup.mock_calls == [
        call.inject(),
        call.run(
            namespace["app"],
            host="127.0.0.1",
            port=8767,
            workers=1,
            proxy_headers=True,
            forwarded_allow_ips="127.0.0.1",
            access_log=False,
            log_config=None,
        ),
    ]


def test_startup_does_not_listen_if_system_trust_initialization_fails(startup_stubs):
    startup, _ = startup_stubs
    startup.inject.side_effect = RuntimeError("system trust initialization failed")
    with pytest.raises(RuntimeError, match="system trust initialization failed"):
        runpy.run_path(str(ROOT / "app.py"), run_name="__main__")
    startup.run.assert_not_called()


def test_import_does_not_initialize_system_trust_or_start_server(startup_stubs):
    startup, _ = startup_stubs
    namespace = runpy.run_path(str(ROOT / "app.py"), run_name="startup_import_regression")
    assert "app" in namespace
    assert startup.mock_calls == []
