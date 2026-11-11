import json
import logging
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.types import ASGIApp, Message, Receive, Scope, Send

import media_store
import oss_store
from auth import require_auth
from auth import router as auth_router
from config import Settings, settings
from library import Library
from logs import describe_error, setup_logging
from routes.files import router as files_router
from routes.media import router as media_router
from routes.notes import notes_prefix
from routes.notes import router as notes_router
from routes.upload import router as upload_router

PORT = settings.port
# A 1 MiB text value can require 6 MiB when every character is JSON \uXXXX escaped.
MAX_TEXT_JSON_BODY_SIZE = 7 * 1024 * 1024
_TEXT_JSON_ROUTES = {
    ("POST", "/api/files/create"),
    ("PUT", "/api/files/edit"),
}
# Small JSON bodies are capped before routing; uploads and text files have their own limits.
MAX_SMALL_BODY_SIZE = 4096
_SMALL_BODY_ROUTES = {
    ("POST", "/api/auth/login"),
    ("PUT", "/api/tracks/meta"),
}
_WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

setup_logging(settings)
log = logging.getLogger("app")
router = APIRouter()
# Shared configuration needs a login like every other data route.
config_router = APIRouter()


@asynccontextmanager
async def lifespan(application: FastAPI):
    configured = application.state.settings
    endpoint_host = urlsplit(
        configured.oss_endpoint if "://" in configured.oss_endpoint else f"https://{configured.oss_endpoint}"
    ).hostname
    log.info(
        "Cloud OSS AI starting oss_ready=%s endpoint=%s bucket=%s drive=%s notes=%s media=%s "
        "library=%s port=%s",
        not configured.oss_missing,
        endpoint_host or "-",
        configured.oss_bucket or "-",
        configured.oss_prefix or "/",
        notes_prefix(configured) or "/",
        configured.media_oss_prefix or "/",
        configured.library_path,
        configured.port,
    )
    if configured.oss_missing:
        log.warning("OSS configuration incomplete; missing: %s", ", ".join(configured.oss_missing))
    if not configured.auth_configured:
        log.error("登录凭据未配置完整，缺少：%s；所有数据接口将返回 503", ", ".join(configured.auth_missing))
    yield
    log.info("Cloud OSS AI stopped")


class TextJsonBodyLimitMiddleware:
    def __init__(self, app: ASGIApp, max_body_size: int):
        self.app = app
        self.max_body_size = max_body_size

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or (scope["method"], scope["path"]) not in _TEXT_JSON_ROUTES:
            await self.app(scope, receive, send)
            return

        content_length = next(
            (value for name, value in scope["headers"] if name.lower() == b"content-length"),
            None,
        )
        if content_length is not None:
            try:
                declared_size = int(content_length)
            except ValueError:
                declared_size = 0
            if declared_size > self.max_body_size:
                await self._reject(scope, receive, send)
                return

        received = 0
        messages: list[Message] = []
        while True:
            message = await receive()
            messages.append(message)
            if message["type"] != "http.request":
                break
            received += len(message.get("body", b""))
            if received > self.max_body_size:
                await self._reject(scope, receive, send)
                return
            if not message.get("more_body", False):
                break

        message_index = 0

        async def replay_receive() -> Message:
            nonlocal message_index
            if message_index < len(messages):
                message = messages[message_index]
                message_index += 1
                return message
            return {"type": "http.request", "body": b"", "more_body": False}

        await self.app(scope, replay_receive, send)

    @staticmethod
    async def _reject(scope: Scope, receive: Receive, send: Send) -> None:
        response = JSONResponse(
            {"detail": "Request body exceeds the 7 MiB limit."},
            status_code=413,
        )
        await response(scope, receive, send)


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
    if request.method in _WRITE_METHODS:
        # Plain HTML forms cannot set custom headers, so every write must come from the app's own client.
        if request.headers.get("x-app-client") != "web":
            log.warning("拒绝缺少客户端标识的请求 %s %s", request.method, request.url.path)
            return JSONResponse({"detail": "缺少同源请求标识。"}, status_code=403)
        if (request.method, request.url.path) in _SMALL_BODY_ROUTES:
            size = request.headers.get("content-length", "0")
            if not size.isascii() or not size.isdigit() or len(size) > 10 or int(size) > MAX_SMALL_BODY_SIZE:
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
    allow_same_origin_frame = request.url.path == "/api/files/download"
    # Native clients embed PDF previews from their own origin; WebKit lets frame-ancestors override XFO.
    frame_ancestors = (
        " ".join(["'self'", *request.app.state.settings.cors_origins])
        if allow_same_origin_frame
        else "'none'"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN" if allow_same_origin_frame else "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; "
        f"connect-src 'self'; frame-ancestors {frame_ancestors}; base-uri 'none'; form-action 'self'"
    )
    if response.status_code >= 400:
        response.headers["Cache-Control"] = "no-store"
    else:
        response.headers.setdefault("Cache-Control", "no-store")
    return response


