"""Local track metadata (title, artist, favorite). OSS object names are random, so names live here."""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
from pathlib import Path

from security import UserError

log = logging.getLogger("library")

MAX_TEXT = 200
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def clean_text(value: str) -> str:
    value = _CONTROL.sub(" ", value or "").strip()
    if len(value) > MAX_TEXT:
        raise UserError(f"曲名和歌手不能超过 {MAX_TEXT} 个字符。")
    return value


class Library:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._entries: dict[str, dict] = self._load()

    def _load(self) -> dict[str, dict]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as exc:
            # Never overwrite a file we could not parse; the user may want to repair it.
            raise RuntimeError(f"无法读取曲库文件 {self.path}：{exc}") from None
        tracks = data.get("tracks", {}) if isinstance(data, dict) else {}
        entries = {}
        for key, entry in tracks.items():
            if isinstance(key, str) and isinstance(entry, dict):
                entries[key] = {
                    "title": str(entry.get("title", ""))[:MAX_TEXT],
                    "artist": str(entry.get("artist", ""))[:MAX_TEXT],
                    "favorite": bool(entry.get("favorite", False)),
                }
        return entries

    def _save(self, entries: dict[str, dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"version": 1, "tracks": entries}, ensure_ascii=False, indent=2)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".library-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def get(self, key: str) -> dict:
        with self._lock:
            entry = self._entries.get(key)
            return dict(entry) if entry else {"title": "", "artist": "", "favorite": False}

    def update(self, key: str, **changes) -> dict:
        with self._lock:
            entry = dict(self._entries.get(key) or {"title": "", "artist": "", "favorite": False})
            for field in ("title", "artist"):
                if changes.get(field) is not None:
                    entry[field] = clean_text(changes[field])
            if changes.get("favorite") is not None:
                entry["favorite"] = bool(changes["favorite"])
            entries = dict(self._entries)
            if entry["title"] or entry["artist"] or entry["favorite"]:
                entries[key] = entry
            else:
                entries.pop(key, None)
            # Persist first so memory never diverges from disk when the write fails.
            self._save(entries)
            self._entries = entries
            log.info("更新曲目信息 key=%s favorite=%s", key, entry["favorite"])
            return dict(entry)
