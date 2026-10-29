import json
import logging
from pathlib import PurePosixPath
from urllib.parse import urljoin, urlsplit

import httpx
import yt_dlp
from bs4 import BeautifulSoup
from yt_dlp.extractor import gen_extractor_classes

from ai import rank_candidates
from config import Settings
from logs import describe_error
from security import UserError, safe_error, safe_label, validate_public_url

log = logging.getLogger("extract")

AUDIO_EXT = {".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus"}
VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv", ".m4v"}
MEDIA_EXT = AUDIO_EXT | VIDEO_EXT | {".m3u8", ".mpd"}


class QuietLogger:
    # yt-dlp messages may embed signed URLs; strip them before they reach the server log.
    def debug(self, message):
        pass

    def warning(self, message):
        log.warning("yt-dlp: %s", safe_label(str(message), 1000))

    def error(self, message):
        log.error("yt-dlp: %s", safe_label(str(message), 1000))


def media_kind(url: str) -> str:
    suffix = PurePosixPath(urlsplit(url).path).suffix.lower()
    return "audio" if suffix in AUDIO_EXT else "video" if suffix in VIDEO_EXT else "unknown"


def is_specialized(url: str) -> bool:
    return any(cls.ie_key() != "Generic" and cls.suitable(url) for cls in gen_extractor_classes())


def fetch_page(url: str) -> tuple[str, str, bytes]:
    with httpx.Client(timeout=20, follow_redirects=False, trust_env=False) as client:
        for _ in range(6):
            url = validate_public_url(url)
            with client.stream("GET", url, headers={"User-Agent": "Mozilla/5.0 MediaToOSS/0.1"}) as response:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise UserError("网页重定向缺少目标地址。")
                    url = urljoin(url, location)
                    continue
                response.raise_for_status()
                content_type = response.headers.get("content-type", "").split(";")[0].lower()
                if content_type.startswith(("audio/", "video/")) or content_type in {
                    "application/vnd.apple.mpegurl",
                    "application/x-mpegurl",
                    "application/dash+xml",
                }:
                    return url, content_type, b""
                suffix = PurePosixPath(urlsplit(url).path).suffix.lower()
                if (
                    content_type in {"application/octet-stream", "binary/octet-stream"}
                    and suffix in MEDIA_EXT
                ):
                    return url, content_type, b""
                if content_type not in {"text/html", "application/xhtml+xml", ""}:
                    raise UserError("链接未返回支持的音视频文件或 HTML 页面。")
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > 2 * 1024 * 1024:
                        raise UserError("网页超过 2 MB 分析上限，请提供直接媒体链接。")
                return url, content_type, bytes(body)
        raise UserError("网页重定向次数过多。")


def html_candidates(url: str, body: bytes) -> tuple[str, list[dict]]:
    soup = BeautifulSoup(body, "html.parser")
    title = safe_label(soup.title.get_text(" ", strip=True)) if soup.title else "网页媒体"
    found: list[dict] = []
    seen: set[str] = set()

    def add(raw, label="", kind="unknown"):
        if not isinstance(raw, str) or not raw.strip() or len(found) >= 40:
            return
        try:
            candidate = validate_public_url(urljoin(url, raw.strip()))
        except ValueError:
            return
        if candidate in seen:
            return
        seen.add(candidate)
        detected = media_kind(candidate)
        found.append(
            {
                "id": str(len(found) + 1),
                "url": candidate,
                "title": safe_label(label or PurePosixPath(urlsplit(candidate).path).name or "媒体"),
                "kind": detected if detected != "unknown" else kind,
            }
        )

    for node in soup.select("audio[src],video[src],source[src]"):
        parent = node if node.name in {"audio", "video"} else node.find_parent(["audio", "video"])
        if node.name == "source" and parent is None:
            continue
        kind = parent.name if parent else "unknown"
        add(node.get("src"), node.get("title", ""), kind)
    for node in soup.find_all("meta"):
        prop = node.get("property", node.get("name", ""))
        if prop in {
            "og:audio",
            "og:audio:url",
            "og:audio:secure_url",
            "og:video",
            "og:video:url",
            "og:video:secure_url",
            "twitter:player:stream",
        }:
            add(node.get("content"), title, "audio" if "audio" in prop else "video")
    for node in soup.find_all("a", href=True):
        raw = node.get("href", "")
        try:
            suffix = PurePosixPath(urlsplit(raw).path).suffix.lower()
        except ValueError:
            continue
        if suffix in MEDIA_EXT:
            add(raw, node.get_text(" ", strip=True))

    def walk(data, depth=0):
        if depth > 15:
            return
        if isinstance(data, list):
            for item in data[:100]:
                walk(item, depth + 1)
        elif isinstance(data, dict):
            types = data.get("@type", "")
            types = types if isinstance(types, list) else [types]
            kind = "audio" if "AudioObject" in types else "video" if "VideoObject" in types else "unknown"
            if kind != "unknown":
                label = data.get("name", title)
                add(data.get("contentUrl"), label if isinstance(label, str) else title, kind)
            for value in list(data.values())[:100]:
                if isinstance(value, (list, dict)):
                    walk(value, depth + 1)

    for node in soup.find_all("script", type="application/ld+json"):
        try:
            walk(json.loads(node.string or ""))
        except (ValueError, RecursionError):
            continue
    return title or "网页媒体", found


