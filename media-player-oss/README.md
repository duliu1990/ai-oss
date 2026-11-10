# 轻听 · Media Player OSS

A personal music player for private Aliyun OSS audio: React + TypeScript on the Web, the same UI packaged locally with Capacitor 8 for Android/iOS, and a Python/FastAPI streaming backend. It complements [media-to-oss](../media-to-oss): upload there, listen here.

**Login is required and mandatory. A single fixed account lives in `.env` (username + bcrypt password hash) and issues stateless HS256 JWTs; there is no database and no registration. Until `AUTH_USERNAME`, `AUTH_PASSWORD_HASH`, and `JWT_SECRET_KEY` are all set, every `/api/*` data route returns 503 — the service fails closed, never open. Only `/`, `/assets/*`, `/healthz`, and `/api/auth/*` are public.**

- 列出 `OSS_PREFIX` 下的全部音频（mp3 / m4a / aac / ogg / opus / wav / flac），自动翻页，按上传时间倒序。
- 通过本机服务**按字节范围转发** OSS 数据：拖动进度条秒开，不需要公共读 Bucket、不需要配置 CORS，浏览器也拿不到签名链接或密钥。
- 播放 / 暂停、上一首 / 下一首、进度拖动、音量与静音、随机播放、列表循环 / 单曲循环 / 顺序播放。
- 曲名、歌手、时长自动读取 media-to-oss 写在 OSS 上的 `catalog.json`；也可以在本机改名、收藏到“我喜欢”、搜索与排序，本机信息保存在 `backend/data/library.json`，**不会修改 OSS 上的任何文件**。
- Device-local volume, playback mode, last track, and position are remembered without autoplay. This release covers foreground playback only: no offline download, background-playback guarantee, or lock-screen controls. The legacy browser Media Session integration (system metadata, playback state/position, and media-key actions) is intentionally not migrated in this release; in-page controls, position restoration, and keyboard shortcuts remain.
- 快捷键：`空格` 播放/暂停，`←` / `→` 快退/快进 5 秒，`/` 聚焦搜索框。

## 1. Local Web startup and development

### Project layout

The backend and frontend are independent folders, each with its own dependencies and build, so they can be deployed or packaged separately:

| Folder | Contents | Deliverable |
| --- | --- | --- |
| `backend/` | FastAPI service, `pyproject.toml` / `uv.lock`, `.env`, `data/library.json`, backend tests | Python API process (`uv run --locked python app.py`) |
| `frontend/` | React UI, Vite config, Capacitor `android/` / `ios/`, frontend tests | Web bundle `frontend/dist`, Android/iOS apps |
| `run.sh` | Local launcher for both | — |

For local single-port runs, the backend also serves the sibling `../frontend/dist` (`FRONTEND_DIST`). If that directory is absent the API still works and only `/` returns 503, so the backend can run API-only. The Web UI always calls `/api` on its own origin; when hosting `frontend/dist` elsewhere, put it behind the same origin as the backend (reverse-proxy `/api`). Native apps call the HTTPS server origin entered at first launch (section 5).

### Quick start: `run.sh`

```bash
./run.sh setup     # uv sync (backend) + npm ci (frontend); creates backend/.env from the example if missing
./run.sh           # = ./run.sh start: rebuild frontend/dist if sources changed, then serve on http://127.0.0.1:8767
./run.sh dev       # hot reload: backend + Vite together on http://127.0.0.1:5173, Ctrl-C stops both
./run.sh backend   # backend only;  ./run.sh frontend  # Vite only
./run.sh build     # typecheck + build frontend/dist
./run.sh test      # backend pytest + ruff, frontend vitest + typecheck
```

The script refuses to start when `backend/.env` or dependencies are missing, or when port 8767/5173 is already in use. The manual equivalents follow.

### Requirements

| Tool | Requirement |
| --- | --- |
| Python / uv | Python 3.12.x only; uv 0.7.13 or later with lockfile support. |
| Node / npm | Node 24 recommended (package minimum 22.12); npm 10+. Implementation used Node 24.2.0 and npm 11.3.0. |
| Frontend | React 19.3.1, Vite 8.3.4, TypeScript 5.9.3, Vitest 5.0.5; use the npm lockfile. |
| Native | Capacitor core/CLI/Android/iOS are all pinned to 8.5.3; see section 5. |

