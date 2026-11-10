import json

import pytest

from library import Library
from security import UserError


def test_update_persists_and_reloads(tmp_path):
    path = tmp_path / "data" / "library.json"
    library = Library(path)
    entry = library.update("media/a.mp3", title="  晴天 ", artist="周杰伦")
    assert entry == {"title": "晴天", "artist": "周杰伦", "favorite": False}

    library.update("media/a.mp3", favorite=True)
    reloaded = Library(path)
    assert reloaded.get("media/a.mp3") == {"title": "晴天", "artist": "周杰伦", "favorite": True}
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == 1


def test_partial_update_keeps_other_fields(tmp_path):
    library = Library(tmp_path / "library.json")
    library.update("k.mp3", title="A", artist="B")
    assert library.update("k.mp3", favorite=True) == {"title": "A", "artist": "B", "favorite": True}


def test_clearing_everything_removes_entry(tmp_path):
    path = tmp_path / "library.json"
    library = Library(path)
    library.update("k.mp3", title="A")
    library.update("k.mp3", title="")
    assert json.loads(path.read_text(encoding="utf-8"))["tracks"] == {}
    assert library.get("k.mp3") == {"title": "", "artist": "", "favorite": False}


def test_control_characters_and_length(tmp_path):
    library = Library(tmp_path / "library.json")
    assert library.update("k.mp3", title="a\nb")["title"] == "a b"
    with pytest.raises(UserError):
        library.update("k.mp3", title="x" * 201)
    assert library.get("k.mp3")["title"] == "a b"


def test_corrupt_file_is_not_overwritten(tmp_path):
    path = tmp_path / "library.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(RuntimeError, match="无法读取曲库文件"):
        Library(path)
    assert path.read_text(encoding="utf-8") == "{not json"