def specialized_analysis(url: str) -> dict:
    options = {
        "quiet": True,
        "no_warnings": True,
        "logger": QuietLogger(),
        "http_headers": {"User-Agent": "Mozilla/5.0 MediaToOSS/0.1"},
        "noplaylist": True,
        "socket_timeout": 20,
        "retries": 1,
        "extractor_retries": 1,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "js_runtimes": {"node": {}},
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info or info.get("_type") in {"playlist", "multi_video"} or "entries" in info:
        raise UserError("只支持单条音视频，不支持播放列表或多视频页面。")
    if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming"}:
        raise UserError("暂不支持直播或尚未开始的媒体。")
    if info.get("has_drm"):
        raise UserError("该媒体受 DRM 保护，工具不支持下载。")
    formats = info.get("formats", [])
    has_video = any(f.get("vcodec") not in {None, "none"} for f in formats)
    kind = "video" if has_video else "audio" if formats else "unknown"
    title = safe_label(str(info.get("title") or "媒体"))
    return {
        "title": title,
        "source": "yt-dlp · " + str(info.get("extractor_key", "站点解析")),
        "candidates": [{"id": "1", "title": title, "kind": kind, "url": url}],
        "ai_used": False,
        "warning": None,
    }


def analyze(url: str, settings: Settings) -> dict:
    url = validate_public_url(url)
    try:
        if is_specialized(url):
            return specialized_analysis(url)
        final_url, content_type, body = fetch_page(url)
        if content_type not in {"text/html", "application/xhtml+xml", ""}:
            kind = media_kind(final_url)
            if content_type.startswith("audio/"):
                kind = "audio"
            elif content_type.startswith("video/"):
                kind = "video"
            title = safe_label(PurePosixPath(urlsplit(final_url).path).name or "在线媒体")
            return {
                "title": title,
                "source": "媒体直链",
                "candidates": [{"id": "1", "title": title, "kind": kind, "url": final_url}],
                "ai_used": False,
                "warning": None,
            }
        title, candidates = html_candidates(final_url, body)
        if not candidates:
            raise UserError(
                "页面中没有发现可下载媒体。若播放器依赖登录或脚本，请提供媒体直链或受支持站点链接。"
            )
        candidates.sort(key=lambda c: c["kind"] != "audio")
        candidates, used, warning = rank_candidates(candidates, settings)
        return {
            "title": title,
            "source": "网页候选 + AI 排序" if used else "网页媒体识别",
            "candidates": candidates,
            "ai_used": used,
            "warning": warning,
        }
    except UserError:
        raise
    except Exception as exc:
        log.error("链接分析失败 host=%s：%s", urlsplit(url).hostname, safe_label(describe_error(exc), 2000))
        raise UserError(safe_error(exc)) from None
