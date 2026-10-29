import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

import jobs
from config import Settings
from jobs import JobManager
from security import UserError


def configured(**overrides):
    return Settings(
        _env_file=None,
        oss_endpoint="https://oss-cn-hangzhou.aliyuncs.com",
        oss_bucket="test-bucket",
        oss_access_key_id="test-id",
        oss_access_key_secret="test-secret",
        **overrides,
    )


@pytest.fixture
def manager(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs.shutil, "which", lambda name: "/usr/bin/" + name)
    m = JobManager(configured(), tmp_path)
    m.analyses["a" * 32] = (
        time.monotonic(),
        {
            "title": "Sample",
            "source": "test",
            "candidates": [
                {"id": "1", "title": "Sample", "kind": "video", "url": "https://example.com/media.mp4"}
            ],
        },
    )
    return m


def submit(manager, upload=False):
    return manager.submit("a" * 32, "1", "audio", upload)


def fake_download(operation, payload, timeout, **kwargs):
    assert operation == "download"
    path = Path(payload["directory"]) / "media.mp3"
    path.write_bytes(b"test media")
    kwargs["emit"]({"status": "downloading", "progress": 50})
    return {"path": str(path), "filename": path.name, "size": path.stat().st_size}


def test_download_only_complete(manager, monkeypatch):
    monkeypatch.setattr(jobs, "run_worker", fake_download)
    task = submit(manager)
    manager._execute(task["id"])
    result = manager.get(task["id"])
    assert result["status"] == "completed"
    assert result["local_available"] is True
    assert result["can_retry_upload"] is True
    assert result["size"] == 10
    assert "_url" not in result and "_path" not in result
    assert result["download_url"].endswith("/file")
    assert manager.file(task["id"]).read_bytes() == b"test media"


def test_download_upload_and_retry_reuses_file(manager, monkeypatch):
    import oss_store

    monkeypatch.setattr(
        oss_store,
        "sign_url",
        lambda key, settings: {
            "signed_url": "https://example.com/signed",
            "expires_at": "2030-01-01T00:00:00+00:00",
        },
    )
    calls = []
    failure = True

    def run(operation, payload, timeout, **kwargs):
        calls.append((operation, payload.copy()))
        if operation == "download":
            return fake_download(operation, payload, timeout, **kwargs)
        if failure:
            raise UserError("上传失败。")
        kwargs["emit"]({"status": "uploading", "progress": 80})
        return {"object_key": payload["key"]}

    monkeypatch.setattr(jobs, "run_worker", run)
    task = submit(manager, upload=True)
    with pytest.raises(UserError, match="上传失败"):
        manager._execute(task["id"])
    manager.update(task["id"], status="failed")
    key = manager.tasks[task["id"]]["_key"]
    assert manager.get(task["id"])["can_retry_upload"]
    assert manager.file(task["id"]).is_file()
    manager.pending.get_nowait()
    failure = False
    manager.retry_upload(task["id"])
    with pytest.raises(UserError):
        manager.retry_upload(task["id"])
    manager._execute(task["id"])
    result = manager.get(task["id"])
    assert result["status"] == "completed"
    assert result["object_key"] == key
    assert result["signed_url"].startswith("https://")
    assert not result["can_retry_upload"]
    assert [operation for operation, _ in calls] == ["download", "upload", "upload"]


def test_upload_payload_carries_catalog_info_and_warns_on_failure(manager, monkeypatch):
    import oss_store

    monkeypatch.setattr(
        oss_store,
        "sign_url",
        lambda key, settings: {"signed_url": "https://example.com/s", "expires_at": "2030-01-01T00:00:00Z"},
    )
    manager.analyses["a" * 32][1]["page_host"] = "www.example.com"
    payloads = []

    def run(operation, payload, timeout, **kwargs):
        if operation == "download":
            return {
                **fake_download(operation, payload, timeout, **kwargs),
                "artist": "Singer",
                "duration": 61.5,
            }
        payloads.append(payload)
        return {"object_key": payload["key"], "catalog": False}

    monkeypatch.setattr(jobs, "run_worker", run)
    task = submit(manager, upload=True)
    manager._execute(task["id"])
    assert payloads[0]["info"] == {
        "title": "Sample",
        "artist": "Singer",
        "duration": 61.5,
        "source": "test",
        "source_host": "www.example.com",
        "mode": "audio",
        "size": 10,
    }
    result = manager.get(task["id"])
    assert result["status"] == "completed" and "catalog.json" in result["error"]


def test_missing_oss_preflight(manager):
    manager.settings.oss_bucket = ""
    with pytest.raises(UserError, match="OSS_BUCKET"):
        submit(manager, upload=True)
    assert not manager.tasks


