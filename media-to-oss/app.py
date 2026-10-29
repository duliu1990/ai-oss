import hashlib
import logging
import shutil
from contextlib import asynccontextmanager
from typing import Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from config import ROOT, settings
from jobs import JobManager
from logs import describe_error, setup_logging
from security import UserError

setup_logging(settings)
log = logging.getLogger("app")
manager = JobManager(settings)


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info(
        "服务启动 log_level=%s log_file=%s oss_ready=%s endpoint=%s bucket=%s prefix=%s ai_enabled=%s",
        settings.log_level,
        settings.log_file or "-",
        not settings.oss_missing,
        urlsplit(settings.oss_endpoint).hostname or "-",
        settings.oss_bucket or "-",
        settings.oss_prefix or "-",
        settings.ai_enabled,
    )
    log.info(
        "限制 max_file_mb=%s max_storage_mb=%s max_queue=%s retention_hours=%s 依赖 %s",
        settings.max_file_mb,
        settings.max_storage_mb,
        settings.max_queue,
        settings.retention_hours,
        " ".join(
            f"{name}={'ok' if shutil.which(name) else '缺失'}" for name in ("ffmpeg", "ffprobe", "node")
        ),
    )
    if settings.oss_missing:
        log.warning("OSS 未配置完整，缺少：%s", ", ".join(settings.oss_missing))
    manager.start()
    yield
    manager.close()
    log.info("服务已停止")


app = FastAPI(title="Media to OSS", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])


@app.middleware("http")
async def local_guard(request: Request, call_next):
    origin = request.headers.get("origin")
    expected = f"{request.url.scheme}://{request.headers.get('host', '')}"
    if (origin and origin != expected) or request.headers.get("sec-fetch-site") == "cross-site":
        log.warning("拒绝跨站请求 %s %s origin=%.200s", request.method, request.url.path, origin)
        return JSONResponse({"detail": "仅允许本机页面的同源请求。"}, status_code=403)
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        if request.headers.get("x-media-client") != "web":
            log.warning("拒绝缺少客户端标识的请求 %s %s", request.method, request.url.path)
            return JSONResponse({"detail": "缺少同源请求标识。"}, status_code=403)
        size = request.headers.get("content-length", "0")
        if not size.isdigit() or int(size) > 16384:
            log.warning("拒绝过大请求 %s %s content_length=%.20s", request.method, request.url.path, size)
            return JSONResponse({"detail": "请求内容过大。"}, status_code=413)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    )
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    else:
        # Revalidate the page and static assets (ETag) so an updated app.js is never served stale.
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.exception_handler(UserError)
async def user_error(request, exc):
    log.info("请求被拒绝 %s %s：%s", request.method, request.url.path, exc)
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(KeyError)
async def not_found(request, exc):
    log.info("任务不存在 %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "任务不存在，服务重启后历史任务会清空。"}, status_code=404)


@app.exception_handler(RequestValidationError)
async def invalid_request(request, exc):
    # Only log field locations: the rejected values may include the submitted URL.
    fields = sorted({".".join(str(p) for p in e.get("loc", ())) for e in exc.errors()})
    log.info("请求参数无效 %s %s fields=%s", request.method, request.url.path, ",".join(fields) or "-")
    return JSONResponse({"detail": "请求参数不正确，请检查链接、候选和下载模式。"}, status_code=422)


@app.exception_handler(Exception)
async def internal_error(request, exc):
    log.exception("未处理异常 %s %s：%s", request.method, request.url.path, describe_error(exc))
    return JSONResponse({"detail": "服务内部错误，请查看服务日志。"}, status_code=500)


class AnalyzeInput(BaseModel):
    url: str = Field(min_length=1, max_length=8192)


class TaskInput(BaseModel):
    analysis_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    candidate_id: str = Field(min_length=1, max_length=40)
    mode: Literal["audio", "video"] = "audio"
    upload: bool = True


class ObjectInput(BaseModel):
    key: str = Field(min_length=1, max_length=1023)


STATIC_ASSETS = ("app.js", "style.css")


@app.get("/")
def index():
    # Versioned asset URLs: a browser holding an old cached app.js must fetch the new one.
    static = ROOT / "static"
    version = hashlib.sha256(b"".join((static / name).read_bytes() for name in STATIC_ASSETS)).hexdigest()[
        :12
    ]
    html = (static / "index.html").read_text(encoding="utf-8")
    for name in STATIC_ASSETS:
        html = html.replace(f'"/static/{name}"', f'"/static/{name}?v={version}"')
    return HTMLResponse(html)


@app.get("/api/config")
def config_status():
    return {
        "oss_ready": not settings.oss_missing,
        "oss_missing": settings.oss_missing,
        "ai_enabled": settings.ai_enabled,
        "dependencies": {name: bool(shutil.which(name)) for name in ("ffmpeg", "ffprobe", "node")},
        "limits": {
            "max_file_mb": settings.max_file_mb,
            "retention_hours": settings.retention_hours,
            "max_queue": settings.max_queue,
        },
    }


@app.post("/api/analyze")
def analyze(data: AnalyzeInput):
    return manager.analyze(data.url)


@app.post("/api/tasks", status_code=202)
def submit_task(data: TaskInput):
    return manager.submit(data.analysis_id, data.candidate_id, data.mode, data.upload)


@app.get("/api/tasks")
def tasks():
    return {"tasks": manager.list()}


@app.get("/api/tasks/{task_id}")
def task(task_id: str):
    return manager.get(task_id)


@app.get("/api/tasks/{task_id}/file")
def download_file(task_id: str):
    path = manager.file(task_id)
    return FileResponse(path, filename=path.name, media_type="application/octet-stream")


@app.post("/api/tasks/{task_id}/retry-upload", status_code=202)
def retry_upload(task_id: str):
    return manager.retry_upload(task_id)


@app.post("/api/tasks/{task_id}/signed-url")
def signed_url(task_id: str):
    return manager.signed_url(task_id)


@app.get("/api/objects")
def objects(token: str = Query("", max_length=1024)):
    return manager.list_objects(token)


@app.post("/api/objects/signed-url")
def object_signed_url(data: ObjectInput):
    return manager.object_signed_url(data.key)


@app.post("/api/objects/delete")
def delete_object(data: ObjectInput):
    return manager.delete_object(data.key)


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


if __name__ == "__main__":
    import truststore
    import uvicorn

    # Object listing talks to OSS from this process; trust the system store like worker.py does.
    truststore.inject_into_ssl()
    # log_config=None keeps uvicorn on the root logger configured by setup_logging().
    uvicorn.run(app, host="127.0.0.1", port=8765, access_log=False, log_config=None)