Backend commands run inside `backend/`; frontend commands use `npm --prefix frontend` from the repository root. Preserve an existing `backend/.env`; otherwise create one from the example and fill in OSS settings. A configuration copied from media-to-oss is also supported; unknown backend fields are ignored.

```bash
npm --prefix frontend ci
npm --prefix frontend run build
cd backend
uv sync --locked --python 3.12
test -f .env || cp .env.example .env
chmod 600 .env
# Edit .env before starting; never overwrite an existing working configuration.
uv run --locked python app.py
```

Open **http://127.0.0.1:8767**. Python serves `../frontend/dist`; building it is required for the Web UI. An absent build returns 503, not the old `static/` UI. The index is `no-store`, hashed `/assets` files are immutable, and unknown assets/API paths return 404. Restart Python after changing its environment. Port 8767 does not conflict with media-to-oss on 8765.

Use the `uv run --locked python app.py` entry point locally. It initializes `truststore` so OSS HTTPS requests use the operating system's trusted certificate store before Uvicorn starts. Direct `uvicorn app:app` skips that initialization. The launcher runs one worker on `127.0.0.1:8767`. If uv itself needs enterprise system CAs while downloading dependencies, use its `--native-tls` option; never disable TLS verification.

For React hot reload, use `./run.sh dev`, or run these in two terminals from the root:

```bash
# Terminal 1: this flag adds exactly http://127.0.0.1:5173.
cd backend && ENABLE_DEV_ORIGIN=true uv run --locked python app.py
# Terminal 2:
npm --prefix frontend run dev
```

Open **http://127.0.0.1:5173** (not `localhost:5173`). Vite forwards `/api` to port 8767, preserving Origin and Range. Development uses the Vite and Python processes together; keep both local listeners on loopback.

## 2. 配置

| 配置项 | 说明 |
| --- | --- |
| `OSS_ENDPOINT` | 必填；Bucket 所在地域的 HTTPS Endpoint，例如 `https://oss-cn-hangzhou.aliyuncs.com` |
| `OSS_BUCKET` | 必填；Bucket 名称 |
| `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | 必填；RAM 用户或 STS 临时凭据 |
| `OSS_SECURITY_TOKEN` | 使用 STS 临时凭据时填写 |
| `OSS_PREFIX` | 只读取该前缀下的音频，默认 `media/`，与 media-to-oss 保持一致 |
| `LIBRARY_FILE` | 本机曲库（曲名、歌手、收藏）文件，默认 `data/library.json`，相对路径基于 `backend/` 目录 |
| `LOG_LEVEL` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |
| `FRONTEND_DIST` | Built Web directory the backend serves at `/`; default `../frontend/dist`, resolved from `backend/`. Point it at a missing directory for an API-only backend. |
| `ALLOWED_HOSTS` | JSON array of exact lowercase DNS/IPv4 hosts, without scheme, wildcard, or port. Default: `["localhost","127.0.0.1"]`. |
| `ALLOWED_ORIGINS` | JSON array of exact canonical origins, no path, trailing slash, or default port. Native apps require `["capacitor://localhost","https://localhost"]`; Web-only can use `[]`. Same-origin Web needs no extra entry. |
| `ENABLE_DEV_ORIGIN` | Default `false`; `true` adds only `http://127.0.0.1:5173` for Vite hot reload. |
| `AUTH_USERNAME` | 必填；登录用户名，最长 100 字符 |
| `AUTH_PASSWORD_HASH` | 必填；密码的 bcrypt 哈希，**不是明文密码** |
| `JWT_SECRET_KEY` | 必填；JWT 签名密钥，至少 32 字节，泄露等同于密码泄露 |
| `JWT_EXPIRE_MINUTES` | 登录有效期（分钟），默认 `1440`（1 天），范围 1–43200 |

生成凭据（在 `backend/` 目录执行）：

```bash
# 密码哈希：把 你的密码 换成实际密码
uv run python -c "import bcrypt; print(bcrypt.hashpw(b'你的密码', bcrypt.gensalt()).decode())"
# JWT 密钥
uv run python -c "import secrets; print(secrets.token_urlsafe(32))"
```

