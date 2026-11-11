from fastapi import APIRouter, File, Form, Path, Request, UploadFile
from pydantic import BaseModel, Field

import oss_store

router = APIRouter(prefix="/api/files/upload", tags=["upload"])


class UploadInitInput(BaseModel):
    key: str | None = Field(default=None, min_length=1, max_length=1023)
    filename: str | None = Field(default=None, min_length=1, max_length=255)
    prefix: str = Field(default="", max_length=1023)
    content_type: str | None = Field(default=None, max_length=200)
    size: int | None = Field(default=None, ge=0)


class CompletedPart(BaseModel):
    part_number: int = Field(ge=1, le=10000)
    etag: str = Field(min_length=1, max_length=256)


class UploadCompleteInput(BaseModel):
    parts: list[CompletedPart] = Field(min_length=1, max_length=10000)


@router.post("", status_code=201)
def upload_file(
    request: Request,
    file: UploadFile = File(...),
    key: str | None = Form(default=None),
    prefix: str = Form(default=""),
):
    settings = request.app.state.settings
    filename = oss_store.validate_name(file.filename or "")
    target = (
        oss_store.resolve_upload_key(key, settings) if key else oss_store.join_key(prefix, filename, settings)
    )
    oss_store.put_object(
        target,
        file.file,
        settings,
        content_type=_content_type(file.content_type),
    )
    return {"key": target, "size": int(file.size or 0)}


@router.post("/init", status_code=201)
def initialize_upload(data: UploadInitInput, request: Request):
    settings = request.app.state.settings
    if data.key:
        key = oss_store.resolve_upload_key(data.key, settings)
    elif data.filename:
        key = oss_store.join_key(data.prefix, data.filename, settings)
    else:
        raise oss_store.UserError("Either key or filename is required.")
    upload_id = oss_store.init_multipart_upload(
        key,
        settings,
        content_type=_content_type(data.content_type),
    )
    request.app.state.upload_sizes[upload_id] = data.size or 0
    return {"upload_id": upload_id, "key": key}


@router.put("/{upload_id}/{part}")
async def put_upload_part(
    request: Request,
    upload_id: str = Path(min_length=1, max_length=256),
    part: int = Path(ge=1, le=10000),
):
    body = await request.body()
    if not body:
        raise oss_store.UserError("Upload part must not be empty.")
    key = oss_store.multipart_key(upload_id)
    etag = oss_store.upload_part(key, upload_id, part, body, request.app.state.settings)
    return {"upload_id": upload_id, "part_number": part, "etag": etag}


@router.post("/{upload_id}/complete")
def finish_upload(
    data: UploadCompleteInput,
    request: Request,
    upload_id: str = Path(min_length=1, max_length=256),
):
    key = oss_store.multipart_key(upload_id)
    parts = [part.model_dump() for part in data.parts]
    oss_store.complete_multipart_upload(
        key,
        upload_id,
        parts,
        request.app.state.settings,
    )
    size = request.app.state.upload_sizes.pop(upload_id, 0)
    return {"key": key, "size": size}


@router.delete("/{upload_id}")
def cancel_upload(
    request: Request,
    upload_id: str = Path(min_length=1, max_length=256),
):
    key = oss_store.multipart_key(upload_id)
    oss_store.abort_multipart_upload(key, upload_id, request.app.state.settings)
    request.app.state.upload_sizes.pop(upload_id, None)
    return {"ok": True}


def _content_type(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    if len(value) > 200 or "/" not in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        return None
    return value