def test_object_listing_and_signing_delegate_to_oss_store(manager, monkeypatch):
    import oss_store

    calls = []
    monkeypatch.setattr(
        oss_store,
        "list_objects",
        lambda settings, token: (
            calls.append(token) or {"objects": [], "prefix": "media/", "truncated": False, "next_token": None}
        ),
    )
    monkeypatch.setattr(
        oss_store,
        "sign_url",
        lambda key, settings: {
            "signed_url": f"https://example.com/{key}",
            "expires_at": "2030-01-01T00:00:00Z",
        },
    )
    assert manager.list_objects("next")["truncated"] is False and calls == ["next"]
    assert manager.object_signed_url("media/file.mp3")["signed_url"].endswith("/media/file.mp3")
    with pytest.raises(UserError, match="前缀"):
        manager.object_signed_url("other/file.mp3")
    manager.settings.oss_bucket = ""
    with pytest.raises(UserError, match="OSS_BUCKET"):
        manager.list_objects()
    with pytest.raises(UserError, match="OSS_BUCKET"):
        manager.object_signed_url("media/file.mp3")


def test_delete_object_refuses_active_uploads_and_detaches_tasks(manager, monkeypatch):
    import oss_store

    calls = []
    monkeypatch.setattr(
        oss_store,
        "delete_object",
        lambda key, settings: calls.append(key) or {"key": key, "catalog": True, "warning": None},
    )
    task = submit(manager, upload=True)
    manager.update(task["id"], status="uploading", _key="media/file.mp3")
    with pytest.raises(UserError, match="仍在进行中"):
        manager.delete_object("media/file.mp3")
    assert calls == []
    manager.update(
        task["id"],
        status="completed",
        object_key="media/file.mp3",
        signed_url="https://example.com/s",
        expires_at="2030-01-01T00:00:00Z",
    )
    assert manager.delete_object("media/file.mp3")["catalog"] is True and calls == ["media/file.mp3"]
    view = manager.get(task["id"])
    assert view["object_key"] is None and view["signed_url"] is None and view["expires_at"] is None
    with pytest.raises(UserError, match="前缀"):
        manager.delete_object("other/file.mp3")
    manager.settings.oss_bucket = ""
    with pytest.raises(UserError, match="OSS_BUCKET"):
        manager.delete_object("media/file.mp3")
    assert calls == ["media/file.mp3"]


def test_duplicate_and_invalid_candidate(manager):
    submit(manager)
    with pytest.raises(UserError, match="已在处理"):
        submit(manager)
    with pytest.raises(UserError, match="请选择"):
        manager.submit("a" * 32, "invented", "audio", False)


def test_expired_analysis(manager):
    _, record = manager.analyses["a" * 32]
    manager.analyses["a" * 32] = (time.monotonic() - 901, record)
    with pytest.raises(UserError, match="已失效"):
        submit(manager)


def test_audio_cannot_be_video(manager):
    manager.analyses["a" * 32][1]["candidates"][0]["kind"] = "audio"
    with pytest.raises(UserError, match="音频"):
        manager.submit("a" * 32, "1", "video", False)


def test_queue_bound(manager):
    manager.pending.maxsize = 1
    submit(manager)
    with pytest.raises(UserError, match="队列已满"):
        manager.submit("a" * 32, "1", "video", False)


def test_cleanup_only_owned_expired_files(manager, monkeypatch):
    import os

    old = time.time() - 25 * 3600
    expired = manager.runtime / ("1" * 32)
    expired.mkdir()
    marker = expired / ".managed"
    marker.touch()
    os.utime(marker, (old, old))
    unknown = manager.runtime / ("2" * 32)
    unknown.mkdir()
    unknown_file = unknown / "keep.txt"
    unknown_file.write_text("user file")
    manager.cleanup()
    assert not expired.exists()
    assert unknown_file.exists()


def test_reject_worker_file_outside_task_directory(manager, monkeypatch, tmp_path):
    outside = tmp_path / "outside.mp3"
    outside.write_bytes(b"private")
    monkeypatch.setattr(jobs, "run_worker", lambda *a, **k: {"path": str(outside)})
    task = submit(manager)
    with pytest.raises(UserError, match="文件无效"):
        manager._execute(task["id"])
    assert not manager.get(task["id"])["local_available"]


def test_storage_quota_prevents_worker(manager, monkeypatch):
    monkeypatch.setattr(jobs, "folder_size", lambda p: manager.settings.max_storage_mb * 1024 * 1024)
    task = submit(manager)
    with pytest.raises(UserError, match="空间额度"):
        manager._execute(task["id"])


def test_worker_timeout_terminates_child(monkeypatch):
    original = subprocess.Popen
    processes = []

    def slow_process(*args, **kwargs):
        process = original(
            [sys.executable, "-c", "import sys,time; sys.stdin.read(); time.sleep(30)"], **kwargs
        )
        processes.append(process)
        return process

    monkeypatch.setattr(jobs.subprocess, "Popen", slow_process)
    with pytest.raises(UserError, match="超时"):
        jobs.run_worker("analyze", {"url": "https://example.com"}, timeout=0.05)
    assert processes[0].poll() is not None


def test_worker_json_result(monkeypatch):
    original = subprocess.Popen
    result = {"event": "result", "result": {"ok": True}}

    def process(*args, **kwargs):
        script = "import sys; sys.stdin.read(); print(" + repr(json.dumps(result)) + ", flush=True)"
        return original([sys.executable, "-c", script], **kwargs)

    monkeypatch.setattr(jobs.subprocess, "Popen", process)
    assert jobs.run_worker("analyze", {}, timeout=5) == {"ok": True}