把输出分别写入 `backend/.env` 的 `AUTH_PASSWORD_HASH` 与 `JWT_SECRET_KEY`，然后重启服务。修改密码或密钥会使已签发的令牌全部失效，所有客户端需要重新登录。

Examples use single-quoted JSON in dotenv files. These quotes are removed by the dotenv parser, not sent as part of the JSON. The application reads `backend/.env` directly (regardless of the working directory); do not source it as a shell script or put credentials in frontend variables. Shared metadata lives in the backend's local `backend/data/library.json`; playback preferences remain on each device.

播放器只需要**只读权限**：对象级 `oss:GetObject` 和 Bucket 级 `oss:ListObjects`。media-to-oss README 中的参考策略已经包含这两项；如果单独给播放器建 RAM 用户，可以只授权：

```json
{
  "Version": "1",
  "Statement": [
    { "Effect": "Allow", "Action": "oss:GetObject", "Resource": "acs:oss:*:*:your-bucket-name/media/*" },
    { "Effect": "Allow", "Action": "oss:ListObjects", "Resource": "acs:oss:*:*:your-bucket-name", "Condition": { "StringLike": { "oss:Prefix": "media/*" } } }
  ]
}
```

## 3. 关于曲名

media-to-oss 上传时使用随机对象名（如 `d95ecce8….mp3`），同时把标题、歌手、时长、来源写入同一前缀下的 `catalog.json`（默认 `media/catalog.json`）。播放器每次刷新列表时会一并读取它，显示优先级为：

1. 本机 `backend/data/library.json` 中手动填写的曲名 / 歌手（点击曲目右侧的 ✎；留空保存即恢复 catalog 中的名称）；
2. `catalog.json` 中的 `title` / `artist`；
3. 文件名：随机名显示为“未命名音频 d95ecc”，有意义的文件名（如 `media/album/夜曲.mp3`）直接显示。

播放器对 `catalog.json` **只读**，不需要额外权限（它在 `media/*` 下，已包含在 `oss:GetObject` 中）。文件不存在时按文件名显示；损坏或读取失败时列表照常可用，顶部会提示原因。

本机曲库文件只是 JSON，可以备份或手动编辑；文件损坏时服务会拒绝启动并提示，而不会覆盖它。

## 4. Streaming and the security boundary

- All clients use the Python `/api/stream?key=…` endpoint. Python forwards OSS byte ranges (206 and 416); it does not expose OSS credentials/signed links or fetch whole songs into client-side Blobs. Private buckets need no browser-facing OSS CORS policy.
- Only audio objects under `OSS_PREFIX` are readable; traversal is rejected. Logs redact credentials and signatures. The UI reports redacted errors, while server logs retain diagnostic error codes/RequestIds.
- 数据接口在路由注册时统一挂上鉴权依赖：`/api/config`、`/api/tracks`、`/api/tracks/meta`、`/api/stream` 全部需要有效 JWT。新增数据路由请注册到 `api` 路由器上，否则会默认公开。
- `<audio>` 元素和原生媒体播放器无法设置请求头，因此 `/api/stream` 额外接受 `?token=` 查询参数。这使令牌出现在 URL 与 Range 请求中：服务只监听回环地址且访问日志默认关闭，若将来经反向代理暴露，必须同时关闭该代理的查询串日志。
- Host and exact-origin checks reduce unintended browser cross-site access. Writes additionally require `X-Player-Client: web`, a public marker that anyone can send, **not a credential** — the JWT is the credential.
- 登录失败在单进程内限流：5 分钟累计 5 次失败后返回 429。限流窗口是全局的，不区分来源 IP。
- 客户端只在本机存储里按服务地址保存令牌：任何数据请求收到 401 就立即丢弃该令牌、停止播放并退回登录页；侧栏的“退出登录”做同一件事。密码只用于换取令牌，从不落盘。
- Use a dedicated read-only OSS identity. TLS, CORS, Host checks, and security headers are defense in depth, not a substitute for the login. Monitor OSS usage, bandwidth, and spending alerts.
- JSON metadata requires **one local application instance and one Uvicorn worker**. Do not run two local backend processes against the same library file.

## 5. Android and iOS apps

