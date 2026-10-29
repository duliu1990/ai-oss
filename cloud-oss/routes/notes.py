from pathlib import PurePosixPath

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

import oss_store
from config import Settings

router = APIRouter(prefix="/api", tags=["notes"])

DEFAULT_NOTES_PREFIX = "my-note/"
MAX_NOTE_SIZE = 1024 * 1024
NOTE_CONTENT_TYPE = "text/markdown; charset=utf-8"


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateNoteInput(StrictInput):
    name: str = Field(min_length=1, max_length=255)
    content: str = Field(default="", max_length=MAX_NOTE_SIZE * 2)


class UpdateNoteInput(StrictInput):
    key: str = Field(min_length=1, max_length=1023)
    content: str = Field(max_length=MAX_NOTE_SIZE * 2)
    expected_etag: str = Field(min_length=1, max_length=256)
    force: bool = False


def notes_prefix(settings: Settings) -> str:
    if settings.note_oss_prefix:
        return settings.note_oss_prefix
    file_prefix = oss_store.object_prefix(settings).rstrip("/")
    return f"{file_prefix}-note/" if file_prefix else DEFAULT_NOTES_PREFIX


def _notes_store(request: Request):
    settings = request.app.state.settings
    scoped_settings = oss_store.settings_with_prefix(settings, notes_prefix(settings))
    return scoped_settings, oss_store.get_bucket(settings)


def _note_key(key: str, settings: Settings) -> str:
    key = oss_store.ensure_scoped_key(key, settings)
    relative = key[len(oss_store.object_prefix(settings)) :]
    if "/" in relative or PurePosixPath(relative).suffix.casefold() != ".md":
        raise oss_store.UserError("Invalid note key.")
    return key


def _encode_note(content: str) -> bytes:
    try:
        body = content.encode("utf-8")
    except UnicodeEncodeError:
        raise oss_store.UserError("Note content is not valid UTF-8.") from None
    if len(body) > MAX_NOTE_SIZE:
        raise oss_store.TooLargeError("Note content exceeds the 1 MiB limit.")
    return body


@router.get("/notes")
def list_notes(request: Request):
    """List Markdown notes stored directly below the dedicated notes prefix."""
    settings, bucket = _notes_store(request)
    prefix = oss_store.object_prefix(settings)
    objects = oss_store.list_directory("", "", settings, bucket=bucket)["files"]
    notes = [
        {
            "key": obj["key"],
            "name": obj["name"],
            "folder": prefix,
            "size": obj["size"],
            "last_modified": obj["last_modified"],
        }
        for obj in objects
        if obj["name"].lower().endswith(".md")
    ]
    notes.sort(key=lambda note: note["last_modified"], reverse=True)
    return {"prefix": prefix, "notes": notes}


@router.post("/notes", status_code=201)
def create_note(data: CreateNoteInput, request: Request):
    settings, bucket = _notes_store(request)
    name = oss_store.validate_name(data.name)
    if PurePosixPath(name).suffix.casefold() == ".md":
        raise oss_store.UserError("The note name must not include a .md extension.")
    body = _encode_note(data.content)
    key = oss_store.join_key("", f"{name}.md", settings)
    result = oss_store.put_object_if_absent(
        key,
        body,
        settings,
        content_type=NOTE_CONTENT_TYPE,
        bucket=bucket,
    )
    return {"key": key, "etag": result["etag"], "size": len(body)}


@router.get("/notes/content")
def read_note(
    request: Request,
    key: str = Query(min_length=1, max_length=1023),
):
    settings, bucket = _notes_store(request)
    key = _note_key(key, settings)
    snapshot = oss_store.read_object_bounded(key, MAX_NOTE_SIZE, settings, bucket=bucket)
    try:
        content = snapshot["body"].decode("utf-8-sig")
    except UnicodeDecodeError:
        raise oss_store.UserError("Note content is not valid UTF-8.") from None
    return {
        "key": key,
        "content": content,
        "etag": snapshot["etag"],
        "size": snapshot["size"],
        "content_type": NOTE_CONTENT_TYPE,
    }


@router.put("/notes")
def save_note(data: UpdateNoteInput, request: Request):
    settings, bucket = _notes_store(request)
    key = _note_key(data.key, settings)
    body = _encode_note(data.content)
    metadata = oss_store.head_object(key, settings, bucket=bucket)
    if not data.force and metadata["etag"] != data.expected_etag:
        raise oss_store.PreconditionFailedError(
            "文件已被外部修改，请刷新后重试。",
            metadata["etag"],
        )
    result = oss_store.put_object(
        key,
        body,
        settings,
        content_type=NOTE_CONTENT_TYPE,
        bucket=bucket,
    )
    return {"key": key, "etag": result["etag"], "size": len(body)}


@router.delete("/notes")
def delete_note(
    request: Request,
    key: str = Query(min_length=1, max_length=1023),
):
    settings, bucket = _notes_store(request)
    key = _note_key(key, settings)
    oss_store.delete_object(key, settings, bucket=bucket)
    return {"ok": True}
