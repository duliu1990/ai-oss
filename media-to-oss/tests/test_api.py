import importlib
import os
import re
import socket
import subprocess
import time
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from pydantic_settings import BaseSettings

from security import UserError

BASE_URL = "http://127.0.0.1"
WEB_HEADERS = {"origin": BASE_URL, "x-media-client": "web"}
ANALYSIS_ID = "a" * 32
TASK_ID = "b" * 32


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    monkeypatch.setattr(os, "environ", {})
    original_init = BaseSettings.__init__

    def init_without_dotenv(self, **kwargs):
        kwargs["_env_file"] = None
        original_init(self, **kwargs)

    monkeypatch.setattr(BaseSettings, "__init__", init_without_dotenv)

    def forbidden(*args, **kwargs):
        raise AssertionError("API unit tests must not start workers or use real network/DNS")

    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    jobs = importlib.import_module("jobs")
    monkeypatch.setattr(jobs, "run_worker", Mock(side_effect=forbidden))
    monkeypatch.setattr(jobs.JobManager, "start", forbidden)


@pytest.fixture
def app_module(monkeypatch):
    config = importlib.import_module("config")
    module = importlib.import_module("app")
    monkeypatch.setattr(module, "settings", config.Settings(_env_file=None))
    monkeypatch.setattr(module.shutil, "which", lambda name: f"/mock/bin/{name}")
    return module


@pytest.fixture
def manager(app_module, monkeypatch):
    fake = Mock(spec=app_module.JobManager)
    monkeypatch.setattr(app_module, "manager", fake)
    yield fake
    fake.start.assert_not_called()
    fake.close.assert_not_called()


@pytest.fixture
def client(app_module, manager):
    # Deliberately do not use a context manager: TestClient.__enter__ runs lifespan.
    result = TestClient(app_module.app, base_url=BASE_URL)
    yield result
    result.close()


@pytest.fixture
def local_manager(client, app_module, monkeypatch):
    # Exercise manager validation only; neither start() nor the worker is invoked.
    actual = app_module.JobManager(app_module.settings)
    monkeypatch.setattr(app_module, "manager", actual)
    actual.analyses[ANALYSIS_ID] = (
        time.monotonic(),
        {
            "title": "A track",
            "source": "网页媒体识别",
            "ai_used": False,
            "warning": None,
            "candidates": [
                {
                    "id": "1",
                    "title": "A track",
                    "kind": "audio",
                    "url": "https://media.example/track.mp3?token=dummy-private-token",
                }
            ],
        },
    )
    yield actual
    assert actual.thread is None
    assert actual.instance_lock is None


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "localhost:8765", "127.0.0.1:8765"])
def test_allowed_hosts(client, host):
    response = client.get("/api/config", headers={"host": host})
    assert response.status_code == 200


@pytest.mark.parametrize(
    "host", ["evil.example", "localhost.evil.example", "127.0.0.1.evil.example", "[::1]"]
)
def test_untrusted_host_is_rejected(client, manager, host):
    response = client.get("/api/tasks", headers={"host": host})
    assert response.status_code == 400
    manager.list.assert_not_called()


@pytest.mark.parametrize(
    "origin", ["https://evil.example", "http://localhost", "http://127.0.0.1:9999", "null"]
)
def test_cross_origin_requests_are_rejected(client, manager, origin):
    response = client.post(
        "/api/analyze",
        headers={"origin": origin, "x-media-client": "web"},
        json={"url": "https://media.example/"},
    )
    assert response.status_code == 403
    manager.analyze.assert_not_called()


@pytest.mark.parametrize("headers", [{"origin": "https://evil.example"}, {"sec-fetch-site": "cross-site"}])
def test_cross_site_gets_are_also_rejected(client, manager, headers):
    response = client.get("/api/tasks", headers=headers)
    assert response.status_code == 403
    manager.list.assert_not_called()