The generated source projects are `frontend/android` and `frontend/ios`, with ID **com.mediaplayeross.app**, display name **OSS 音乐**, and `webDir: dist`. The app contains local Web assets: there is no `server.url`, remote-page wrapper, global cleartext allowance, or ATS bypass. HTTPS APIs/media with a valid system-trusted certificate are supported.

On first launch, enter the server's HTTPS **origin**, for example `https://music.example.com`. Credentials, paths, queries, and fragments are rejected; a nondefault port is allowed. The app then asks for the username and password and stores the returned JWT **per server origin**, so switching servers does not carry a token across them. The app's connection settings can switch servers, stopping old playback and clearing old-server tracks/progress. Web always uses its own origin, even if a native default is configured.

原生客户端登录依赖两项服务端配置：`ALLOWED_ORIGINS` 必须包含 `capacitor://localhost` 与 `https://localhost`，并且服务端 CORS 已放开 `POST` 方法和 `Authorization` 请求头（本项目默认如此）。

To prefill a public native default, copy `frontend/.env.example` to the ignored `frontend/.env.local` and set `VITE_API_BASE_URL`, or pass it when preparing:

```bash
VITE_API_BASE_URL=https://music.example.com npm --prefix frontend run android:prepare
VITE_API_BASE_URL=https://music.example.com npm --prefix frontend run ios:prepare
```

These variables are compiled into the app, not backend runtime settings and never secrets. `VITE_ALLOW_HTTP_DEV=true` is effective only in Vite development mode and is ignored by packaged builds. The shipped native transport policies still block HTTP; use a trusted HTTPS development server rather than weakening release policies. Loopback on a phone is the phone, not the development computer.

### Reproducible scripts

Run `npm --prefix frontend ci` after checkout. The native source projects already exist: **do not run add over them**. Each prepare/build command below compiles the Web bundle first; sync-only commands reuse an existing bundle without building it.

| npm script (with `npm --prefix frontend run`) | Action |
| --- | --- |
| `native:add:android` | Generate Android with `cap add android`, only when the platform folder does not exist. |
| `native:add:ios` | Generate iOS with `cap add ios --packagemanager SPM`, only when absent. |
| `native:sync` | `cap sync`: restore both platforms' copied Web assets and generated plugin/config files from `dist`. |
| `android:sync` / `ios:sync` | Sync one platform without a Web build. |
| `android:prepare` / `ios:prepare` | Existing `build` script (typecheck + Vite), then platform sync. |
| `android:open` / `ios:open` | Open Android Studio / Xcode; no implicit build. Prepare first after source changes. |
| `android:debug` | Prepare, then Gradle `:app:assembleDebug --no-daemon`. |
| `android:release` | Prepare, then `:app:assembleRelease :app:bundleRelease --no-daemon`; unsigned until you configure signing. |
| `ios:simulator` | Prepare, then Xcode Debug build for generic iOS Simulator, without signing. |
| `ios:archive` | Prepare, then a Release archive for generic iOS with `CODE_SIGNING_ALLOWED=NO`; **not an installable IPA**. |

`frontend/scripts/native-build.mjs` resolves paths relative to itself, selects the checked-in Gradle wrapper or `xcodebuild`, propagates failures, and does not install system toolchains. Native build outputs, copied Web assets/config, local SDK paths, signing materials, caches, and IDE user state are ignored. Gradle wrapper JAR/scripts and native source/resource projects must stay in version control. After a fresh checkout, build + sync restores the ignored resources. Sync does not compile an app.

### Android development and release signing

Requires Android Studio **2025.2.1+**, Java **21**, SDK platform **36** and compatible build tools; minimum device API is **24**. The generated project pins Android Gradle Plugin **8.13.0** and Gradle wrapper **8.14.3**. Configure the SDK through Android Studio or a private `frontend/android/local.properties`; never commit machine paths. First Gradle/Xcode dependency resolution needs network access.

```bash
npm --prefix frontend run android:debug
npm --prefix frontend run android:open
```

The debug artifact is `frontend/android/app/build/outputs/apk/debug/app-debug.apk`, automatically debug-signed by Android tooling when built. It is for local development, not release distribution. Select an emulator/device in Android Studio to install and test HTTPS connection, playback, seek, favorites, editing, and server switching.

