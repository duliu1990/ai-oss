from unittest.mock import MagicMock

import pytest

import media
from config import Settings
from security import UserError


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(media, "validate_public_url", lambda url: url)
    monkeypatch.setattr(media.shutil, "which", lambda name: "/mock/" + name)
    monkeypatch.setattr(media, "_probe", lambda *args: None)
    (tmp_path / ".managed").touch()
    settings = Settings(_env_file=None)
    return tmp_path, settings


def install_downloader(monkeypatch, directory, info=None, partial=False):
    captured = {}
    info = (
        info if info is not None else {"url": "https://example.com/media", "vcodec": "none", "acodec": "mp3"}
    )

    def factory(options):
        captured.update(options)
        ydl = MagicMock()
        ydl.__enter__.return_value = ydl
        ydl.extract_info.return_value = info

        def process(result, download):
            assert result is info and download is True
            path = directory / "media.mp3"
            path.write_bytes(b"test MP3")
            if partial:
                (directory / "media.mp3.part").write_bytes(b"partial")
            for hook in options["progress_hooks"]:
                hook(
                    {"status": "downloading", "downloaded_bytes": 4, "total_bytes": 8, "filename": str(path)}
                )
                hook({"status": "finished", "downloaded_bytes": 8, "filename": str(path)})
            return result

        ydl.process_ie_result.side_effect = process
        return ydl

    monkeypatch.setattr(media.yt_dlp, "YoutubeDL", factory)
    return captured


def test_download_accepts_ownership_marker(setup, monkeypatch):
    directory, settings = setup
    options = install_downloader(monkeypatch, directory)
    events = []
    result = media.download("https://example.com/media", "audio", directory, events.append, settings)
    assert result["filename"] == "media.mp3" and result["size"] == 8
    assert result["artist"] is None and result["duration"] is None
    assert options["noplaylist"] is True
    assert options["nocheckcertificate"] is False
    assert options["cookiesfrombrowser"] is None
    assert options["postprocessors"][0]["preferredcodec"] == "mp3"
    assert {e["status"] for e in events} == {"downloading", "processing"}


def test_download_reports_catalog_fields(setup, monkeypatch):
    directory, settings = setup
    info = {
        "url": "https://example.com/media",
        "vcodec": "none",
        "acodec": "mp3",
        "artist": "  ",
        "uploader": "Channel\nName https://x.example/a",
        "duration": 183.25,
    }
    install_downloader(monkeypatch, directory, info=info)
    result = media.download("https://example.com/media", "audio", directory, lambda e: None, settings)
    assert result["artist"] == "Channel Name [链接]" and result["duration"] == 183.25


def test_download_does_not_overwrite_existing_files(setup, monkeypatch):
    directory, settings = setup
    existing = directory / "media.mp3"
    existing.write_bytes(b"keep")
    with pytest.raises(UserError, match="未使用"):
        media.download("https://example.com/media", "audio", directory, lambda e: None, settings)
    assert existing.read_bytes() == b"keep"


def test_partial_file_never_returned(setup, monkeypatch):
    directory, settings = setup
    install_downloader(monkeypatch, directory, partial=True)
    with pytest.raises(UserError, match="半成品"):
        media.download("https://example.com/media", "audio", directory, lambda e: None, settings)


@pytest.mark.parametrize("info", [{"entries": []}, {"has_drm": True}, {"is_live": True}])
def test_reject_disallowed_media(setup, monkeypatch, info):
    directory, settings = setup
    install_downloader(monkeypatch, directory, info=info)
    with pytest.raises(UserError):
        media.download("https://example.com/media", "audio", directory, lambda e: None, settings)
    assert not (directory / "media.mp3").exists()


def test_reject_audio_as_video(setup, monkeypatch):
    directory, settings = setup
    install_downloader(monkeypatch, directory)
    with pytest.raises(UserError, match="只有音频"):
        media.download("https://example.com/media", "video", directory, lambda e: None, settings)


def test_backend_errors_are_safe(setup, monkeypatch):
    directory, settings = setup
    monkeypatch.setattr(
        media.yt_dlp, "YoutubeDL", MagicMock(side_effect=RuntimeError("secret-url?token=abc"))
    )
    with pytest.raises(UserError) as error:
        media.download("https://example.com/media", "audio", directory, lambda e: None, settings)
    assert "abc" not in str(error.value)