def test_cross_site_fetch_metadata_overrides_matching_origin(client, manager):
    response = client.post(
        "/api/analyze",
        headers={**WEB_HEADERS, "sec-fetch-site": "cross-site"},
        json={"url": "https://media.example/"},
    )
    assert response.status_code == 403
    manager.analyze.assert_not_called()


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
@pytest.mark.parametrize("marker", [None, "wrong"])
def test_mutations_require_csrf_client_header(client, manager, method, marker):
    headers = {"origin": BASE_URL}
    if marker is not None:
        headers["x-media-client"] = marker
    response = client.request(method, "/api/analyze", headers=headers, json={"url": "https://media.example/"})
    assert response.status_code == 403
    manager.analyze.assert_not_called()


@pytest.mark.parametrize("length", ["16385", "-1", "not-a-number"])
def test_oversized_or_invalid_content_length_is_rejected(client, manager, length):
    response = client.post(
        "/api/analyze",
        headers={**WEB_HEADERS, "content-length": length},
        json={"url": "https://media.example/"},
    )
    assert response.status_code == 413
    manager.analyze.assert_not_called()


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost:8765"])
def test_same_origin_analyze_dispatches_to_manager(client, manager, host):
    result = {
        "analysis_id": ANALYSIS_ID,
        "title": "Example",
        "source": "网页媒体识别",
        "candidates": [{"id": "1", "title": "Track", "kind": "audio"}],
        "ai_used": False,
        "warning": None,
    }
    manager.analyze.return_value = result
    response = client.post(
        "/api/analyze",
        headers={
            "host": host,
            "origin": f"http://{host}",
            "x-media-client": "web",
            "sec-fetch-site": "same-origin",
        },
        json={"url": "https://media.example/page"},
    )
    assert response.status_code == 200
    assert response.json() == result
    manager.analyze.assert_called_once_with("https://media.example/page")


def test_client_marker_allows_request_without_origin(client, manager):
    manager.analyze.return_value = {"analysis_id": ANALYSIS_ID, "candidates": []}
    response = client.post(
        "/api/analyze", headers={"x-media-client": "web"}, json={"url": "https://media.example/"}
    )
    assert response.status_code == 200
    manager.analyze.assert_called_once()


def test_config_returns_only_readiness_and_limits(client, app_module, monkeypatch):
    config = importlib.import_module("config")
    configured = config.Settings(
        _env_file=None,
        oss_endpoint="https://oss.example",
        oss_bucket="dummy-private-bucket",
        oss_access_key_id="dummy-access-id",
        oss_access_key_secret="dummy-access-secret",
        oss_security_token="dummy-security-token",
        ai_base_url="https://ai.example/v1",
        ai_api_key="dummy-ai-secret",
        ai_model="dummy-model",
    )
    monkeypatch.setattr(app_module, "settings", configured)
    monkeypatch.setattr(app_module.shutil, "which", lambda name: None if name == "node" else f"/mock/{name}")
    response = client.get("/api/config")
    assert response.status_code == 200
    assert response.json() == {
        "oss_ready": True,
        "oss_missing": [],
        "ai_enabled": True,
        "dependencies": {"ffmpeg": True, "ffprobe": True, "node": False},
        "limits": {
            "max_file_mb": configured.max_file_mb,
            "retention_hours": configured.retention_hours,
            "max_queue": configured.max_queue,
        },
    }
    for private in ("dummy-", "https://oss.example", "https://ai.example"):
        assert private not in response.text


def test_unconfigured_status_and_security_headers(client):
    response = client.get("/api/config")
    data = response.json()
    assert data["oss_ready"] is False and data["ai_enabled"] is False
    assert set(data["oss_missing"]) == {
        "OSS_ENDPOINT",
        "OSS_BUCKET",
        "OSS_ACCESS_KEY_ID",
        "OSS_ACCESS_KEY_SECRET",
    }
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert "connect-src 'self'" in response.headers["content-security-policy"]


@pytest.mark.parametrize("path", ["/static/app.js", "/static/style.css"])
def test_page_and_assets_are_revalidated(client, path):
    response = client.get(path)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers.get("etag") or response.headers.get("last-modified")