For a release, increment `versionCode`/`versionName` in `frontend/android/app/build.gradle`, prepare the app, then use Android Studio **Build → Generate Signed App Bundle or APK**. Supply your privately stored keystore, choose the release variant and APK/AAB, and retain the same signing key for future updates. Do not put passwords in npm scripts or shell history. The CLI release script creates unsigned outputs under `app/build/outputs/apk/release` and `app/build/outputs/bundle/release` unless you explicitly configure private release signing. Keep keystores and their backups outside the repository. Store upload is outside this delivery.

### iOS development and distribution

Requires macOS with **Xcode 26+** and its iOS SDK. Minimum deployment target is **iOS 15**. This is a **Swift Package Manager** project: open `frontend/ios/App/App.xcodeproj`, not a CocoaPods workspace. `CapApp-SPM/Package.swift` pins Capacitor to 8.5.3; no CocoaPods installation is required.

```bash
npm --prefix frontend run ios:simulator
npm --prefix frontend run ios:open
# Optional unsigned archive for build review, not device installation:
npm --prefix frontend run ios:archive
```

Simulator output is under `frontend/ios/App/build/DerivedData/Build/Products/Debug-iphonesimulator/App.app`; the unsigned archive is `frontend/ios/App/build/OSS-Music.xcarchive`. A simulator runtime must be installed to run the app, independently of whether a generic simulator build succeeds.

For a physical device, select your Apple development team in Xcode **Signing & Capabilities**, keep the bundle ID registered to that team, select the device, and run with your own certificate/profile. For a signed archive, update the target's marketing/build versions, prepare again, choose a generic iOS device and **Product → Archive**, then use Organizer's distribution/export workflow appropriate to your Apple account. The unsigned archive script deliberately does not perform this signing workflow. Do not commit team-specific certificates, profiles, export credentials, or private keys. TestFlight/App Store submission and Apple account setup are not included.

Codec availability, autoplay, media keys, volume behavior, interruptions, and suspension differ between Android WebView and WKWebView. Verify each platform on a device; no background/lock-screen/offline guarantees are made. Generated icons/splash assets are starter resources, not a store-branding acceptance.

## 6. Local troubleshooting and verification

- **List access denied:** check bucket-level `oss:ListObjects`; object reads require `oss:GetObject` under the correct prefix. Expired STS credentials must be renewed on the server, never shipped to the app.
- **所有接口返回 503「服务尚未配置登录凭据」：** `backend/.env` 缺少 `AUTH_USERNAME` / `AUTH_PASSWORD_HASH` / `JWT_SECRET_KEY` 中的至少一项，启动日志会列出具体缺哪一项。补齐后重启服务。
- **登录返回 401 但密码确认正确：** `AUTH_PASSWORD_HASH` 必须是 bcrypt 哈希而非明文；重新生成哈希时注意 shell 会对 `$` 做替换，dotenv 里的哈希不要加双引号。
- **登录返回 429：** 5 分钟内失败达 5 次触发限流，稍候重试或重启服务清空窗口。
- **播放中途失败且提示重新登录：** JWT 已过期（默认 1 天）。重新登录即可；如需更长有效期调整 `JWT_EXPIRE_MINUTES`。
- **403 requests:** check the exact Host/origin arrays and `X-Player-Client: web` for writes. Do not fix this by wildcard CORS or weakening Host validation.
- **App connects but audio fails:** check both native origins are allowed, the server's certificate chain is trusted, and the device supports that codec. WAV/FLAC/OGG/Opus support differs between WebViews. Use isolated test metadata for device acceptance.
- **Certificate errors:** verify the development server's full chain, domain, expiration, and system trust. Install enterprise roots through approved OS mechanisms; do not disable certificate validation.
- **Cannot save metadata:** check local directory write/search access and file permissions. Corrupt JSON causes a startup error rather than silently overwriting the file.

For a separate verification phase, after dependency installation (or simply `./run.sh test`):

