from fastapi import APIRouter, Query, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

import media_store

router = APIRouter(prefix="/api", tags=["media"])


class MetaInput(BaseModel):
    key: str = Field(min_length=1, max_length=1023)
    title: str | None = Field(default=None, max_length=400)
    artist: str | None = Field(default=None, max_length=400)
    favorite: bool | None = None


@router.get("/tracks")
def tracks(request: Request):
    listing = media_store.list_audio(request.app.state.settings)
    for track in listing["tracks"]:
        track.update(request.app.state.library.get(track["key"]))
    return listing


@router.put("/tracks/meta")
def update_meta(data: MetaInput, request: Request):
    key = media_store.ensure_audio_key(data.key, request.app.state.settings)
    entry = request.app.state.library.update(
        key, title=data.title, artist=data.artist, favorite=data.favorite
    )
    return {"key": key, **entry}


@router.get("/stream")
def stream(request: Request, key: str = Query(min_length=1, max_length=1023)):
    try:
        audio = media_store.open_stream(key, request.headers.get("range"), request.app.state.settings)
    except media_store.RangeNotSatisfiable as exc:
        headers = {"Accept-Ranges": "bytes"}
        if exc.size is not None:
            headers["Content-Range"] = f"bytes */{exc.size}"
        return Response(status_code=416, headers=headers)
    return StreamingResponse(audio.body, status_code=audio.status, headers=audio.headers)