def test_index_versions_assets_by_content(client):
    response = client.get("/")
    assert response.status_code == 200 and response.headers["cache-control"] == "no-cache"
    versions = re.findall(r'"/static/(?:app\.js|style\.css)\?v=([0-9a-f]{12})"', response.text)
    assert len(versions) == 2 and len(set(versions)) == 1
    assert client.get(f"/static/app.js?v={versions[0]}").status_code == 200


@pytest.mark.parametrize(
    "payload", [{}, {"url": ""}, {"url": None}, {"url": 123}, {"url": []}, {"url": "dummy-secret" * 800}]
)
def test_invalid_analyze_input_returns_sanitized_422(client, manager, payload):
    response = client.post("/api/analyze", headers=WEB_HEADERS, json=payload)
    assert response.status_code == 422
    assert set(response.json()) == {"detail"}
    assert "dummy-secret" not in response.text
    manager.analyze.assert_not_called()


def test_malformed_json_is_422_without_echoing_input(client, manager):
    response = client.post(
        "/api/analyze",
        headers={**WEB_HEADERS, "content-type": "application/json"},
        content=b'{"url":"dummy-secret",invalid}',
    )
    assert response.status_code == 422
    assert "dummy-secret" not in response.text
    manager.analyze.assert_not_called()


@pytest.mark.parametrize(
    "override",
    [
        {"analysis_id": "not-an-id"},
        {"analysis_id": "../dummy-secret"},
        {"analysis_id": "A" * 32},
        {"candidate_id": ""},
        {"candidate_id": "x" * 41},
        {"candidate_id": None},
        {"mode": "executable"},
        {"upload": "not-a-bool"},
    ],
)
def test_invalid_task_input_returns_422_before_manager(client, manager, override):
    payload = {"analysis_id": ANALYSIS_ID, "candidate_id": "1", **override}
    response = client.post("/api/tasks", headers=WEB_HEADERS, json=payload)
    assert response.status_code == 422
    assert "dummy-secret" not in response.text
    manager.submit.assert_not_called()


@pytest.mark.parametrize(
    "options,expected", [({}, ("audio", True)), ({"mode": "video", "upload": False}, ("video", False))]
)
def test_submit_task_defaults_and_explicit_options(client, manager, options, expected):
    manager.submit.return_value = {"id": TASK_ID, "status": "queued"}
    response = client.post(
        "/api/tasks", headers=WEB_HEADERS, json={"analysis_id": ANALYSIS_ID, "candidate_id": "1", **options}
    )
    assert response.status_code == 202
    assert response.json() == {"id": TASK_ID, "status": "queued"}
    manager.submit.assert_called_once_with(ANALYSIS_ID, "1", *expected)


def test_task_list_and_query_dispatch(client, manager):
    task = {"id": TASK_ID, "status": "completed", "title": "Track"}
    manager.list.return_value = [task]
    manager.get.return_value = task
    response = client.get("/api/tasks")
    assert response.status_code == 200 and response.json() == {"tasks": [task]}
    response = client.get(f"/api/tasks/{TASK_ID}")
    assert response.status_code == 200 and response.json() == task
    manager.list.assert_called_once_with()
    manager.get.assert_called_once_with(TASK_ID)


@pytest.mark.parametrize(
    "suffix,method_name,status,result",
    [
        ("retry-upload", "retry_upload", 202, {"id": TASK_ID, "status": "queued"}),
        (
            "signed-url",
            "signed_url",
            200,
            {"signed_url": "https://oss.example/file?Signature=dummy", "expires_at": "2030-01-01T00:00:00Z"},
        ),
    ],
)
def test_upload_retry_and_signed_url_only_dispatch_to_mock(
    client, manager, suffix, method_name, status, result
):
    method = getattr(manager, method_name)
    method.return_value = result
    response = client.post(f"/api/tasks/{TASK_ID}/{suffix}", headers=WEB_HEADERS)
    assert response.status_code == status and response.json() == result
    method.assert_called_once_with(TASK_ID)


