import ipaddress
import re
import socket
from urllib.parse import urlsplit, urlunsplit


class UserError(ValueError):
    pass


def validate_public_url(url: str) -> str:
    url = url.strip()
    if len(url) > 8192 or any(ord(c) < 32 for c in url) or "\\" in url:
        raise UserError("链接格式不合法。")
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        raise UserError("链接格式不合法。") from None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise UserError("只支持 HTTP 或 HTTPS 链接。")
    if parsed.username is not None or parsed.password is not None:
        raise UserError("不接受带用户名或密码的链接。")
    if port not in {None, 80, 443}:
        raise UserError("仅支持使用标准 HTTP/HTTPS 端口的公开链接。")
    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal")):
        raise UserError("不允许访问本机、内网或云元数据地址。")
    try:
        addresses = socket.getaddrinfo(
            hostname, port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM
        )
    except (socket.gaierror, UnicodeError):
        raise UserError("无法解析该域名，请检查链接和网络。") from None
    if not addresses:
        raise UserError("无法解析该域名。")
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        mapped = getattr(ip, "ipv4_mapped", None)
        if not ip.is_global or ip.is_multicast or (mapped and (not mapped.is_global or mapped.is_multicast)):
            raise UserError("不允许访问本机、内网或云元数据地址。")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", parsed.query, ""))


def safe_error(exc: Exception) -> str:
    if isinstance(exc, UserError):
        return str(exc)
    message = re.sub(r"https?://\S+", "[链接]", str(exc).lower())
    patterns = [
        (("drm",), "该媒体受 DRM 保护，工具不支持下载。"),
        (
            ("sign in", "login", "cookie", "bot", "private video"),
            "站点要求登录或验证，无法下载；工具不会自动读取浏览器 Cookie。",
        ),
        (("geo", "country", "region"), "该媒体存在地区访问限制。"),
        (
            ("403", "accessdenied", "invalidaccesskey", "signaturedoesnotmatch"),
            "访问被拒绝，请检查来源权限或 OSS 凭据及 RAM 授权。",
        ),
        (("404", "not found", "nosuchbucket"), "资源或 OSS Bucket 不存在。"),
        (
            ("video is unavailable", "video unavailable", "has been removed"),
            "该视频已不可用或已被移除，请更换链接。",
        ),
        (("timeout", "timed out"), "请求超时，请检查网络后重试。"),
        (("ffmpeg", "ffprobe"), "FFmpeg 处理失败或未安装，请检查媒体格式及依赖。"),
        (
            ("unsupported url", "no video formats", "no formats", "requested format"),
            "未发现支持的媒体格式，请尝试直接媒体链接。",
        ),
        (("too large", "max_filesize", "filesize", "file size"), "媒体超过配置的大小限制。"),
        (("certificate", "ssl"), "HTTPS 证书验证失败，请检查网络及证书配置。"),
    ]
    for needles, result in patterns:
        if any(needle in message for needle in needles):
            return result
    return "处理失败，请检查链接、网络及本地配置后重试。"


def safe_label(text: str, limit: int = 200) -> str:
    text = re.sub(r"https?://\S+", "[链接]", text)
    text = re.sub(r"[\x00-\x1f\x7f]", " ", text)
    return text[:limit]
