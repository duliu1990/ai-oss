import json
import logging
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from starlette.types import ASGIApp, Message, Receive, Scope, Send

import oss_store
from config import Settings, settings
from routes.auth import require_auth
from routes.auth import router as auth_router
from routes.files import router as files_router
from routes.notes import router as notes_router
from routes.upload import router as upload_router

PORT = settings.port
# A 1 MiB text value can require 6 MiB when every character is JSON \uXXXX escaped.
MAX_TEXT_JSON_BODY_SIZE = 7 * 1024 * 1024
_TEXT_JSON_ROUTES = {
    ("POST", "/api/files/create"),
    ("PUT", "/api/files/edit"),
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("app")
router = APIRouter()


@asynccontextmanager
async def lifespan(application: FastAPI):
    configured = application.state.settings
    endpoint_host = urlsplit(
        configured.oss_endpoint if "://" in configured.oss_endpoint else f"https://{configured.oss_endpoint}"
    ).hostname
    log.info(
        "Driver OSS starting oss_ready=%s endpoint=%s bucket=%s prefix=%s port=%s",
        not configured.oss_missing,
        endpoint_host or "-",
        configured.oss_bucket or "-",
        configured.oss_prefix or "/",
        configured.port,
    )
    if configured.oss_missing:
        log.warning("OSS configuration incomplete; missing: %s", ", ".join(configured.oss_missing))
    yield
    log.info("Driver OSS stopped")


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


async def request_boundary(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception as exc:
        return await internal_error(request, exc)


async def security_headers(request: Request, call_next):
    response = await call_next(request)
    allow_same_origin_frame = request.url.path == "/api/files/download"
    frame_ancestors = "'self'" if allow_same_origin_frame else "'none'"
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
        "Unhandled request error method=%s path=%s type=%s",
        request.method,
        request.url.path,
        type(exc).__name__,
    )
    return JSONResponse({"detail": "Internal server error. Check the service log."}, status_code=500)


@router.api_route("/", methods=["GET", "HEAD"])
def index(request: Request):
    index_path = request.app.state.settings.frontend_path / "index.html"
    if not index_path.is_file():
        return JSONResponse(
            {"detail": "Frontend build missing. Build frontend/dist first."},
            status_code=503,
        )
    return FileResponse(index_path, media_type="text/html", headers={"Cache-Control": "no-store"})


@router.api_route("/assets/{path:path}", methods=["GET", "HEAD"])
async def frontend_asset(request: Request, path: str):
    response = await request.app.state.frontend_assets.get_response(path, request.scope)
    if response.status_code in {200, 206, 304}:
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


@router.get("/api/config")
def config_status(request: Request):
    configured = request.app.state.settings
    return {
        "bucket": configured.oss_bucket,
        "prefix": oss_store.object_prefix(configured),
        "port": configured.port,
    }


@router.get("/healthz")
def health():
    return {"status": "ok"}


def create_app(app_settings: Settings | None = None) -> FastAPI:
    configured = app_settings if app_settings is not None else settings
    application = FastAPI(
        title="Driver OSS",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        redirect_slashes=False,
    )
    application.state.settings = configured
    application.state.upload_sizes = {}
    application.state.frontend_assets = StaticFiles(
        directory=configured.frontend_path / "assets",
        check_dir=False,
    )
    application.include_router(router)
    application.include_router(auth_router)
    application.include_router(files_router, dependencies=[Depends(require_auth)])
    application.include_router(notes_router, dependencies=[Depends(require_auth)])
    application.include_router(upload_router, dependencies=[Depends(require_auth)])
    application.add_exception_handler(oss_store.ConflictError, conflict_error)
    application.add_exception_handler(oss_store.NotFoundError, not_found_error)
    application.add_exception_handler(oss_store.PreconditionFailedError, precondition_failed_error)
    application.add_exception_handler(oss_store.TooLargeError, too_large_error)
    application.add_exception_handler(oss_store.UserError, user_error)
    application.add_exception_handler(RequestValidationError, invalid_request)
    application.add_exception_handler(ValidationError, invalid_request)
    application.add_exception_handler(Exception, internal_error)

    application.add_middleware(TextJsonBodyLimitMiddleware, max_body_size=MAX_TEXT_JSON_BODY_SIZE)
    # The last middleware added runs first: security headers wrap the request boundary.
    application.middleware("http")(request_boundary)
    application.middleware("http")(security_headers)
    return application


app = create_app()


if __name__ == "__main__":
    import truststore
    import uvicorn

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
