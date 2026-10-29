import json
import logging
import os
import queue
import re
import selectors
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

from config import ROOT, Settings
from logs import describe_error
from security import UserError, safe_error

TERMINAL = {"completed", "failed"}
log = logging.getLogger("jobs")


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _host(url: str) -> str:
    # Log only the host: full media URLs may carry signed query strings.
    try:
        return urlsplit(url).hostname or "?"
    except ValueError:
        return "?"


def folder_size(directory: Path) -> int:
    total = 0
    for path in directory.rglob("*"):
        try:
            if path.is_file() and not path.is_symlink():
                total += path.stat().st_size
        except FileNotFoundError:
            pass
    return total


def run_worker(
    operation: str,
    payload: dict,
    timeout: int,
    emit=None,
    directory: Path | None = None,
    max_bytes: int | None = None,
    stop: threading.Event | None = None,
    label: str = "",
) -> dict:
    process = subprocess.Popen(
        [sys.executable, "-u", str(ROOT / "worker.py")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        start_new_session=True,
        cwd=ROOT,
    )
    tag = f"[{label or operation}] "
    log.debug("%s启动子进程 pid=%s operation=%s timeout=%ss", tag, process.pid, operation, timeout)
    selector = selectors.DefaultSelector()
    result = None
    error = None
    started = time.monotonic()
    try:
        process.stdin.write(json.dumps({"operation": operation, **payload}))
        process.stdin.close()
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            if stop and stop.is_set():
                raise UserError("服务正在关闭，任务已停止。")
            if time.monotonic() - started > timeout:
                log.warning("%s子进程 pid=%s 超过 %ss 未完成，强制结束", tag, process.pid, timeout)
                raise UserError("任务阶段超时，已停止处理；请检查网络或调整本地超时配置。")
            if directory and max_bytes and folder_size(directory) > max_bytes:
                log.warning("%s临时目录超过 %s 字节，强制结束子进程 pid=%s", tag, max_bytes, process.pid)
                raise UserError("下载或转码临时文件超过大小限制，任务已停止。")
            for key, _ in selector.select(timeout=0.25):
                line = key.fileobj.readline()
                if not line:
                    selector.unregister(key.fileobj)
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    log.debug("%s忽略子进程非 JSON 输出：%.200s", tag, line.rstrip())
                    continue
                if event.get("event") == "result":
                    result = event["result"]
                elif event.get("event") == "error":
                    error = event.get("error", "处理失败。")
                elif event.get("event") == "log":
                    _forward_log(event, tag)
                elif event.get("event") == "progress" and emit:
                    emit(event)
        process.wait(timeout=5)
        if error:
            raise UserError(error)
        if process.returncode or result is None:
            log.error(
                "%s子进程 pid=%s 意外退出 returncode=%s has_result=%s",
                tag,
                process.pid,
                process.returncode,
                result is not None,
            )
            raise UserError("媒体处理子进程意外退出，请检查依赖和可用磁盘空间。")
        return result
    finally:
        selector.close()
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        process.stdout.close()


def _forward_log(event: dict, tag: str) -> None:
    """Re-log a worker record under its original logger name so LOG_LEVEL filtering still applies."""
    name = event.get("name")
    message = event.get("message")
    if not isinstance(name, str) or not isinstance(message, str):
        return
    level = logging.getLevelName(str(event.get("level", "INFO")).upper())
    if not isinstance(level, int):
        level = logging.INFO
    logging.getLogger(re.sub(r"[^\w.]", "_", name)[:64]).log(level, "%s%.4000s", tag, message)


class JobManager:
    def __init__(self, settings: Settings, runtime: Path | None = None):
        self.settings = settings
        self.runtime = runtime or ROOT / ".runtime"
        self.tasks: dict[str, dict] = {}
        self.analyses: dict[str, tuple[float, dict]] = {}
        self.lock = threading.RLock()
        self.analysis_gate = threading.BoundedSemaphore(2)
        self.pending = queue.Queue(maxsize=settings.max_queue)
        self.stop = threading.Event()
        self.thread = None
        self.instance_lock = None

    def start(self):
        import fcntl

        self.runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.instance_lock = (self.runtime / ".lock").open("a")
        try:
            fcntl.flock(self.instance_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.instance_lock.close()
            raise RuntimeError("该项目已有服务运行，请勿启动多个实例。") from None
        self.cleanup()
        self.thread = threading.Thread(target=self._work, daemon=True)
        self.thread.start()
        log.info("任务管理器已启动 runtime=%s max_queue=%s", self.runtime, self.settings.max_queue)

    def close(self):
        active = [t["id"] for t in self.tasks.values() if t["status"] not in TERMINAL]
        if active:
            log.warning("服务关闭，中止 %s 个未完成任务：%s", len(active), ", ".join(active))
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=10)
        if self.instance_lock:
            self.instance_lock.close()
        log.info("任务管理器已关闭")

    def analyze(self, url: str) -> dict:
        if not self.analysis_gate.acquire(blocking=False):
            raise UserError("当前有其他链接正在分析，请稍后重试。")
        started = time.monotonic()
        try:
            log.info("开始分析链接 host=%s", _host(url))
            result = run_worker(
                "analyze",
                {"url": url},
                self.settings.analyze_timeout_seconds,
                stop=self.stop,
                label="analyze",
            )
            analysis_id = uuid.uuid4().hex
            with self.lock:
                self._expire_analyses()
                if len(self.analyses) >= 100:
                    self.analyses.pop(next(iter(self.analyses)))
                self.analyses[analysis_id] = (
                    time.monotonic(),
                    {**result, "page_host": urlsplit(url).hostname},
                )
            log.info(
                "分析完成 analysis=%s source=%s candidates=%s 用时 %.1fs",
                analysis_id,
                result.get("source"),
                len(result["candidates"]),
                time.monotonic() - started,
            )
            return {
                "analysis_id": analysis_id,
                **result,
                "candidates": [{k: v for k, v in c.items() if k != "url"} for c in result["candidates"]],
            }
        except Exception as exc:
            log.warning(
                "分析失败 host=%s 用时 %.1fs：%s", _host(url), time.monotonic() - started, describe_error(exc)
            )
            raise
        finally:
            self.analysis_gate.release()

    def _expire_analyses(self):
        for key, (created, _) in list(self.analyses.items()):
            if time.monotonic() - created > 900:
                del self.analyses[key]

    def submit(self, analysis_id: str, candidate_id: str, mode: str, upload: bool) -> dict:
        if upload and self.settings.oss_missing:
            raise UserError("OSS 未配置，请填写：" + "、".join(self.settings.oss_missing))
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise UserError("缺少 FFmpeg/FFprobe，请先安装 FFmpeg 后再下载。")
        with self.lock:
            self._expire_analyses()
            record = self.analyses.get(analysis_id)
            if not record:
                raise UserError("分析结果已失效，请重新分析链接。")
            candidate = next((c for c in record[1]["candidates"] if c["id"] == candidate_id), None)
            if not candidate:
                raise UserError("请选择当前分析结果中的媒体。")
            if mode == "video" and candidate["kind"] == "audio":
                raise UserError("该候选是音频，无法下载为视频。")
            if any(
                t["_url"] == candidate["url"] and t["mode"] == mode and t["status"] not in TERMINAL
                for t in self.tasks.values()
            ):
                raise UserError("相同链接和模式的任务已在处理中。")
            if self.pending.full():
                raise UserError("任务队列已满，请等待当前任务完成。")
            task_id = uuid.uuid4().hex
            task = {
                "id": task_id,
                "title": candidate["title"],
                "status": "queued",
                "progress": None,
                "error": None,
                "created_at": now_iso(),
                "mode": mode,
                "upload": upload,
                "filename": None,
                "size": None,
                "object_key": None,
                "signed_url": None,
                "expires_at": None,
                "_url": candidate["url"],
                "_path": None,
                "_key": None,
                "_finished": None,
                "_upload_only": False,
                "_source": record[1].get("source"),
                "_source_host": record[1].get("page_host"),
                "_artist": None,
                "_duration": None,
            }
            self.tasks[task_id] = task
            self.pending.put_nowait(task_id)
            log.info(
                "任务已排队 task=%s mode=%s upload=%s kind=%s host=%s title=%.80s",
                task_id,
                mode,
                upload,
                candidate["kind"],
                _host(candidate["url"]),
                candidate["title"],
            )
            return self._view(task)

    def _view(self, task: dict) -> dict:
        available = bool(task["_path"] and Path(task["_path"]).is_file())
        return {
            **{k: v for k, v in task.items() if not k.startswith("_")},
            "local_available": available,
            "download_url": f"/api/tasks/{task['id']}/file" if available else None,
            "can_retry_upload": available
            and task["status"] in TERMINAL
            and not task["object_key"]
            and not self.settings.oss_missing,
        }

    def get(self, task_id: str) -> dict:
        with self.lock:
            return self._view(self._task(task_id))

    def list(self) -> list[dict]:
        with self.lock:
            return [self._view(t) for t in reversed(list(self.tasks.values()))]

    def _task(self, task_id: str) -> dict:
        if task_id not in self.tasks:
            raise KeyError(task_id)
        return self.tasks[task_id]

    def file(self, task_id: str) -> Path:
        with self.lock:
            task = self._task(task_id)
            if not task["_path"] or not Path(task["_path"]).is_file():
                raise UserError("文件尚未下载完成或已自动清理。")
            return Path(task["_path"])

    def retry_upload(self, task_id: str) -> dict:
        with self.lock:
            task = self._task(task_id)
            if not self._view(task)["can_retry_upload"]:
                raise UserError("当前任务不能重试上传，请检查文件、OSS 配置和任务状态。")
            if self.pending.full():
                raise UserError("任务队列已满，请稍后重试。")
            task.update(status="queued", progress=None, error=None, upload=True, _upload_only=True)
            self.pending.put_nowait(task_id)
            log.info("任务重试上传 task=%s key=%s", task_id, task["_key"])
            return self._view(task)

    def signed_url(self, task_id: str) -> dict:
        from oss_store import sign_url

        with self.lock:
            task = self._task(task_id)
            if not task["object_key"]:
                raise UserError("此任务尚未成功上传到 OSS。")
            try:
                signed = sign_url(task["object_key"], self.settings)
            except Exception as exc:
                log.warning(
                    "签名链接生成失败 task=%s key=%s：%s", task_id, task["object_key"], describe_error(exc)
                )
                raise UserError(safe_error(exc)) from None
            task.update(signed)
            log.info("签名链接已生成 task=%s expires_at=%s", task_id, signed["expires_at"])
            return signed

    def list_objects(self, token: str = "") -> dict:
        from oss_store import list_objects

        if self.settings.oss_missing:
            raise UserError("OSS 未配置，请填写：" + "、".join(self.settings.oss_missing))
        # Network call: never hold self.lock here, task updates must keep flowing.
        return list_objects(self.settings, token)

    def object_signed_url(self, key: str) -> dict:
        from oss_store import ensure_listed_key, sign_url

        if self.settings.oss_missing:
            raise UserError("OSS 未配置，请填写：" + "、".join(self.settings.oss_missing))
        key = ensure_listed_key(key, self.settings)
        signed = sign_url(key, self.settings)
        log.info("对象签名链接已生成 key=%s expires_at=%s", key, signed["expires_at"])
        return signed

    def delete_object(self, key: str) -> dict:
        from oss_store import delete_object, ensure_listed_key

        if self.settings.oss_missing:
            raise UserError("OSS 未配置，请填写：" + "、".join(self.settings.oss_missing))
        key = ensure_listed_key(key, self.settings)
        with self.lock:
            if any(t["_key"] == key and t["status"] not in TERMINAL for t in self.tasks.values()):
                raise UserError("该文件的上传任务仍在进行中，请完成后再删除。")
        # Network calls: never hold self.lock here, task updates must keep flowing.
        result = delete_object(key, self.settings)
        with self.lock:
            for task in self.tasks.values():
                if task["object_key"] == key:
                    # The local copy (if still kept) may be uploaded again with "重试上传".
                    task.update(object_key=None, signed_url=None, expires_at=None)
        log.info("已删除 OSS 文件 key=%s catalog_updated=%s", key, result["catalog"])
        return result

    def update(self, task_id: str, **values):
        with self.lock:
            self.tasks[task_id].update(values)

    def _work(self):
        while not self.stop.is_set():
            try:
                task_id = self.pending.get(timeout=1)
            except queue.Empty:
                self.cleanup()
                continue
            started = time.monotonic()
            try:
                self._execute(task_id)
                log.info("任务完成 task=%s 用时 %.1fs", task_id, time.monotonic() - started)
            except Exception as exc:
                task = self.tasks.get(task_id, {})
                log.error(
                    "任务失败 task=%s stage=%s 用时 %.1fs：%s",
                    task_id,
                    task.get("status"),
                    time.monotonic() - started,
                    describe_error(exc),
                )
                self.update(task_id, status="failed", error=safe_error(exc), progress=None)
            finally:
                self.update(task_id, _finished=time.time())
                marker = self.runtime / task_id / ".managed"
                if marker.is_file():
                    marker.touch()
                self.pending.task_done()

    def _execute(self, task_id: str):
        from oss_store import make_object_key

        task = self.tasks[task_id]
        directory = self.runtime / task_id

        def progress(event):
            value = event.get("progress")
            if value is not None:
                value = max(0, min(100, float(value)))
            if event["status"] != task["status"]:
                log.info("任务阶段变更 task=%s %s -> %s", task_id, task["status"], event["status"])
            self.update(task_id, status=event["status"], progress=value)

        if not task["_upload_only"]:
            self.cleanup()
            reserve = self.settings.max_file_mb * 3 * 1024 * 1024
            if folder_size(self.runtime) + reserve > self.settings.max_storage_mb * 1024 * 1024:
                raise UserError("临时目录空间额度不足，请等待过期文件清理或提高 MAX_STORAGE_MB。")
            if shutil.disk_usage(self.runtime).free < reserve + 100 * 1024 * 1024:
                raise UserError("磁盘可用空间不足。")
            directory.mkdir(mode=0o700)
            (directory / ".managed").touch()
            self.update(task_id, status="analyzing", progress=None)
            log.info("任务开始下载 task=%s mode=%s directory=%s", task_id, task["mode"], directory)
            result = run_worker(
                "download",
                {"url": task["_url"], "mode": task["mode"], "directory": str(directory)},
                self.settings.download_timeout_seconds,
                emit=progress,
                directory=directory,
                max_bytes=reserve,
                stop=self.stop,
                label=task_id,
            )
            path = Path(result["path"]).resolve()
            if path.parent != directory.resolve() or not path.is_file() or path.is_symlink():
                raise UserError("下载器返回的文件无效。")
            if not 0 < path.stat().st_size <= self.settings.max_file_mb * 1024 * 1024:
                raise UserError("最终文件为空或超过大小限制。")
            self.update(
                task_id,
                _path=str(path),
                filename=path.name,
                size=path.stat().st_size,
                _artist=result.get("artist"),
                _duration=result.get("duration"),
            )
            log.info("任务下载完成 task=%s file=%s size=%s", task_id, path.name, path.stat().st_size)
        if task["upload"]:
            path = self.file(task_id)
            if not task["_key"]:
                self.update(task_id, _key=make_object_key(path.name, self.settings))
            self.update(task_id, status="uploading", progress=None)
            log.info("任务开始上传 task=%s bucket=%s key=%s", task_id, self.settings.oss_bucket, task["_key"])
            result = run_worker(
                "upload",
                {"path": str(path), "key": task["_key"], "info": self._catalog_info(task, path)},
                self.settings.upload_timeout_seconds,
                emit=progress,
                stop=self.stop,
                label=task_id,
            )
            self.update(task_id, object_key=result["object_key"])
            log.info(
                "任务上传完成 task=%s key=%s catalog=%s", task_id, result["object_key"], result.get("catalog")
            )
            warnings = []
            if result.get("catalog") is False:
                warnings.append("文件已上传，但曲目信息未写入 catalog.json，列表中将显示文件名。")
            try:
                self.signed_url(task_id)
            except UserError:
                warnings.append("文件已上传，但签名链接生成失败；请稍后刷新链接。")
            if warnings:
                self.update(task_id, error="\n".join(warnings))
        self.update(task_id, status="completed", progress=100)

    @staticmethod
    def _catalog_info(task: dict, path: Path) -> dict:
        """Descriptive fields for catalog.json; never the media URL, which may carry signatures."""
        return {
            "title": task["title"],
            "artist": task["_artist"],
            "duration": task["_duration"],
            "source": task["_source"],
            "source_host": task["_source_host"],
            "mode": task["mode"],
            "size": path.stat().st_size,
        }

    def cleanup(self):
        cutoff = time.time() - self.settings.retention_hours * 3600
        with self.lock:
            active = {key for key, task in self.tasks.items() if task["status"] not in TERMINAL}
            for directory in self.runtime.iterdir():
                marker = directory / ".managed"
                if directory.is_symlink() or not re.fullmatch(r"[0-9a-f]{32}", directory.name):
                    continue
                if directory.name in active or not marker.is_file():
                    continue
                finished = self.tasks.get(directory.name, {}).get("_finished")
                if (finished or marker.stat().st_mtime) < cutoff:
                    shutil.rmtree(directory)
                    log.info("已清理过期临时目录 task=%s", directory.name)
            removable = [
                key
                for key, task in self.tasks.items()
                if task["status"] in TERMINAL and not self._view(task)["local_available"]
            ]
            for key in removable[:-100]:
                del self.tasks[key]