```bash
(cd backend && uv run --locked python -m pytest -q && uv run --locked python -m ruff check .)
npm --prefix frontend run test
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

The startup regression coverage uses stubs to check system-trust initialization before Uvicorn, fixed loopback/single-worker settings despite process-environment overrides, failure before listening when trust initialization fails, and import without TLS mutation or starting the server. It does not open a listening socket during the re-executed entry point.

No signed APK/IPA, simulator/device acceptance, actual OSS integration acceptance, or Apple/Google account setup is included. Those require separate verification and owner-provided signing credentials.

### Layout and official references

```text
run.sh                     Local launcher: setup / start / dev / backend / frontend / build / release / test
backend/                   Python API (deploy this folder as the server)
  app.py                   HTTP API, byte streaming, health and optional local Web serving
  auth.py                  Login endpoint, JWT issuing and the require_auth dependency
  config.py                Exact Host/origin validation and backend-relative paths
  library.py               Shared local JSON overrides and favorites
  oss_store.py             Read-only OSS catalog/listing/Range access
  security.py              Error redaction
  logs.py                  Log and credential redaction
  requirements.txt         Committed hash-pinned runtime deps exported from uv.lock (pip on the ECS)
  .env / data/             Ignored local configuration and library
  tests/                   Backend regression tests
frontend/                  React Web/App UI (build/package this folder)
  src/                     Shared UI, login screen, API client, playback, connection settings
  android/  ios/           Generated native Android sources + Gradle wrapper / Xcode + SPM sources
  scripts/                 Native build command wrapper
  dist/                    Committed Web build (served locally by the backend; deployed as-is to the ECS)
  tests/                   Frontend regression tests
deploy/                    ECS deployment: install.sh (run on the server from a git clone), systemd unit, Nginx site
```

Official references: [Capacitor 8 setup](https://capacitorjs.com/docs/getting-started/environment-setup), [Capacitor workflow](https://capacitorjs.com/docs/basics/workflow), [Android command-line builds](https://developer.android.com/build/building-cmdline), [Xcode build/archive](https://developer.apple.com/library/archive/technotes/tn2339/_index.html), [uv project environments](https://docs.astral.sh/uv/guides/projects/), and [Uvicorn settings](https://uvicorn.dev/settings/).

## 7. 部署到 ECS

服务器上用 Python 虚拟环境 + systemd 运行 FastAPI（仍只监听 `127.0.0.1:8767`、单 worker），Nginx 监听 80 端口：静态托管 `frontend/dist`，并把 `/api/` 和 `/healthz` 反向代理给后端。目标系统是 Ubuntu 24.04（自带 Python 3.12）。

部署方式：登录 ECS，`git clone` 仓库后在服务器上运行 `deploy/install.sh`。服务器只需要 nginx、python3（3.12）和 git，不需要 Node.js：Web 端直接使用仓库里提交的 `frontend/dist`，Python 依赖来自提交的 `backend/requirements.txt`。脚本只部署**已提交**的内容（`git archive HEAD`），工作区里未提交的改动会给出警告但不会被部署。

### 本机：准备发布

修改了前端代码或后端依赖后，先在本机生成发布产物并提交：

```bash
./run.sh release   # 构建 frontend/dist，并从 uv.lock 导出 backend/requirements.txt
./run.sh test      # 同时会检查 requirements.txt 与 uv.lock 是否一致
../sync-to-github.sh   # 同步到 GitHub 镜像目录 ai-oss-github（会包含 frontend/dist）
cd ../../ai-oss-github && git add -A && git commit -m "..." && git push   # ECS 从这个仓库 clone
```

### ECS：首次部署

首先在 ECS 安全组放行 **TCP 80** 入方向。

```bash
git clone https://github.com/duliu1990/ai-oss.git
cd ai-oss/media-player-oss
sudo deploy/install.sh
```

公网 IP 会从阿里云元数据服务自动获取，并保存到 `/etc/media-player-oss/server_name`；也可以用 `sudo SERVER_NAME=<公网 IP 或域名> deploy/install.sh` 手动指定。

第一次运行时会生成 `/etc/media-player-oss/backend.env`，其中服务器路径、`ALLOWED_HOSTS` 和随机的 `JWT_SECRET_KEY` 已经填好。随后配置检查会失败并提示补全配置，这是预期行为。按提示编辑该文件：

```bash
deploy/install.sh hash-password             # 输入两次密码，输出 AUTH_PASSWORD_HASH=...
sudo nano /etc/media-player-oss/backend.env # 填写 OSS_*、AUTH_USERNAME、AUTH_PASSWORD_HASH
sudo deploy/install.sh                      # 再次部署
```

推荐使用同地域的 OSS 内网 Endpoint，流量不经公网，例如 `OSS_ENDPOINT=https://oss-cn-chengdu-internal.aliyuncs.com`。部署成功后在浏览器打开 `http://<公网 IP>/`。

