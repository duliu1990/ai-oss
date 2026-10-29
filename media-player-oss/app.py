import logging
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import APIRouter, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

import oss_store
from config import Settings, settings
from library import Library
from logs import describe_error, setup_logging
from security import UserError

PORT = 8767

setup_logging(settings)
log = logging.getLogger("app")
router = APIRouter()


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = app.state.settings
    log.info(
        "播放器启动 oss_ready=%s endpoint=%s bucket=%s prefix=%s library=%s",
        not settings.oss_missing,
        settings.oss_endpoint or "-",
        settings.oss_bucket or "-",
        settings.oss_prefix or "-",
        settings.library_path,
    )
    if settings.oss_missing:
        log.warning("OSS 未配置完整，缺少：%s", ", ".join(settings.oss_missing))
    yield
    log.info("播放器已停止")


async def local_guard(request: Request, call_next):
    origin = request.headers.get("origin")
    host = request.url.hostname or ""
    port = request.url.port
    default_port = 443 if request.url.scheme == "https" else 80
    authority = host if port is None or port == default_port else f"{host}:{port}"
    expected = f"{request.url.scheme}://{authority}"
    explicitly_allowed = origin in request.app.state.settings.cors_origins
    # Native clients without browser fetch metadata remain anonymous readers.
    # Cross-site WebView audio must send its explicitly allowed Origin.
    if (origin is not None and origin != expected and not explicitly_allowed) or (
        request.headers.get("sec-fetch-site") == "cross-site" and not explicitly_allowed
    ):
        log.warning("Rejected cross-site request %s %s", request.method, request.url.path)
        return JSONResponse({"detail": "Request origin is not allowed."}, status_code=403)
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        if request.headers.get("x-player-client") != "web":
            log.warning("拒绝缺少客户端标识的请求 %s %s", request.method, request.url.path)
            return JSONResponse({"detail": "缺少同源请求标识。"}, status_code=403)
        size = request.headers.get("content-length", "0")
        if not size.isascii() or not size.isdigit() or len(size) > 10 or int(size) > 4096:
            return JSONResponse({"detail": "请求内容过大。"}, status_code=413)
    try:
        return await call_next(request)
    except Exception as exc:
        # Keep unexpected API failures inside CORS so allowed clients can read the error.
        return await internal_error(request, exc)


async def security_headers(request: Request, call_next):
    try:
        # Validate ports before CORS can short-circuit a preflight request.
        # request.url can fall back to scope.server when the raw Host is invalid.
        urlsplit("//" + request.headers.get("host", "")).port
    except ValueError:
        response = JSONResponse({"detail": "Invalid Host header."}, status_code=400)
    else:
        response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        "font-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
        "base-uri 'none'; form-action 'self'"
    )
    if response.status_code >= 400:
        response.headers["Cache-Control"] = "no-store"
    else:
        response.headers.setdefault("Cache-Control", "no-store")
    return response


async def user_error(request, exc):
    log.info("请求被拒绝 %s %s：%s", request.method, request.url.path, exc)
    return JSONResponse({"detail": str(exc)}, status_code=400)


async def invalid_request(request, exc):
    fields = sorted({".".join(str(p) for p in e.get("loc", ())) for e in exc.errors()})
    log.info("请求参数无效 %s %s fields=%s", request.method, request.url.path, ",".join(fields) or "-")
    return JSONResponse({"detail": "请求参数不正确。"}, status_code=422)


async def internal_error(request, exc):
    log.exception("未处理异常 %s %s：%s", request.method, request.url.path, describe_error(exc))
    return JSONResponse({"detail": "服务内部错误，请查看服务日志。"}, status_code=500)


class MetaInput(BaseModel):
    key: str = Field(min_length=1, max_length=1023)
    title: str | None = Field(default=None, max_length=400)
    artist: str | None = Field(default=None, max_length=400)
    favorite: bool | None = None