async def conflict_error(request: Request, exc: oss_store.ConflictError):
    log.info("Request conflict method=%s path=%s error=%s", request.method, request.url.path, exc)
    return JSONResponse({"detail": str(exc)}, status_code=409)


async def not_found_error(request: Request, exc: oss_store.NotFoundError):
    log.info("Object not found method=%s path=%s error=%s", request.method, request.url.path, exc)
    return JSONResponse({"detail": str(exc)}, status_code=404)


async def precondition_failed_error(request: Request, exc: oss_store.PreconditionFailedError):
    log.info("Precondition failed method=%s path=%s error=%s", request.method, request.url.path, exc)
    return JSONResponse(
        {"detail": str(exc), "current_etag": exc.current_etag},
        status_code=412,
    )


async def too_large_error(request: Request, exc: oss_store.TooLargeError):
    log.info("Request too large method=%s path=%s error=%s", request.method, request.url.path, exc)
    return JSONResponse({"detail": str(exc)}, status_code=413)


async def user_error(request: Request, exc: oss_store.UserError):
    log.info("Request rejected method=%s path=%s error=%s", request.method, request.url.path, exc)
    return JSONResponse({"detail": str(exc)}, status_code=400)


async def invalid_request(request: Request, exc: RequestValidationError | ValidationError):
    errors = exc.errors()
    fields = sorted({".".join(str(part) for part in error.get("loc", ())) for error in errors})
    log.info(
        "Request validation failed method=%s path=%s fields=%s",
        request.method,
        request.url.path,
        ",".join(fields) or "-",
    )
    unicode_detail = _invalid_json_unicode_detail(request, exc, errors)
    if unicode_detail is not None:
        return JSONResponse({"detail": unicode_detail}, status_code=400)
    return JSONResponse({"detail": "Invalid request parameters."}, status_code=422)


def _invalid_json_unicode_detail(request: Request, exc, errors: list[dict]) -> str | None:
    if (request.method, request.url.path) not in _TEXT_JSON_ROUTES:
        return None
    if not any(error.get("type") in {"json_invalid", "string_unicode"} for error in errors):
        return None
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        payload = body
    elif isinstance(body, bytes):
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
    else:
        return None
    if not isinstance(payload, dict):
        return None
    for field in ("content", "name", "key"):
        value = payload.get(field)
        if not isinstance(value, str):
            continue
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            if field == "content":
                return "File content is not valid UTF-8."
            return "Invalid file name or OSS object key."
    return None


async def internal_error(request: Request, exc: Exception):
    log.exception(
        "Unhandled request error method=%s path=%s error=%s",
        request.method,
        request.url.path,
        describe_error(exc),
    )
    return JSONResponse({"detail": "Internal server error. Check the service log."}, status_code=500)


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


@config_router.get("/api/config")
def config_status(request: Request):
    configured = request.app.state.settings
    return {
        "bucket": configured.oss_bucket,
        "oss_ready": not configured.oss_missing,
        "oss_missing": configured.oss_missing,
        "drive_prefix": oss_store.object_prefix(configured),
        "note_prefix": notes_prefix(configured),
        "media_prefix": media_store.media_prefix(configured),
    }


def create_app(app_settings: Settings | None = None, library_store: Library | None = None) -> FastAPI:
    configured = app_settings if app_settings is not None else settings
    application = FastAPI(
        title="Cloud OSS AI",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        redirect_slashes=False,
    )
    application.state.settings = configured
    application.state.upload_sizes = {}
    application.state.library = (
        library_store if library_store is not None else Library(configured.library_path)
    )
    application.state.frontend_assets = StaticFiles(
        directory=configured.frontend_path / "assets",
        check_dir=False,
    )
    protected = [Depends(require_auth)]
    application.include_router(router)
    application.include_router(auth_router)
    application.include_router(config_router, dependencies=protected)
    application.include_router(files_router, dependencies=protected)
    application.include_router(notes_router, dependencies=protected)
    application.include_router(upload_router, dependencies=protected)
    application.include_router(media_router, dependencies=protected)
    application.add_exception_handler(oss_store.ConflictError, conflict_error)
    application.add_exception_handler(oss_store.NotFoundError, not_found_error)
    application.add_exception_handler(oss_store.PreconditionFailedError, precondition_failed_error)
    application.add_exception_handler(oss_store.TooLargeError, too_large_error)
    application.add_exception_handler(oss_store.UserError, user_error)
    application.add_exception_handler(RequestValidationError, invalid_request)
    application.add_exception_handler(ValidationError, invalid_request)
    application.add_exception_handler(Exception, internal_error)

    # Last added runs first: security headers -> Host -> CORS -> request guard -> text body limit.
    # Invalid Hosts cannot bypass validation via preflight; valid preflights do
    # not require the write marker, while guard errors still receive CORS headers.
    application.add_middleware(TextJsonBodyLimitMiddleware, max_body_size=MAX_TEXT_JSON_BODY_SIZE)
    application.middleware("http")(local_guard)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=configured.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Range", "X-App-Client"],
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
