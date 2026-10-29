"""Download one public media item into an isolated, already-created directory."""

from __future__ import annotations

import json
import logging
import math
import shutil
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urljoin

import yt_dlp

from config import Settings
from logs import describe_error
from security import UserError, safe_error, safe_label, validate_public_url

log = logging.getLogger("media")

_MEDIA_EXTENSIONS = frozenset(
    {
        ".mp3",
        ".mp4",
        ".mkv",
        ".webm",
        ".m4a",
        ".ogg",
        ".opus",
        ".wav",
        ".flac",
        ".aac",
        ".mov",
        ".avi",
        ".m4v",
        ".flv",
        ".ts",
        ".m2ts",
        ".ogv",
        ".3gp",
        ".3g2",
        ".mpeg",
        ".mpg",
        ".wmv",
    }
)


class _QuietLogger:
    # Never forward extractor messages (which may contain signed URLs) to stdout.
    # Warnings and errors go to the server log with URLs stripped; debug/info stay silent.
    def debug(self, message: str) -> None:
        pass

    def info(self, message: str) -> None:
        pass

    def warning(self, message: str) -> None:
        log.warning("yt-dlp: %s", safe_label(str(message), 1000))

    def error(self, message: str) -> None:
        log.error("yt-dlp: %s", safe_label(str(message), 1000))


def _number(value: object) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if math.isfinite(value) and value >= 0:
            return value
    return 0


def _validate_info(info: dict) -> None:
    if not isinstance(info, dict):
        raise UserError("无法解析单条媒体。")
    if "entries" in info or info.get("_type", "video") != "video":
        raise UserError("仅支持单条媒体，不支持播放列表或多段视频。")
    if info.get("is_live") or info.get("live_status") in {
        "is_live",
        "is_upcoming",
        "post_live",
    }:
        raise UserError("不支持直播、预告或尚未完成处理的直播。")

    checked: set[str] = set()

    def check_url(value: object, base: str = "") -> None:
        if not isinstance(value, str) or not value:
            raise UserError("媒体地址无效。")
        value = urljoin(base, value) if base else value
        if value not in checked:
            validate_public_url(value)
            checked.add(value)

    def check_item(item: dict) -> None:
        if item.get("has_drm") or item.get("_has_drm") or item.get("is_drm"):
            raise UserError("不支持受 DRM 保护的媒体。")
        for field in ("url", "manifest_url", "fragment_base_url", "webpage_url", "original_url"):
            if item.get(field):
                check_url(item[field])
        base = item.get("fragment_base_url") or item.get("manifest_url") or item.get("url", "")
        for fragment in item.get("fragments") or ():
            if not isinstance(fragment, dict):
                raise UserError("媒体分片信息无效。")
            value = fragment.get("url") or fragment.get("path")
            if value:
                check_url(value, base)
        for field in ("formats", "requested_formats", "requested_downloads"):
            for child in item.get(field) or ():
                if not isinstance(child, dict):
                    raise UserError("媒体格式信息无效。")
                check_item(child)

    check_item(info)


