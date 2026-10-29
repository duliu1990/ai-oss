import ipaddress
import socket
from unittest.mock import Mock

import pytest

from security import UserError, safe_error, safe_label, validate_public_url


@pytest.fixture(autouse=True)
def block_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Tests must not use real DNS or network connections")

    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)


@pytest.fixture
def dns(monkeypatch):
    def install(*addresses):
        records = [
            (
                socket.AF_INET6 if ipaddress.ip_address(address).version == 6 else socket.AF_INET,
                socket.SOCK_STREAM,
                socket.IPPROTO_TCP,
                "",
                (address, 443),
            )
            for address in addresses
        ]
        resolver = Mock(return_value=records)
        monkeypatch.setattr(socket, "getaddrinfo", resolver)
        return resolver

    return install


@pytest.mark.parametrize(
    ("url", "expected", "host", "port"),
    [
        (" https://media.example ", "https://media.example/", "media.example", 443),
        ("http://media.example/watch#section", "http://media.example/watch", "media.example", 80),
        (
            "https://media.example:443/file.mp3?token=dummy#fragment",
            "https://media.example:443/file.mp3?token=dummy",
            "media.example",
            443,
        ),
        ("http://media.example:80/", "http://media.example:80/", "media.example", 80),
        ("https://MEDIA.example./", "https://MEDIA.example./", "media.example", 443),
    ],
)
def test_public_url_normalization(url, expected, host, port, dns):
    resolver = dns("93.184.216.34")
    assert validate_public_url(url) == expected
    resolver.assert_called_once_with(host, port, type=socket.SOCK_STREAM)


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.2",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "192.0.2.1",
        "224.0.0.1",
        "ff02::1",
        "::ffff:224.0.0.1",
        "::1",
        "::",
        "fc00::1",
        "fe80::1",
        "2001:db8::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "::ffff:169.254.169.254",
    ],
)
def test_rejects_nonpublic_literal_and_dns_addresses(address, dns):
    dns(address)
    host = f"[{address}]" if ":" in address else address
    for url in (f"https://{host}/secret", "https://media.example/secret"):
        with pytest.raises(UserError, match="内网|元数据"):
            validate_public_url(url)


@pytest.mark.parametrize(
    "addresses",
    [
        ("93.184.216.34", "10.0.0.1"),
        ("10.0.0.1", "93.184.216.34"),
        ("2606:4700:4700::1111", "::1"),
        ("93.184.216.34", "::ffff:192.168.1.1"),
    ],
)
def test_rejects_mixed_public_private_dns(addresses, dns):
    dns(*addresses)
    with pytest.raises(UserError, match="内网|元数据"):
        validate_public_url("https://mixed.example/media")


@pytest.mark.parametrize("address", ["2606:4700:4700::1111", "::ffff:93.184.216.34"])
def test_accepts_public_ipv6_and_public_ipv4_mapped_addresses(address, dns):
    dns(address)
    url = f"https://[{address}]/media"
    assert validate_public_url(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "https://localhost/",
        "http://LOCALHOST./",
        "https://a.localhost/",
        "http://service.local/",
        "http://metadata.internal/",
        "ftp://media.example/a.mp3",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:audio/mp3;base64,AA==",
        "//media.example/a.mp3",
        "media.example",
        "https:///missing-host",
        "",
        "https://user:dummy-password@media.example/",
        "https://user@media.example/",
        "https://@media.example/",
        "https://media.example:8080/",
        "https://media.example:0/",
        "https://media.example:65536/",
        "https://media.example:invalid/",
        "https://[broken/",
        "https://media.example/a\nb",
        "https://media.example/a\x00b",
        "https://media.example/a\\b",
        "https://media.example/" + "a" * 8192,
    ],
)
def test_rejects_invalid_urls_without_dns(url):
    with pytest.raises(UserError):
        validate_public_url(url)


@pytest.mark.parametrize("failure", [socket.gaierror("dummy resolver detail"), UnicodeError("dummy secret")])
def test_dns_errors_are_user_friendly_and_do_not_expose_details(monkeypatch, failure):
    monkeypatch.setattr(socket, "getaddrinfo", Mock(side_effect=failure))
    with pytest.raises(UserError, match="解析") as error:
        validate_public_url("https://media.example/")
    assert "dummy" not in str(error.value)


def test_empty_dns_answer_is_rejected(dns):
    dns()
    with pytest.raises(UserError, match="解析"):
        validate_public_url("https://media.example/")


def test_safe_label_redacts_urls_and_controls_and_limits_length():
    label = safe_label("track\nhttps://media.example/a?token=dummy-secret next\x00\x7f http://other.example/")
    assert label == "track [链接] next   [链接]"
    assert "dummy-secret" not in label
    assert len(safe_label("a" * 250)) == 200
    assert safe_label("abcdef", limit=3) == "abc"


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("DRM protected", "DRM"),
        ("login required", "登录"),
        ("geo restricted", "地区"),
        ("403 InvalidAccessKeyId", "凭据"),
        ("SignatureDoesNotMatch", "凭据"),
        ("404 NoSuchBucket", "不存在"),
        ("This video is unavailable", "不可用"),
        ("request timed out", "超时"),
        ("ffprobe failed", "FFmpeg"),
        ("unsupported URL", "媒体格式"),
        ("max_filesize exceeded", "大小限制"),
        ("SSL certificate failed", "证书"),
        ("unexpected backend error", "处理失败"),
    ],
)
def test_safe_error_never_echoes_backend_secrets(message, expected):
    detail = (
        f"{message}; Authorization=Bearer dummy-api-key; AccessKeySecret=dummy-oss-secret; "
        "https://media.example/a?Signature=dummy-signature"
    )
    result = safe_error(RuntimeError(detail))
    assert expected in result
    for secret in ("dummy-api-key", "dummy-oss-secret", "dummy-signature", "https://", "Authorization"):
        assert secret not in result


def test_safe_error_preserves_intentional_user_error():
    assert safe_error(UserError("请选择媒体。")) == "请选择媒体。"


def test_url_tokens_do_not_determine_error_category():
    error = RuntimeError("Unsupported URL: https://gateway.example/?token=drm-cookie-country")
    message = safe_error(error)
    assert "媒体格式" in message
    assert "DRM" not in message and "登录" not in message
