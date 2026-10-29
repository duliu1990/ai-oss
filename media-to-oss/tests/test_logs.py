import json
import logging
import subprocess
import sys
import threading
from io import StringIO
from types import SimpleNamespace
from unittest.mock import Mock

import oss2
import pytest

import jobs
import logs
import oss_store
from config import Settings
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


@pytest.mark.parametrize(
    "raw, hidden, kept",
    [
        (
            "OSSAccessKeyId=LTAI5tABCDEFGHIJKLMN&Signature=abc%2Fdef&Expires=1",
            ["LTAI5tABCDEFGHIJKLMN", "abc%2Fdef"],
            ["Expires=1"],
        ),
        (
            "Authorization: OSS LTAI5tABCDEFGHIJKLMN:sigvalue",
            ["LTAI5tABCDEFGHIJKLMN", "sigvalue"],
            ["Authorization"],
        ),
        ("header Bearer sk-secret-token failed", ["sk-secret-token"], ["failed"]),
        (
            "access_key_secret=dummysecret x-oss-security-token=stsvalue",
            ["dummysecret", "stsvalue"],
            ["access_key_secret"],
        ),
        (
            "code=AccessDenied request_id=6AD1E8 ec=0003-00000001",
            [],
            ["AccessDenied", "6AD1E8", "0003-00000001"],
        ),
    ],
)
def test_redact_hides_credentials_but_keeps_diagnostics(raw, hidden, kept):
    result = logs.redact(raw)
    for value in hidden:
        assert value not in result
    for value in kept:
        assert value in result


def test_describe_error_includes_type_and_truncates():
    text = logs.describe_error(ValueError("x" * 50), limit=10)
    assert text.startswith("ValueError: " + "x" * 10) and text.endswith("[已截断]")
    assert logs.describe_error(RuntimeError("")) == "RuntimeError: (无错误信息)"


def test_setup_logging_redacts_formatted_records_and_is_idempotent(tmp_path):
    stream = StringIO()
    settings = configured(log_level="debug", log_file=str(tmp_path / "server.log"))
    root = logs.setup_logging(settings, stream=stream)
    logs.setup_logging(settings, stream=stream)
    assert len([h for h in root.handlers if getattr(h, "_media_to_oss", False)]) == 2
    assert root.level == logging.DEBUG
    logging.getLogger("oss").error("failed Signature=abcdef key=%s", "media/x.mp3")
    output = stream.getvalue()
    assert "Signature=[已隐藏]" in output and "abcdef" not in output and "media/x.mp3" in output
    assert "Signature=[已隐藏]" in (tmp_path / "server.log").read_text()
    for handler in list(root.handlers):
        if getattr(handler, "_media_to_oss", False):
            root.removeHandler(handler)
            handler.close()


def test_log_level_validation():
    assert configured(log_level=" warning ").log_level == "WARNING"
    with pytest.raises(ValueError):
        configured(log_level="verbose")


def test_upload_failure_logs_oss_code_and_request_id(tmp_path, monkeypatch, caplog):
    path = tmp_path / "media.mp3"
    path.write_bytes(b"test audio")
    bucket = Mock()
    headers = {"x-oss-request-id": "6AD1E89A488C38383640D321"}
    body = (
        b"<Error><Code>AccessDenied</Code><Message>You have no right to access this object because of bucket acl."
        b"</Message><EC>0003-00000001</EC></Error>"
    )
    bucket.put_object_from_file.side_effect = oss2.exceptions.AccessDenied(
        403,
        headers,
        body,
        {
            "Code": "AccessDenied",
            "Message": "You have no right to access this object because of bucket acl.",
            "EC": "0003-00000001",
        },
    )
    monkeypatch.setattr(oss_store, "_bucket", lambda s: bucket)
    with caplog.at_level(logging.INFO), pytest.raises(UserError) as error:
        oss_store.upload_file(path, "media/test.mp3", lambda e: None, configured())
    record = next(r for r in caplog.records if r.name == "oss" and r.levelno == logging.ERROR)
    assert "code=AccessDenied" in record.getMessage()
    assert "request_id=6AD1E89A488C38383640D321" in record.getMessage()
    assert "ec=0003-00000001" in record.getMessage()
    assert "bucket acl" in record.getMessage()
    # The web UI keeps receiving the sanitized text only.
    assert "6AD1E89A" not in str(error.value) and "访问被拒绝" in str(error.value)