@router.api_route("/", methods=["GET", "HEAD"])
def index(request: Request):
    index_path = request.app.state.settings.frontend_path / "index.html"
    if not index_path.is_file():
        return JSONResponse(
            {
                "detail": "Frontend build missing. Build frontend/dist or set FRONTEND_DIST to a built directory."
            },
            status_code=503,
        )
    return FileResponse(index_path, media_type="text/html", headers={"Cache-Control": "no-store"})


@router.api_route("/assets/{path:path}", methods=["GET", "HEAD"])
async def frontend_asset(request: Request, path: str):
    # Direct lookup also returns 404 when the build directory does not exist yet.
    # StaticFiles enforces directory confinement and never falls back to index.html.
    response = await request.app.state.frontend_assets.get_response(path, request.scope)
    if response.status_code in {200, 206, 304}:
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


@router.get("/healthz")
def health():
    return {"status": "ok"}


@router.get("/api/config")
def config_status(request: Request):
    settings = request.app.state.settings
    return {
        "oss_ready": not settings.oss_missing,
        "oss_missing": settings.oss_missing,
        "bucket": settings.oss_bucket,
        "prefix": oss_store.object_prefix(settings),
    }


@router.get("/api/tracks")
def tracks(request: Request):
    listing = oss_store.list_audio(request.app.state.settings)
    for track in listing["tracks"]:
        track.update(request.app.state.library.get(track["key"]))
    return listing


@router.put("/api/tracks/meta")
def update_meta(data: MetaInput, request: Request):
    key = oss_store.ensure_audio_key(data.key, request.app.state.settings)
    entry = request.app.state.library.update(
        key, title=data.title, artist=data.artist, favorite=data.favorite
    )
    return {"key": key, **entry}


@router.get("/api/stream")
def stream(request: Request, key: str = Query(min_length=1, max_length=1023)):
    try:
        audio = oss_store.open_stream(key, request.headers.get("range"), request.app.state.settings)
    except oss_store.RangeNotSatisfiable as exc:
        headers = {"Accept-Ranges": "bytes"}
        if exc.size is not None:
            headers["Content-Range"] = f"bytes */{exc.size}"
        return Response(status_code=416, headers=headers)
    return StreamingResponse(audio.body, status_code=audio.status, headers=audio.headers)


def create_app(app_settings: Settings | None = None, library_store: Library | None = None) -> FastAPI:
    configured = app_settings if app_settings is not None else settings
    application = FastAPI(
        title="Media Player OSS",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        redirect_slashes=False,
    )
    application.state.settings = configured
    application.state.library = (
        library_store if library_store is not None else Library(configured.library_path)
    )
    application.state.frontend_assets = StaticFiles(
        directory=configured.frontend_path / "assets",
        check_dir=False,
    )
    application.include_router(router)
    application.add_exception_handler(UserError, user_error)
    application.add_exception_handler(RequestValidationError, invalid_request)
    application.add_exception_handler(Exception, internal_error)

    # Last added runs first: security headers -> Host -> CORS -> request guard.
    # Invalid Hosts cannot bypass validation via preflight; valid preflights do
    # not require the write marker, while guard errors still receive CORS headers.
    application.middleware("http")(local_guard)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=configured.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "HEAD", "PUT", "OPTIONS"],
        allow_headers=["Content-Type", "X-Player-Client", "Range"],
        expose_headers=["Accept-Ranges", "Content-Range", "Content-Length"],
    )
    application.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=configured.allowed_hosts,
        www_redirect=False,
    )
    application.middleware("http")(security_headers)
    return application


app = create_app()


if __name__ == "__main__":
    import truststore
    import uvicorn

    # OSS HTTPS requests use the operating system's trusted certificate store.
    truststore.inject_into_ssl()
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=PORT,
        workers=1,
        proxy_headers=True,
        forwarded_allow_ips="127.0.0.1",
        access_log=False,
        log_config=None,
    )