def test_object_listing_and_signing_dispatch(client, manager):
    listing = {"objects": [{"key": "media/a.mp3"}], "prefix": "media/", "truncated": True, "next_token": "t2"}
    manager.list_objects.return_value = listing
    response = client.get("/api/objects")
    assert response.status_code == 200 and response.json() == listing
    manager.list_objects.assert_called_once_with("")
    response = client.get("/api/objects", params={"token": "t2"})
    assert response.status_code == 200
    manager.list_objects.assert_called_with("t2")
    assert client.get("/api/objects", params={"token": "x" * 1025}).status_code == 422

    signed = {"signed_url": "https://oss.example/a.mp3?Signature=dummy", "expires_at": "2030-01-01T00:00:00Z"}
    manager.object_signed_url.return_value = signed
    response = client.post("/api/objects/signed-url", headers=WEB_HEADERS, json={"key": "media/a.mp3"})
    assert response.status_code == 200 and response.json() == signed
    manager.object_signed_url.assert_called_once_with("media/a.mp3")
    assert client.post("/api/objects/signed-url", headers=WEB_HEADERS, json={}).status_code == 422
    assert client.post("/api/objects/signed-url", json={"key": "media/a.mp3"}).status_code == 403


def test_object_delete_dispatch_requires_web_client(client, manager):
    deleted = {"key": "media/a.mp3", "catalog": True, "warning": None}
    manager.delete_object.return_value = deleted
    assert client.post("/api/objects/delete", json={"key": "media/a.mp3"}).status_code == 403
    assert client.post("/api/objects/delete", headers=WEB_HEADERS, json={}).status_code == 422
    manager.delete_object.assert_not_called()
    response = client.post("/api/objects/delete", headers=WEB_HEADERS, json={"key": "media/a.mp3"})
    assert response.status_code == 200 and response.json() == deleted
    assert response.headers["cache-control"] == "no-store"
    manager.delete_object.assert_called_once_with("media/a.mp3")


def test_download_response_uses_manager_file_without_creating_files(client, manager):
    path = Path(__file__).resolve()
    manager.file.return_value = path
    response = client.get(f"/api/tasks/{TASK_ID}/file")
    assert response.status_code == 200
    assert response.content == path.read_bytes()
    assert response.headers["content-type"] == "application/octet-stream"
    assert path.name in response.headers["content-disposition"]
    manager.file.assert_called_once_with(TASK_ID)


@pytest.mark.parametrize(
    "method,path,manager_method,payload",
    [
        ("POST", "/api/analyze", "analyze", {"url": "https://media.example/"}),
        ("POST", "/api/tasks", "submit", {"analysis_id": ANALYSIS_ID, "candidate_id": "1"}),
        ("GET", f"/api/tasks/{TASK_ID}/file", "file", None),
        ("POST", f"/api/tasks/{TASK_ID}/retry-upload", "retry_upload", None),
        ("POST", f"/api/tasks/{TASK_ID}/signed-url", "signed_url", None),
        ("GET", "/api/objects", "list_objects", None),
        ("POST", "/api/objects/signed-url", "object_signed_url", {"key": "media/file.mp3"}),
        ("POST", "/api/objects/delete", "delete_object", {"key": "media/file.mp3"}),
    ],
)
def test_manager_user_errors_are_400(client, manager, method, path, manager_method, payload):
    getattr(manager, manager_method).side_effect = UserError("测试：当前操作不可用。")
    response = client.request(method, path, headers=WEB_HEADERS, json=payload)
    assert response.status_code == 400
    assert response.json() == {"detail": "测试：当前操作不可用。"}


