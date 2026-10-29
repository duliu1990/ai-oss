import re


class UserError(ValueError):
    pass


def safe_error(exc: Exception) -> str:
    """Map raw SDK/network errors to a short message that never contains URLs or credentials."""
    if isinstance(exc, UserError):
        return str(exc)
    message = re.sub(r"https?://\S+", "[链接]", str(exc).lower())
    patterns = [
        (
            ("403", "accessdenied", "invalidaccesskey", "signaturedoesnotmatch", "securitytoken"),
            "访问被拒绝，请检查 OSS 凭据及 RAM 授权（需要 oss:GetObject 与 oss:ListObjects）。",
        ),
        (("nosuchkey",), "OSS 中已找不到该文件，请刷新列表。"),
        (("404", "not found", "nosuchbucket"), "OSS Bucket 或文件不存在，请检查配置。"),
        (("timeout", "timed out"), "请求 OSS 超时，请检查网络后重试。"),
        (("certificate", "ssl"), "HTTPS 证书验证失败，请检查网络及证书配置。"),
        (("connection", "resolve", "network"), "无法连接 OSS，请检查网络及 Endpoint。"),
    ]
    for needles, result in patterns:
        if any(needle in message for needle in needles):
            return result
    return "OSS 请求失败，请查看服务日志。"
