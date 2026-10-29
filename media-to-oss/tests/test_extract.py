import importlib
import ipaddress
import json
import os
import socket
from unittest.mock import MagicMock, Mock

import httpx
import pytest
from pydantic_settings import BaseSettings

from security import UserError


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    monkeypatch.setattr(os, "environ", {})
    original_init = BaseSettings.__init__

    def init_without_dotenv(self, **kwargs):
        kwargs["_env_file"] = None
        original_init(self, **kwargs)

    monkeypatch.setattr(BaseSettings, "__init__", init_without_dotenv)

    def resolve(host, port, **kwargs):
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = ipaddress.ip_address("93.184.216.34")
        family = socket.AF_INET6 if address.version == 6 else socket.AF_INET
        return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (str(address), port))]

    def forbidden(*args, **kwargs):
        raise AssertionError("Tests must not use real network connections or yt-dlp")

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    module = importlib.import_module("extract")
    monkeypatch.setattr(module.yt_dlp, "YoutubeDL", Mock(side_effect=forbidden))


@pytest.fixture
def extract_module():
    return importlib.import_module("extract")


@pytest.fixture
def settings(extract_module):
    return extract_module.Settings(_env_file=None)


@pytest.fixture
def page_response(monkeypatch, extract_module):
    real_client = httpx.Client

    def install(handler):
        requests = []

        def respond(request):
            requests.append(request)
            return handler(request)

        client = Mock(
            side_effect=lambda **kwargs: real_client(transport=httpx.MockTransport(respond), **kwargs)
        )
        monkeypatch.setattr(extract_module.httpx, "Client", client)
        monkeypatch.setattr(extract_module, "is_specialized", lambda url: False)
        return requests, client

    return install


@pytest.fixture
def ytdlp(monkeypatch, extract_module):
    def install(info=None, error=None):
        session = MagicMock()
        session.extract_info.return_value = info
        session.extract_info.side_effect = error
        context = MagicMock()
        context.__enter__.return_value = session
        factory = Mock(return_value=context)
        monkeypatch.setattr(extract_module.yt_dlp, "YoutubeDL", factory)
        monkeypatch.setattr(extract_module, "is_specialized", lambda url: True)
        return session, factory

    return install


def test_audio_video_and_nested_sources_exclude_picture_sources(extract_module):
    body = b"""
        <title>Example media</title>
        <audio src="audio.mp3" title="Main audio"><source src="/audio-alt" type="audio/ogg"></audio>
        <video src="/video.mp4"><source src="/video-alt" type="video/webm"></video>
        <picture><source src="/not-audio.mp3" type="image/avif"></picture>
        <source src="/orphan.mp3"><img src="/poster.mp4">
    """
    title, candidates = extract_module.html_candidates("https://page.example/articles/one", body)
    assert title == "Example media"
    assert [(c["url"], c["kind"]) for c in candidates] == [
        ("https://page.example/articles/audio.mp3", "audio"),
        ("https://page.example/audio-alt", "audio"),
        ("https://page.example/video.mp4", "video"),
        ("https://page.example/video-alt", "video"),
    ]
    assert [c["id"] for c in candidates] == ["1", "2", "3", "4"]
    assert candidates[0]["title"] == "Main audio"


@pytest.mark.parametrize(
    ("property_name", "kind"),
    [
        ("og:audio", "audio"),
        ("og:audio:url", "audio"),
        ("og:audio:secure_url", "audio"),
        ("og:video", "video"),
        ("og:video:url", "video"),
        ("og:video:secure_url", "video"),
        ("twitter:player:stream", "video"),
    ],
)
def test_metadata_candidates(extract_module, property_name, kind):
    attr = "name" if property_name.startswith("twitter:") else "property"
    body = f'<title>Metadata title</title><meta {attr}="{property_name}" content="/stream">'.encode()
    _, candidates = extract_module.html_candidates("https://page.example/", body)
    assert candidates == [
        {"id": "1", "title": "Metadata title", "kind": kind, "url": "https://page.example/stream"}
    ]


def test_jsonld_graph_and_media_links(extract_module):
    graph = {
        "@graph": [
            {"@type": ["Thing", "AudioObject"], "name": "JSON audio", "contentUrl": "/audio-stream"},
            {
                "nested": {
                    "@type": "VideoObject",
                    "name": "JSON video",
                    "contentUrl": "//cdn.example/video-stream",
                }
            },
            {"@type": "ImageObject", "contentUrl": "/picture.mp4"},
        ]
    }
    body = (
        '<a href="/track.MP3?token=dummy#player">Linked audio</a>'
        '<a href="movie.webm">Linked video</a><a href="/manifest.m3u8">Playlist stream</a>'
        '<a href="/page">Not media</a><script type="application/ld+json">invalid JSON</script>'
        f'<script type="application/ld+json">{json.dumps(graph)}</script>'
    ).encode()
    _, candidates = extract_module.html_candidates("https://page.example/articles/", body)
    assert [(c["title"], c["kind"]) for c in candidates] == [
        ("Linked audio", "audio"),
        ("Linked video", "video"),
        ("Playlist stream", "unknown"),
        ("JSON audio", "audio"),
        ("JSON video", "video"),
    ]
    assert candidates[0]["url"] == "https://page.example/track.MP3?token=dummy"
    assert candidates[1]["url"] == "https://page.example/articles/movie.webm"
    assert candidates[-1]["url"] == "https://cdn.example/video-stream"


