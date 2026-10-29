import json
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def deployment(tmp_path):
    project = tmp_path / "project"
    tools = tmp_path / "bin"
    tools.mkdir()
    (project / "deploy").mkdir(parents=True)
    for name in ("deploy.sh", "server-setup.sh", "server-release.sh", "driver-oss.service"):
        shutil.copyfile(ROOT / "deploy" / name, project / "deploy" / name)
    for name in ("app.py", "config.py", "oss_store.py", "pyproject.toml", "uv.lock", ".env.example"):
        (project / name).write_text("fixture\n")
    (project / ".env").write_text("DO_NOT_UPLOAD=secret\n")
    for name in ("routes", "frontend/dist", "frontend/node_modules", ".venv", "routes/__pycache__"):
        (project / name).mkdir(parents=True, exist_ok=True)
    for name in ("routes/files.py", "frontend/dist/index.html", "routes/__pycache__/files.pyc"):
        (project / name).write_text("fixture\n")
    log = tmp_path / "calls.jsonl"
    archive = tmp_path / "uploaded.tar.gz"
    fake = f"""#!{sys.executable}
import json, os, shutil, sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as out:
    out.write(json.dumps([name, *args]) + "\\n")
if name == "npm" and os.environ.get("FAIL_BUILD") == "1":
    sys.exit(7)
if name == "ssh" and "mktemp -d" in args[-1]:
    print("/tmp/driver-oss.ABCDE12345")
if name == "scp":
    for arg in args[:-1]:
        if arg.endswith("/release.tar.gz"):
            shutil.copyfile(arg, os.environ["UPLOADED_ARCHIVE"])
if name == "ssh" and args[-1].startswith("sudo bash"):
    sys.exit(int(os.environ.get("REMOTE_STATUS", "0")))
"""
    for tool in ("npm", "ssh", "scp"):
        executable = tools / tool
        executable.write_text(fake)
        executable.chmod(0o755)
    env = {
        **os.environ,
        "PATH": f"{tools}:{os.environ['PATH']}",
        "CALL_LOG": str(log),
        "UPLOADED_ARCHIVE": str(archive),
    }

    def run(*args, **overrides):
        result = subprocess.run(
            ["bash", str(project / "deploy/deploy.sh"), *args],
            env={**env, **overrides},
            text=True,
            capture_output=True,
        )
        calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return result, calls, archive

    return run


@pytest.mark.parametrize(
    "args",
    [
        (),
        ("deploy",),
        ("deploy", "-oProxyCommand=bad"),
        ("deploy", "ubuntu@example.com"),
        ("setup", "driver-ecs", "extra"),
        ("rollback", "driver-ecs", "../current"),
    ],
)
def test_invalid_deployment_args_do_not_connect(deployment, args):
    result, calls, _ = deployment(*args)
    assert result.returncode != 0
    assert calls == []


def test_deploy_builds_locally_and_uploads_only_allowlisted_files(deployment):
    result, calls, archive = deployment("deploy", "driver-ecs")
    assert result.returncode == 0, result.stderr
    assert calls[:2] == [
        ["npm", "ci", "--no-audit", "--no-fund"],
        ["npm", "run", "build"],
    ]
    with tarfile.open(archive) as bundle:
        names = {name.rstrip("/") for name in bundle.getnames()}
    assert names == {
        "app.py",
        "config.py",
        "oss_store.py",
        "routes",
        "routes/files.py",
        "pyproject.toml",
        "uv.lock",
        "frontend/dist",
        "frontend/dist/index.html",
    }
    assert any("sudo bash" in call[-1] and " deploy " in call[-1] for call in calls)
    assert "rmdir '/tmp/driver-oss.ABCDE12345'" in calls[-1][-1]


def test_build_failure_never_connects(deployment):
    result, calls, archive = deployment("deploy", "driver-ecs", FAIL_BUILD="1")
    assert result.returncode == 7
    assert all(call[0] == "npm" for call in calls)
    assert not archive.exists()


def test_remote_failure_is_not_reported_as_success(deployment):
    result, calls, _ = deployment("deploy", "driver-ecs", REMOTE_STATUS="9")
    assert result.returncode == 9
    assert "rmdir '/tmp/driver-oss.ABCDE12345'" in calls[-1][-1]


def test_tunnel_listens_only_on_loopback(deployment):
    result, calls, _ = deployment("tunnel", "driver-ecs")
    assert result.returncode == 0
    assert len(calls) == 1
    assert "127.0.0.1:18700:127.0.0.1:8700" in calls[0]
    assert "ExitOnForwardFailure=yes" in calls[0]


@pytest.mark.parametrize("action", ["setup", "rollback"])
def test_setup_and_rollback_skip_frontend_build(deployment, action):
    args = (action, "driver-ecs")
    if action == "rollback":
        args += ("20261027T020000Z-AbCd1234",)
    result, calls, archive = deployment(*args)
    assert result.returncode == 0, result.stderr
    assert all(call[0] != "npm" for call in calls)
    assert not archive.exists()
    assert any("sudo bash" in call[-1] for call in calls)