def test_upload_success_logs_request_id(tmp_path, monkeypatch, caplog):
    path = tmp_path / "media.mp3"
    path.write_bytes(b"test audio")
    bucket = Mock()
    bucket.put_object_from_file.return_value = SimpleNamespace(status=200, request_id="REQ123")
    monkeypatch.setattr(oss_store, "_bucket", lambda s: bucket)
    with caplog.at_level(logging.INFO):
        oss_store.upload_file(path, "media/test.mp3", lambda e: None, configured())
    assert any("上传成功" in r.getMessage() and "REQ123" in r.getMessage() for r in caplog.records)


def test_worker_log_events_are_forwarded_with_task_tag(monkeypatch, caplog):
    original = subprocess.Popen
    lines = [
        {"event": "log", "level": "ERROR", "name": "oss", "message": "OSS 上传失败 code=AccessDenied"},
        {"event": "log", "level": "nonsense", "name": "we ird/name", "message": "fallback level"},
        {"event": "log", "level": "INFO", "name": 5, "message": "ignored"},
        {"event": "result", "result": {"ok": True}},
    ]

    def process(*args, **kwargs):
        script = "import sys; sys.stdin.read()\n" + "\n".join(
            "print(" + repr(json.dumps(line)) + ", flush=True)" for line in lines
        )
        return original([sys.executable, "-c", script], **kwargs)

    monkeypatch.setattr(jobs.subprocess, "Popen", process)
    with caplog.at_level(logging.DEBUG):
        assert jobs.run_worker("upload", {}, timeout=10, label="task-1") == {"ok": True}
    forwarded = [r for r in caplog.records if r.name != "jobs" and r.getMessage().startswith("[task-1] ")]
    assert [(r.name, r.levelno) for r in forwarded] == [("oss", logging.ERROR), ("we_ird_name", logging.INFO)]
    assert "code=AccessDenied" in forwarded[0].getMessage()
    assert not any("ignored" in r.getMessage() for r in caplog.records)


def test_worker_handler_emits_json_log_events(capsys):
    import worker

    handler = worker.EventLogHandler()
    record = logging.LogRecord("oss", logging.ERROR, __file__, 1, "Signature=abc failed %s", ("now",), None)
    handler.emit(record)
    event = json.loads(capsys.readouterr().out.strip())
    assert event == {
        "event": "log",
        "level": "ERROR",
        "name": "oss",
        "message": "Signature=[已隐藏] failed now",
    }


@pytest.mark.parametrize("catalog_ok", [True, False])
def test_worker_upload_survives_catalog_failure(monkeypatch, capsys, catalog_ok):
    import worker

    def record(key, info, settings):
        assert key == "media/a.mp3" and info == {"title": "A"}
        if not catalog_ok:
            raise UserError("写入曲目信息失败。")

    monkeypatch.setattr(oss_store, "upload_file", lambda path, key, emit, settings: {"object_key": key})
    monkeypatch.setattr(oss_store, "record_upload", record)
    request = {"operation": "upload", "path": "/tmp/a.mp3", "key": "media/a.mp3", "info": {"title": "A"}}
    monkeypatch.setattr(sys, "stdin", StringIO(json.dumps(request)))
    worker.main()
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert events[-1] == {"event": "result", "result": {"object_key": "media/a.mp3", "catalog": catalog_ok}}


def test_task_failure_is_logged_with_raw_cause(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(jobs.shutil, "which", lambda name: "/usr/bin/" + name)
    manager = jobs.JobManager(configured(), tmp_path)
    task_id = "a" * 32
    manager.tasks[task_id] = {
        "id": task_id,
        "status": "queued",
        "_upload_only": True,
        "_path": None,
        "_key": None,
        "upload": True,
        "object_key": None,
        "_finished": None,
    }
    manager.pending.put_nowait(task_id)

    def failing(task_id):
        raise RuntimeError("boom OSSAccessKeyId=LTAI5tABCDEFGHIJKLMN")

    monkeypatch.setattr(manager, "_execute", failing)
    with caplog.at_level(logging.INFO):
        thread = threading.Thread(target=manager._work, daemon=True)
        thread.start()
        manager.pending.join()
        manager.stop.set()
        thread.join(timeout=5)
    record = next(r for r in caplog.records if r.name == "jobs" and r.levelno == logging.ERROR)
    assert "任务失败 task=" + task_id in record.getMessage()
    assert "RuntimeError: boom" in record.getMessage()
    assert manager.tasks[task_id]["status"] == "failed"
    assert "boom" not in manager.tasks[task_id]["error"]
