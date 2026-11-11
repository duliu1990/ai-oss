from pathlib import PurePosixPath
from typing import Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

import oss_store

router = APIRouter(prefix="/api/files", tags=["files"])

MAX_TEXT_SIZE = 1024 * 1024
TEXT_CONTENT_TYPES = {
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FolderInput(StrictInput):
    prefix: str = Field(min_length=1, max_length=1023)


class RenameInput(StrictInput):
    key: str = Field(min_length=1, max_length=1023)
    new_name: str = Field(min_length=1, max_length=255)


class MoveInput(StrictInput):
    key: str = Field(min_length=1, max_length=1023)
    destination: str = Field(default="", max_length=1023)


class CreateTextFileInput(StrictInput):
    prefix: str = Field(max_length=1023)
    name: str = Field(min_length=1, max_length=255)
    extension: Literal["md", "txt"]
    content: str = Field(default="", max_length=MAX_TEXT_SIZE * 2)


class EditTextFileInput(StrictInput):
    key: str = Field(min_length=1, max_length=1023)
    content: str = Field(max_length=MAX_TEXT_SIZE * 2)
    expected_etag: str = Field(min_length=1, max_length=256)
    force: bool = False


@router.post("/create", status_code=201)
def create_text_file(data: CreateTextFileInput, request: Request):
    settings = request.app.state.settings
    name = oss_store.validate_name(data.name)
    if PurePosixPath(name).suffix.casefold() in TEXT_CONTENT_TYPES:
        raise oss_store.UserError("The file name must not include a .md or .txt extension.")
    body = _encode_text(data.content)
    key = oss_store.join_key(data.prefix, f"{name}.{data.extension}", settings)
    result = oss_store.put_object_if_absent(
        key,
        body,
        settings,
        content_type=TEXT_CONTENT_TYPES[f".{data.extension}"],
    )
    return {"key": key, "etag": result["etag"], "size": len(body)}


@router.get("/edit")
def read_text_file(
    request: Request,
    key: str = Query(min_length=1, max_length=1023),
):
    content_type = _text_content_type(key)
    settings = request.app.state.settings
    snapshot = oss_store.read_object_bounded(key, MAX_TEXT_SIZE, settings)
    body = snapshot["body"]
    try:
        content = body.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise oss_store.UserError("File content is not valid UTF-8.") from None
    return {
        "key": key,
        "content": content,
        "etag": snapshot["etag"],
        "size": snapshot["size"],
        "content_type": content_type,
    }


@router.put("/edit")
def save_text_file(data: EditTextFileInput, request: Request):
    content_type = _text_content_type(data.key)
    body = _encode_text(data.content)
    settings = request.app.state.settings
    metadata = oss_store.head_object(data.key, settings)
    if not data.force and metadata["etag"] != data.expected_etag:
        raise oss_store.PreconditionFailedError(
            "文件已被外部修改，请刷新后重试。",
            metadata["etag"],
        )
    result = oss_store.put_object(
        data.key,
        body,
        settings,
        content_type=content_type,
    )
    return {"key": data.key, "etag": result["etag"], "size": len(body)}


def _text_content_type(key: str) -> str:
    content_type = TEXT_CONTENT_TYPES.get(PurePosixPath(key).suffix.casefold())
    if content_type is None:
        raise oss_store.UserError("Only .md and .txt files can be edited.")
    return content_type


def _encode_text(content: str) -> bytes:
    try:
        body = content.encode("utf-8")
    except UnicodeEncodeError:
        raise oss_store.UserError("File content is not valid UTF-8.") from None
    if len(body) > MAX_TEXT_SIZE:
        raise oss_store.TooLargeError("File content exceeds the 1 MiB limit.")
    return body


@router.get("")
def list_files(
    request: Request,
    prefix: str = Query(default="", max_length=1023),
    marker: str = Query(default="", max_length=2048),
):
    return oss_store.list_directory(prefix, marker, request.app.state.settings)


@router.get("/search")
def search_files(
    request: Request,
    q: str = Query(min_length=1, max_length=200),
    prefix: str = Query(default="", max_length=1023),
):
    return oss_store.search_objects(q, prefix, request.app.state.settings)


@router.get("/download")
def download_file(
    request: Request,
    key: str = Query(min_length=1, max_length=1023),
    download: bool = Query(default=False),
):
    try:
        stream = oss_store.open_stream(
            key,
            request.headers.get("range"),
            request.app.state.settings,
            download=download,
        )
    except oss_store.RangeNotSatisfiable as exc:
        headers = {"Accept-Ranges": "bytes"}
        if exc.size is not None:
            headers["Content-Range"] = f"bytes */{exc.size}"
        return Response(status_code=416, headers=headers)
    return StreamingResponse(stream.body, status_code=stream.status, headers=stream.headers)


@router.delete("")
def delete_file(request: Request, key: str = Query(min_length=1, max_length=1023)):
    oss_store.delete_object(key, request.app.state.settings)
    return {"ok": True}


@router.post("/folder", status_code=201)
def create_folder(data: FolderInput, request: Request):
    settings = request.app.state.settings
    prefix = oss_store.resolve_directory_prefix(data.prefix, settings, allow_root=False)
    oss_store.put_object(prefix, b"", settings, content_type="application/x-directory")
    return {"prefix": prefix}


@router.delete("/folder")
def remove_folder(
    request: Request,
    prefix: str = Query(min_length=1, max_length=1023),
):
    folder = oss_store.resolve_directory_prefix(prefix, request.app.state.settings, allow_root=False)
    deleted = oss_store.delete_folder(folder, request.app.state.settings)
    return {"deleted": deleted}


@router.post("/rename")
def rename_file(data: RenameInput, request: Request):
    settings = request.app.state.settings
    new_name = oss_store.validate_name(data.new_name)
    if not data.key.endswith("/"):
        source = oss_store.ensure_scoped_key(data.key, settings)
        parent = str(PurePosixPath(source).parent)
        destination = f"{parent}/{new_name}" if parent != "." else new_name
        destination = oss_store.ensure_scoped_key(destination, settings)
        oss_store.copy_object(source, destination, settings)
        oss_store.delete_object(source, settings)
        return {"old_key": source, "new_key": destination}

    source = oss_store.ensure_scoped_key(data.key, settings, allow_folder=True)
    parent = str(PurePosixPath(source.rstrip("/")).parent)
    parent_prefix = f"{parent}/" if parent != "." else ""
    destination = oss_store.ensure_scoped_key(
        f"{parent_prefix}{new_name}/",
        settings,
        allow_folder=True,
    )
    _transfer_folder(source, destination, settings)
    return {"old_key": source, "new_key": destination}


@router.post("/move")
def move_file(data: MoveInput, request: Request):
    settings = request.app.state.settings
    if not data.key.endswith("/"):
        source = oss_store.ensure_scoped_key(data.key, settings)
        destination_prefix = oss_store.resolve_directory_prefix(data.destination, settings)
        destination = oss_store.ensure_scoped_key(
            f"{destination_prefix}{PurePosixPath(source).name}", settings
        )
        oss_store.copy_object(source, destination, settings)
        oss_store.delete_object(source, settings)
        return {"old_key": source, "new_key": destination}

    source = oss_store.ensure_scoped_key(data.key, settings, allow_folder=True)
    destination_prefix = oss_store.resolve_directory_prefix(
        data.destination,
        settings,
        strict_scope=True,
    )
    folder_name = PurePosixPath(source.rstrip("/")).name
    destination = oss_store.ensure_scoped_key(
        f"{destination_prefix}{folder_name}/",
        settings,
        allow_folder=True,
    )
    _transfer_folder(source, destination, settings)
    return {"old_key": source, "new_key": destination}


def _transfer_folder(source: str, destination: str, settings) -> None:
    if destination == source:
        raise oss_store.ConflictError("The destination folder is the same as the source folder.")
    if destination.startswith(source):
        raise oss_store.ConflictError("A folder cannot be moved into itself or one of its subfolders.")
    if oss_store.prefix_has_objects(destination, settings):
        raise oss_store.ConflictError("The destination folder already contains objects.")

    source_keys = oss_store.list_recursive_keys(source, settings)
    if not source_keys:
        raise oss_store.UserError("The source folder does not exist or is empty without a folder marker.")

    created_keys: list[str] = []
    try:
        for source_key in source_keys:
            target_key = f"{destination}{source_key[len(source) :]}"
            created_keys.append(target_key)
            oss_store.copy_object(source_key, target_key, settings)
    except Exception as exc:
        rollback_error = None
        if created_keys:
            try:
                oss_store.batch_delete_objects(created_keys, settings)
            except Exception as rollback_exc:
                rollback_error = rollback_exc
        message = "Folder copy failed; no source objects were deleted."
        if rollback_error is not None:
            message += " Some newly created destination objects could not be rolled back."
        elif created_keys:
            message += " Newly created destination objects were rolled back."
        if isinstance(exc, oss_store.UserError):
            message += f" {exc}"
        raise oss_store.UserError(message) from None

    try:
        oss_store.batch_delete_objects(source_keys, settings)
    except Exception:
        raise oss_store.UserError(
            "The folder was copied, but one or more source objects could not be deleted; "
            "both source and destination may now exist."
        ) from None
