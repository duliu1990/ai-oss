# Driver OSS

A local personal drive backed directly by a private Aliyun OSS bucket. It runs on `127.0.0.1:8700`, requires no login, confines every operation to `OSS_PREFIX`, and serves the separately built frontend from `frontend/dist`.

## Run

Requires Python 3.12 and `uv`.

```bash
cp .env.example .env
# Fill in the OSS settings in .env.
uv sync --dev
uv run --locked python app.py
```

Open `http://127.0.0.1:8700`. `GET /healthz` remains available even when OSS is not configured. The OSS credentials need list, get, put, multipart upload, copy, and delete permissions within the configured prefix.

## API

- `GET /api/config` — non-sensitive bucket, prefix, and port settings
- `GET /api/files?prefix=&marker=` — paginated directory listing
- `GET /api/files/search?q=&prefix=` — recursive filename search
- `POST /api/files/upload` — multipart-form direct upload (`file` plus `key`, or optional `prefix`)
- `POST /api/files/upload/init` — initialize multipart upload
- `PUT /api/files/upload/{upload_id}/{part}` — upload a raw part body
- `POST /api/files/upload/{upload_id}/complete` — complete with ordered `parts`
- `DELETE /api/files/upload/{upload_id}` — abort multipart upload
- `GET /api/files/download?key=&download=false` — inline Range stream or attachment download
- `DELETE /api/files?key=` — delete one file
- `POST /api/files/folder` / `DELETE /api/files/folder?prefix=` — create or recursively delete a folder
- `POST /api/files/rename` — copy and delete rename
- `POST /api/files/move` — copy and delete move

OSS folders are zero-byte objects ending in `/`. Multipart upload IDs are kept in process memory, so unfinished uploads should be aborted before restarting the service.