def _probe(path: Path, mode: str, executable: str, timeout: int) -> None:
    try:
        result = subprocess.run(
            [
                executable,
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,codec_name:stream_disposition=attached_pic",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=min(timeout, 30),
        )
        streams = json.loads(result.stdout).get("streams", [])
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        stderr = getattr(exc, "stderr", None)
        log.error(
            "ffprobe 校验失败 file=%s：%s%s",
            path.name,
            describe_error(exc),
            f" stderr={stderr[:500]}" if stderr else "",
        )
        raise UserError(f"无法验证最终媒体文件：{safe_error(exc)}") from None
    if mode == "video" and not any(
        s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic") for s in streams
    ):
        raise UserError("下载结果不包含视频轨道，不能作为视频交付。")
    if mode == "audio" and not any(
        s.get("codec_type") == "audio" and s.get("codec_name") == "mp3" for s in streams
    ):
        raise UserError("音频未成功转换为 MP3。")


def download(
    url: str,
    mode: str,
    directory: Path,
    emit: Callable[[dict], None],
    settings: Settings,
) -> dict:
    """Return only a completed, nonempty final file; leave failures for worker cleanup."""
    if mode not in {"audio", "video"}:
        raise UserError("下载模式必须为 audio 或 video。")
    if settings.max_file_mb <= 0 or settings.download_timeout_seconds <= 0:
        raise UserError("文件大小限制和下载超时必须大于零。")
    url = validate_public_url(url)
    limit = settings.max_file_mb * 1024 * 1024
    timeout = settings.download_timeout_seconds
    try:
        directory = directory.resolve(strict=True)
        if not directory.is_dir() or any(p.name != ".managed" for p in directory.iterdir()):
            raise UserError("下载目录必须是未使用的任务目录。")
    except OSError as exc:
        log.error("下载目录不可用 directory=%s：%s", directory, describe_error(exc))
        raise UserError(f"下载目录不可用：{safe_error(exc)}") from None

    ffmpeg, ffprobe, node = (shutil.which(name) for name in ("ffmpeg", "ffprobe", "node"))
    if not ffmpeg or not ffprobe:
        raise UserError("需要本机安装 ffmpeg 和 ffprobe 才能处理并验证媒体。")
    if not node:
        raise UserError("未找到 Node.js，请确认它已加入 PATH。")

    observed: dict[str, float] = {}
    finished = False
    last_event = 0.0

    def progress_hook(data: dict) -> None:
        nonlocal finished, last_event
        status = data.get("status")
        if status not in {"downloading", "finished"}:
            return
        name = str(data.get("filename") or data.get("tmpfilename") or "media")
        observed[name] = max(observed.get(name, 0), _number(data.get("downloaded_bytes")))
        if sum(observed.values()) > limit or _number(data.get("total_bytes")) > limit:
            raise UserError(f"媒体超过 {settings.max_file_mb} MB 的大小限制。")
        if status == "finished":
            finished = True
            emit({"event": "progress", "status": "processing", "progress": None})
            return
        now = time.monotonic()
        if now - last_event < 0.2:
            return
        last_event = now
        total = _number(data.get("total_bytes")) or _number(data.get("total_bytes_estimate"))
        percent = min(100.0, observed[name] / total * 100) if total else None
        emit({"event": "progress", "status": "downloading", "progress": percent})

    def postprocessor_hook(data: dict) -> None:
        if data.get("status") in {"started", "processing", "finished"}:
            emit({"event": "progress", "status": "processing", "progress": None})

    options = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,  # Disables terminal rendering, not progress_hooks.
        "logtostderr": True,
        "logger": _QuietLogger(),
        "http_headers": {"User-Agent": "Mozilla/5.0 MediaToOSS/0.1"},
        "noplaylist": True,
        "playlist_items": "1",
        "extract_flat": "in_playlist",
        "outtmpl": str(directory).replace("%", "%%") + "/media.%(ext)s",
        "format": "bestaudio/best" if mode == "audio" else "bv*+ba/b",
        "merge_output_format": "mp4/mkv",
        "ffmpeg_location": ffmpeg,
        "js_runtimes": {"node": {"path": node}},
        "remote_components": [],
        "cookiefile": None,
        "cookiesfrombrowser": None,
        "usenetrc": False,
        "cachedir": False,
        "nocheckcertificate": False,
        "prefer_insecure": False,
        "max_filesize": limit,
        "socket_timeout": min(timeout, 20),
        "retries": 2,
        "fragment_retries": 2,
        "extractor_retries": 2,
        "file_access_retries": 1,
        "concurrent_fragment_downloads": 1,
        "skip_unavailable_fragments": False,
        "hls_prefer_native": True,
        "ignoreerrors": False,
        "allow_unplayable_formats": False,
        "check_formats": False,  # Do not probe-download formats before URL validation.
        "overwrites": False,
        "continuedl": False,
        "nopart": False,
        "keepvideo": False,
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [postprocessor_hook],
    }
    if mode == "audio":
        options["final_ext"] = "mp3"
        options["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ]

    emit({"event": "progress", "status": "downloading", "progress": None})
    try:
        # Reuse the same instance and validated result: do not extract a second time.
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
            _validate_info(info)
            selected = info.get("requested_formats") or [info]
            available = info.get("formats") or selected
            if mode == "video" and (
                all(item.get("vcodec") == "none" for item in selected)
                or all(item.get("vcodec") == "none" for item in available)
            ):
                raise UserError("该媒体只有音频，请选择音频模式。")
            if sum(_number(item.get("filesize")) for item in selected) > limit:
                raise UserError(f"媒体超过 {settings.max_file_mb} MB 的大小限制。")
            result = ydl.process_ie_result(info, download=True)
            if not isinstance(result, dict) or not finished:
                raise UserError("媒体下载未完成，可能超过文件大小限制。")

        files = list(directory.iterdir())
        if any(".part" in p.suffixes or ".ytdl" in p.suffixes for p in files):
            raise UserError("下载遗留了未完成的分片，拒绝交付半成品。")
        candidates = [p for p in files if p.suffix.lower() in _MEDIA_EXTENSIONS]
        if len(candidates) != 1:
            raise UserError("未得到唯一的最终媒体文件，下载或合并可能未完成。")
        path = candidates[0]
        if path.is_symlink() or not path.is_file() or path.stem != "media":
            raise UserError("最终媒体路径异常，或仍是未合并的中间文件。")
        if mode == "audio" and path.suffix.lower() != ".mp3":
            raise UserError("音频转换未完成，未生成 MP3 文件。")
        size = path.stat().st_size
        if size <= 0 or size > limit:
            raise UserError(f"最终文件为空或超过 {settings.max_file_mb} MB 的大小限制。")
        _probe(path, mode, ffprobe, timeout)
        emit({"event": "progress", "status": "processing", "progress": 100})
        # Optional descriptive fields for the OSS catalog; sites fill these inconsistently.
        artist = next(
            (v for k in ("artist", "creator", "uploader") if isinstance(v := info.get(k), str) and v.strip()),
            None,
        )
        duration = info.get("duration")
        if isinstance(duration, bool) or not isinstance(duration, int | float):
            duration = None
        return {
            "path": str(path.resolve(strict=True)),
            "filename": path.name,
            "size": size,
            "artist": safe_label(artist.strip()) if artist else None,
            "duration": duration,
        }
    except Exception as exc:
        if not isinstance(exc, UserError):
            log.error("yt-dlp 下载失败 mode=%s：%s", mode, safe_label(describe_error(exc), 2000))
        raise UserError(f"媒体下载或处理失败：{safe_error(exc)}") from None
