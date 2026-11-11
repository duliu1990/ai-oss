"""登录接口与鉴权依赖：固定账号 + 无状态 JWT，不依赖数据库。"""

import hmac
import logging
import time

import bcrypt
import jwt
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

log = logging.getLogger("auth")

router = APIRouter(prefix="/api/auth", tags=["auth"])

# 登录失败限流：同一进程内 5 分钟累计 5 次失败后拒绝继续尝试。
_fail_window: list[float] = []
_MAX_FAILS = 5
_WINDOW_SECONDS = 300


class LoginInput(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=200)


class LoginResult(BaseModel):
    token: str
    expires_in: int


class AuthStatus(BaseModel):
    auth_required: bool
    auth_ready: bool


def reset_rate_limit() -> None:
    """清空限流窗口，供测试隔离使用。"""
    _fail_window.clear()


def _check_rate_limit() -> None:
    now = time.monotonic()
    while _fail_window and _fail_window[0] < now - _WINDOW_SECONDS:
        _fail_window.pop(0)
    if len(_fail_window) >= _MAX_FAILS:
        raise HTTPException(status_code=429, detail="登录尝试过于频繁，请稍后再试。")


def _issue_token(username: str, secret: str, expire_minutes: int) -> LoginResult:
    expires_in = expire_minutes * 60
    issued = int(time.time())
    payload = {"sub": username, "iat": issued, "exp": issued + expires_in}
    return LoginResult(token=jwt.encode(payload, secret, algorithm="HS256"), expires_in=expires_in)


@router.get("/status", response_model=AuthStatus)
def auth_status(request: Request) -> AuthStatus:
    """公开接口：客户端据此判断该服务地址是否可以登录。"""
    # Login is mandatory for this service; only readiness varies with configuration.
    return AuthStatus(auth_required=True, auth_ready=request.app.state.settings.auth_configured)


@router.post("/login", response_model=LoginResult)
def login(data: LoginInput, request: Request) -> LoginResult:
    settings = request.app.state.settings
    if not settings.auth_configured:
        log.error("登录被拒绝：缺少 %s", ", ".join(settings.auth_missing))
        raise HTTPException(status_code=503, detail="服务尚未配置登录凭据，请联系服务维护者。")

    _check_rate_limit()
    # Compare both factors before answering so a wrong username costs the same work.
    username_ok = hmac.compare_digest(data.username, settings.auth_username)
    password_ok = bcrypt.checkpw(
        data.password.encode("utf-8"),
        settings.auth_password_hash.get_secret_value().encode("utf-8"),
    )
    if not (username_ok and password_ok):
        _fail_window.append(time.monotonic())
        log.warning("登录失败 username=%s", data.username[:32])
        raise HTTPException(status_code=401, detail="用户名或密码错误。")

    log.info("登录成功 username=%s", settings.auth_username)
    return _issue_token(
        settings.auth_username,
        settings.jwt_secret_key.get_secret_value(),
        settings.jwt_expire_minutes,
    )


def require_auth(request: Request) -> None:
    """FastAPI 依赖：校验 JWT。凭据未配置时整体拒绝访问，不会放行。"""
    settings = request.app.state.settings
    if not settings.auth_configured:
        log.error("拒绝访问 %s：缺少 %s", request.url.path, ", ".join(settings.auth_missing))
        raise HTTPException(status_code=503, detail="服务尚未配置登录凭据，请联系服务维护者。")

    header = request.headers.get("authorization", "")
    token = header[7:] if header.startswith("Bearer ") else ""
    # <audio> 与原生媒体播放无法设置请求头，流式接口只能靠查询参数携带令牌。
    if not token:
        token = request.query_params.get("token", "")
    if not token:
        raise HTTPException(status_code=401, detail="请先登录。")

    try:
        jwt.decode(token, settings.jwt_secret_key.get_secret_value(), algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录。") from None
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="登录凭证无效，请重新登录。") from None