def test_duplicates_and_private_candidates_are_removed(extract_module):
    body = b"""
        <audio src="/same.mp3"></audio><video src="https://page.example/same.mp3"></video>
        <meta property="og:audio" content="/same.mp3"><a href="/same.mp3">Duplicate</a>
        <audio src="http://127.0.0.1/private.mp3"></audio>
        <audio src="http://169.254.169.254/private.mp3"></audio>
        <video src="http://[::ffff:10.0.0.1]/private.mp4"></video>
        <audio src="http://localhost/private.mp3"></audio><audio src="file:///private.mp3"></audio>
        <audio src="https://user:dummy@page.example/private.mp3"></audio>
        <audio src="https://page.example:8080/private.mp3"></audio><audio src="/other.mp3"></audio>
    """
    _, candidates = extract_module.html_candidates("https://page.example/", body)
    assert [c["url"] for c in candidates] == [
        "https://page.example/same.mp3",
        "https://page.example/other.mp3",
    ]
    assert [c["id"] for c in candidates] == ["1", "2"]


def test_deduplication_uses_validated_url_without_fragment(extract_module):
    body = b'<audio src="/same.mp3#one"></audio><audio src="/same.mp3#two"></audio>'
    _, candidates = extract_module.html_candidates("https://page.example/", body)
    assert [c["url"] for c in candidates] == ["https://page.example/same.mp3"]


def test_malformed_candidate_does_not_discard_valid_media(extract_module):
    body = b'<audio src="https://[broken/file.mp3"></audio><audio src="/valid.mp3"></audio>'
    _, candidates = extract_module.html_candidates("https://page.example/", body)
    assert [c["url"] for c in candidates] == ["https://page.example/valid.mp3"]


def test_candidate_limit_and_label_redaction(extract_module):
    body = (
        "<title>Page https://page.example/?secret=dummy-title</title>"
        + "".join(
            f'<audio src="/{i}.mp3" title="Track https://page.example/?token=dummy-token"></audio>'
            for i in range(50)
        )
    ).encode()
    title, candidates = extract_module.html_candidates("https://page.example/", body)
    assert title == "Page [链接]"
    assert len(candidates) == 40
    assert [c["id"] for c in candidates] == [str(i) for i in range(1, 41)]
    assert all(c["title"] == "Track [链接]" for c in candidates)


def test_redirects_are_validated_before_every_request(extract_module, page_response, monkeypatch):
    def respond(request):
        if request.url.path == "/start":
            return httpx.Response(302, headers={"location": "/second"})
        if request.url.path == "/second":
            return httpx.Response(307, headers={"location": "https://cdn.example/final"})
        return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, content=b"<p>ok</p>")

    requests, client = page_response(respond)
    original = extract_module.validate_public_url
    validated = []

    def validate(url):
        assert len(validated) == len(requests), "Each URL must be validated before issuing its request"
        validated.append(url)
        return original(url)

    monkeypatch.setattr(extract_module, "validate_public_url", validate)
    assert extract_module.fetch_page("https://page.example/start") == (
        "https://cdn.example/final",
        "text/html",
        b"<p>ok</p>",
    )
    assert validated == [
        "https://page.example/start",
        "https://page.example/second",
        "https://cdn.example/final",
    ]
    assert [str(request.url) for request in requests] == validated
    client.assert_called_once_with(timeout=20, follow_redirects=False, trust_env=False)


@pytest.mark.parametrize(
    "target", ["http://127.0.0.1/secret", "http://169.254.169.254/secret", "file:///secret"]
)
def test_redirect_to_private_or_invalid_url_is_never_requested(target, extract_module, page_response):
    requests, _ = page_response(lambda request: httpx.Response(302, headers={"location": target}))
    with pytest.raises(UserError):
        extract_module.fetch_page("https://page.example/start")
    assert len(requests) == 1


def test_redirect_limit(extract_module, page_response):
    requests, _ = page_response(lambda request: httpx.Response(302, headers={"location": "/again"}))
    with pytest.raises(UserError, match="重定向次数"):
        extract_module.fetch_page("https://page.example/start")
    assert len(requests) == 6


@pytest.mark.parametrize("body", [b"<html><p>No media</p></html>", b""])
def test_page_without_media_is_an_error(body, extract_module, settings, page_response):
    page_response(lambda request: httpx.Response(200, headers={"content-type": "text/html"}, content=body))
    with pytest.raises(UserError, match="没有发现|未发现"):
        extract_module.analyze("https://page.example/", settings)