@pytest.mark.parametrize(
    "method,suffix,manager_method",
    [
        ("GET", "", "get"),
        ("GET", "/file", "file"),
        ("POST", "/retry-upload", "retry_upload"),
        ("POST", "/signed-url", "signed_url"),
    ],
)
def test_missing_task_errors_are_sanitized_404(client, manager, method, suffix, manager_method):
    getattr(manager, manager_method).side_effect = KeyError("dummy-private-internal-detail")
    response = client.request(method, f"/api/tasks/{TASK_ID}{suffix}", headers=WEB_HEADERS)
    assert response.status_code == 404
    assert "任务不存在" in response.json()["detail"]
    assert "dummy-private" not in response.text


def test_real_manager_analysis_keeps_media_urls_server_side(client, local_manager, monkeypatch):
    jobs = importlib.import_module("jobs")
    internal_result = local_manager.analyses[ANALYSIS_ID][1]
    worker = Mock(return_value=internal_result)
    monkeypatch.setattr(jobs, "run_worker", worker)
    response = client.post("/api/analyze", headers=WEB_HEADERS, json={"url": "https://page.example/"})
    assert response.status_code == 200
    result = response.json()
    assert result["candidates"] == [{"id": "1", "title": "A track", "kind": "audio"}]
    assert "dummy-private-token" not in response.text and "https://media.example" not in response.text
    assert local_manager.analyses[result["analysis_id"]][1]["candidates"][0]["url"].startswith("https://")
    worker.assert_called_once_with(
        "analyze",
        {"url": "https://page.example/"},
        local_manager.settings.analyze_timeout_seconds,
        stop=local_manager.stop,
        label="analyze",
    )


def test_video_mode_rejects_audio_candidate_without_queueing(client, local_manager):
    response = client.post(
        "/api/tasks",
        headers=WEB_HEADERS,
        json={"analysis_id": ANALYSIS_ID, "candidate_id": "1", "mode": "video", "upload": False},
    )
    assert response.status_code == 400
    assert "音频" in response.json()["detail"]
    assert local_manager.pending.empty() and not local_manager.tasks


@pytest.mark.parametrize("invalid", ["analysis", "candidate", "expired"])
def test_server_side_candidate_selection_rejects_invalid_or_expired_ids(client, local_manager, invalid):
    payload = {"analysis_id": ANALYSIS_ID, "candidate_id": "1", "upload": False}
    if invalid == "analysis":
        payload["analysis_id"] = "c" * 32
    elif invalid == "candidate":
        payload["candidate_id"] = "https://attacker.example/media"
    else:
        _, result = local_manager.analyses[ANALYSIS_ID]
        local_manager.analyses[ANALYSIS_ID] = (time.monotonic() - 901, result)
    response = client.post("/api/tasks", headers=WEB_HEADERS, json=payload)
    assert response.status_code == 400
    assert "attacker.example" not in response.text
    assert local_manager.pending.empty() and not local_manager.tasks


def test_audio_submission_only_queues_and_hides_internal_fields(client, local_manager):
    payload = {"analysis_id": ANALYSIS_ID, "candidate_id": "1", "mode": "audio", "upload": False}
    response = client.post("/api/tasks", headers=WEB_HEADERS, json=payload)
    assert response.status_code == 202
    task = response.json()
    assert task["status"] == "queued" and task["mode"] == "audio" and task["upload"] is False
    assert all(not key.startswith("_") for key in task)
    assert "dummy-private-token" not in response.text
    assert local_manager.pending.qsize() == 1
    assert client.get(f"/api/tasks/{task['id']}").json() == task
    assert client.get("/api/tasks").json() == {"tasks": [task]}
    duplicate = client.post("/api/tasks", headers=WEB_HEADERS, json=payload)
    assert duplicate.status_code == 400 and "处理中" in duplicate.json()["detail"]
    assert local_manager.pending.qsize() == 1


def test_unconfigured_upload_is_rejected_before_queueing(client, local_manager):
    response = client.post(
        "/api/tasks",
        headers=WEB_HEADERS,
        json={"analysis_id": ANALYSIS_ID, "candidate_id": "1", "upload": True},
    )
    assert response.status_code == 400 and "OSS 未配置" in response.json()["detail"]
    assert local_manager.pending.empty() and not local_manager.tasks