### ECS：更新与运维

```bash
git pull && sudo deploy/install.sh   # 部署最新提交
sudo deploy/install.sh rollback      # 切回上一个版本
sudo deploy/install.sh status        # 当前版本、已保留版本与 systemd 状态
sudo deploy/install.sh logs          # 跟踪后端日志
```

修改 `backend.env` 后，执行 `sudo systemctl restart media-player-oss` 或重新部署即可生效。如果服务器访问 PyPI 较慢，可以换用镜像：`sudo PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ deploy/install.sh`。依赖带哈希校验，换镜像不影响完整性。

`install.sh` 依次执行以下步骤：

1. 安装缺少的 nginx / git / curl / python3-venv（Ubuntu 默认的 python3 不带 venv）。
2. 创建系统用户 `media-player`。
3. 从 `HEAD` 导出 `backend/`、`deploy/`、`frontend/dist` 到新的版本目录，建 venv 并按哈希安装依赖，然后以服务用户检查配置：登录配置缺失或 `ALLOWED_HOSTS` 不含公网地址时，在切换之前就停止部署。
4. 安装 systemd unit 和 Nginx 站点，并执行 `nginx -t`。
5. 原子切换 `current` 链接，重启服务，再经 Nginx 检查 `/healthz`、首页和未登录的 `/api/tracks`（应返回 401）。

检查失败时自动回滚到上一个版本；首次部署失败则停止服务。构建中途失败不会留下半成品目录。服务器保留最近 3 个版本。

| 服务器路径 | 内容 |
| --- | --- |
| `/opt/media-player-oss/releases/<id>/` | 每个版本的 `backend/`、`venv/`、`web/`（只读） |
| `/opt/media-player-oss/current` | 指向当前版本 |
| `/var/www/media-player-oss` | → `current/web`，Nginx 根目录 |
| `/etc/media-player-oss/backend.env` | 服务器配置与密钥（root:media-player 0640） |
| `/var/lib/media-player-oss/library.json` | 曲库元数据和收藏；首次为空，之后一直以服务器上的为准（本机 `backend/data/` 不进仓库） |
| `/etc/systemd/system/media-player-oss.service` | systemd unit（带沙箱加固） |
| `/etc/nginx/sites-available/media-player-oss` | 站点配置；`server_name` 是公网 IP，系统默认站点保持不动 |
| `/etc/media-player-oss/server_name` | 部署时使用的公网 IP 或域名 |

生成的服务器 env 与 `.env.example` 有以下不同：`ALLOWED_HOSTS` 设为公网地址和回环地址，`LIBRARY_FILE` 与 `FRONTEND_DIST` 改为服务器路径，`ENABLE_DEV_ORIGIN=false`。该文件只在不存在时生成，之后的部署不会覆盖它。`/api/stream?token=…` 会在 URL 中携带 JWT，所以 Nginx 访问日志只记录 `$uri`，不记录查询串；登录接口在 Nginx 层还额外按 IP 限流。

**当前只有 HTTP：** 登录密码和令牌以明文传输，原生 App 也只接受 HTTPS 服务器。接入域名和证书的步骤：

1. 准备一个已完成 ICP 备案的域名，解析到 ECS。
2. 把域名加入 `/etc/media-player-oss/backend.env` 的 `ALLOWED_HOSTS`，然后执行 `sudo SERVER_NAME=music.example.com deploy/install.sh`。
3. 申请证书，并在 `deploy/nginx.conf` 中加入 `listen 443 ssl` 和证书路径。不要只在服务器上执行 `certbot --nginx`：每次部署都会用仓库里的模板重写站点文件，certbot 改过的内容会被覆盖。
4. Web 端仍是同源访问，后端会从 `X-Forwarded-Proto` 识别 HTTPS，无需修改 `ALLOWED_ORIGINS`。原生 App 需要后者包含两个原生 origin，见第 5 节。