@pytest.mark.parametrize(
    ("path", "content_type", "kind"),
    [
        ("/track.mp3", "audio/mpeg", "audio"),
        ("/movie.mp4", "video/mp4", "video"),
        ("/audio-stream", "audio/mpeg", "audio"),
        ("/video-stream", "video/mp4", "video"),
        ("/track.mp3", "application/octet-stream", "audio"),
        ("/manifest.m3u8", "application/vnd.apple.mpegurl", "unknown"),
    ],
)
def test_direct_media_response(
    path, content_type, kind, extract_module, settings, page_response, monkeypatch
):
    page_response(
        lambda request: httpx.Response(200, headers={"content-type": content_type}, content=b"media")
    )
    rank = Mock(side_effect=AssertionError("Direct media must not invoke AI"))
    monkeypatch.setattr(extract_module, "rank_candidates", rank)
    result = extract_module.analyze("https://cdn.example" + path, settings)
    assert result["source"] == "媒体直链"
    assert result["candidates"] == [
        {"id": "1", "title": path[1:], "kind": kind, "url": "https://cdn.example" + path}
    ]
    assert result["ai_used"] is False and result["warning"] is None
    rank.assert_not_called()


def test_page_size_limit_and_unsupported_content_type(extract_module, page_response):
    page_response(
        lambda request: httpx.Response(
            200, headers={"content-type": "text/html"}, content=b"x" * (2 * 1024 * 1024 + 1)
        )
    )
    with pytest.raises(UserError, match="2 MB"):
        extract_module.fetch_page("https://page.example/")
    page_response(
        lambda request: httpx.Response(200, headers={"content-type": "image/png"}, content=b"image")
    )
    with pytest.raises(UserError, match="支持"):
        extract_module.fetch_page("https://page.example/")


@pytest.mark.parametrize("ai_used", [False, True])
def test_html_analysis_sorts_audio_first_then_uses_ai_result(
    ai_used,
    extract_module,
    settings,
    page_response,
    monkeypatch,
):
    body = b'<title>Media</title><video src="/v.mp4"></video><audio src="/a.mp3"></audio>'
    page_response(lambda request: httpx.Response(200, headers={"content-type": "text/html"}, content=body))
    warning = None if ai_used else "AI unavailable; rules retained"

    def rank(candidates, passed_settings):
        assert passed_settings is settings
        assert [c["kind"] for c in candidates] == ["audio", "video"]
        return list(reversed(candidates)) if ai_used else candidates, ai_used, warning

    rank_mock = Mock(side_effect=rank)
    monkeypatch.setattr(extract_module, "rank_candidates", rank_mock)
    result = extract_module.analyze("https://page.example/", settings)
    assert result["ai_used"] is ai_used and result["warning"] == warning
    assert result["candidates"][0]["kind"] == ("video" if ai_used else "audio")
    assert result["source"] == ("网页候选 + AI 排序" if ai_used else "网页媒体识别")
    rank_mock.assert_called_once()


@pytest.mark.parametrize(
    ("info", "message"),
    [
        (None, "单条"),
        ({"_type": "playlist"}, "播放列表"),
        ({"_type": "multi_video"}, "多视频"),
        ({"entries": []}, "播放列表"),
        ({"is_live": True}, "直播"),
        ({"live_status": "is_live"}, "直播"),
        ({"live_status": "is_upcoming"}, "尚未开始"),
        ({"has_drm": True}, "DRM"),
    ],
)
def test_ytdlp_rejects_playlists_live_and_drm(info, message, extract_module, settings, ytdlp):
    session, _ = ytdlp(info=info)
    with pytest.raises(UserError, match=message):
        extract_module.analyze("https://site.example/watch", settings)
    session.extract_info.assert_called_once_with("https://site.example/watch", download=False)


@pytest.mark.parametrize("vcodec,kind", [("none", "audio"), ("avc1", "video")])
def test_ytdlp_single_media_is_metadata_only_and_redacts_title(vcodec, kind, extract_module, settings, ytdlp):
    session, factory = ytdlp(
        info={
            "title": "Track https://site.example/?token=dummy-secret",
            "extractor_key": "Example",
            "formats": [{"vcodec": vcodec, "acodec": "aac"}],
        }
    )
    result = extract_module.analyze("https://site.example/watch", settings)
    assert result["title"] == "Track [链接]"
    assert result["candidates"][0]["kind"] == kind
    assert result["candidates"][0]["url"] == "https://site.example/watch"
    assert result["source"] == "yt-dlp · Example"
    assert result["ai_used"] is False
    options = factory.call_args.args[0]
    assert options["skip_download"] is True and options["noplaylist"] is True
    assert "cookiefile" not in options and "cookiesfrombrowser" not in options
    session.extract_info.assert_called_once_with("https://site.example/watch", download=False)


def test_ytdlp_backend_errors_are_sanitized(extract_module, settings, ytdlp):
    ytdlp(
        error=RuntimeError(
            "no video formats https://site.example/?token=dummy-key Authorization=dummy-secret"
        )
    )
    with pytest.raises(UserError, match="媒体格式") as error:
        extract_module.analyze("https://site.example/watch", settings)
    assert "dummy" not in str(error.value) and "https://" not in str(error.value)
