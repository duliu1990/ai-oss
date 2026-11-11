"""认证路由与鉴权依赖。"""

from __future__ import annotations

import hmac
import logging
import time
from typing import Any

import bcrypt
import jwt
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# --- 简单登录限流 ---
_fail_window: list[float] = []
_MAX_FAILS = 5
_WINDOW_SECONDS = 300  # 5 分钟


class LoginRequest(BaseModel):
    """登录请求体。"""

    username: str = Field(..., min_length=1, max_length=100)
    password: str = Field(..., min_length=1, max_length=200)


class LoginResponse(BaseModel):
    """登录成功响应。"""

    token: str
    expires_in: int


def _check_rate_limit() -> None:
    """检查登录失败限流。"""
    now = time.monotonic()
    # 清理过期记录
    while _fail_window and _fail_window[0] < now - _WINDOW_SECONDS:
        _fail_window.pop(0)
    if len(_fail_window) >= _MAX_FAILS:
        raise HTTPException(status_code=429, detail="登录尝试过于频繁，请稍后再试")


def _record_failure() -> None:
    """记录一次登录失败。"""
    _fail_window.append(time.monotonic())


def _create_token(username: str, secret: str, expire_minutes: int) -> tuple[str, int]:
    """创建 JWT Token，返回 (token, expires_in_seconds)。"""
    expires_in = expire_minutes * 60
    payload: dict[str, Any] = {
        "sub": username,
        "iat": int(time.time()),
        "exp": int(time.time()) + expires_in,
    }
    token = jwt.encode(payload, secret, algorithm="HS256")
    return token, expires_in


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest, request: Request) -> LoginResponse:
    """用户登录，返回 JWT Token。"""
    settings = request.app.state.settings

    if not settings.auth_configured:
        raise HTTPException(status_code=503, detail="认证未配置")

    _check_rate_limit()

    # 验证用户名（constant-time 比较）
    username_ok = hmac.compare_digest(body.username, settings.auth_username)

    # 验证密码（bcrypt 自带 constant-time）
    password_ok = bcrypt.checkpw(
        body.password.encode("utf-8"),
        settings.auth_password_hash.get_secret_value().encode("utf-8"),
    )

    if not (username_ok and password_ok):
        _record_failure()
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    token, expires_in = _create_token(
        settings.auth_username,
        settings.jwt_secret_key.get_secret_value(),
        settings.jwt_expire_minutes,
    )
    return LoginResponse(token=token, expires_in=expires_in)


async def require_auth(request: Request) -> None:
    """FastAPI 依赖：验证 JWT Token。未配置认证时直接放行。"""
    settings = request.app.state.settings

    if not settings.auth_configured:
        return  # 开发模式，跳过认证

    token: str | None = None

    # 1. 优先从 Authorization header 获取
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]

    # 2. 其次从查询参数获取（下载场景）
    if not token:
        token = request.query_params.get("token")

    if not token:
        raise HTTPException(status_code=401, detail="未授权")

    try:
        jwt.decode(
            token,
            settings.jwt_secret_key.get_secret_value(),
            algorithms=["HS256"],
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="无效的认证令牌")
