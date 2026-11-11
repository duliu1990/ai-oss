# Driver OSS

A local personal drive backed directly by a private Aliyun OSS bucket. The API runs on `127.0.0.1:8700`, confines every operation to `OSS_PREFIX`, and login is optional (enabled once `AUTH_USERNAME`, `AUTH_PASSWORD_HASH` and `JWT_SECRET_KEY` are all set).

## Layout

- `backend/` — FastAPI service (`app.py`, `routes/`, `tests/`, `pyproject.toml`, `.env`)
- `frontend/` — React + Vite Web UI and the Capacitor iOS app
- `run.sh` — local launcher for both
- `deploy/cloud-oss.conf` — standalone nginx site proxying the backend API only (`/api/`, `/healthz`); install as `/etc/nginx/conf.d/cloud-oss.conf`

## Run

Requires Python 3.12, `uv`, Node.js 22.12+ and npm.

```bash
./run.sh setup   # install dependencies, create backend/.env from the example
# Fill in the OSS settings in backend/.env.
./run.sh         # backend on :8700 + Vite on :5173, Ctrl-C stops both
```

Open `http://127.0.0.1:5173`; Vite proxies `/api` to the backend. Other commands:

- `./run.sh start` — rebuild `frontend/dist` if stale, then serve UI + API from the backend on `http://127.0.0.1:8700`
- `./run.sh backend` / `./run.sh frontend` — start only one side
- `./run.sh build` — typecheck and build `frontend/dist`
- `./run.sh test` — backend pytest + ruff, frontend vitest + typecheck

`GET /healthz` remains available even when OSS is not configured. The OSS credentials need list, get, put, multipart upload, copy, and delete permissions within the configured prefix.

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
