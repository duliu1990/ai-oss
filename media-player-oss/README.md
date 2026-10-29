# 轻听 · Media Player OSS

**首次部署请阅读：[中文部署手册](DEPLOYMENT.md)** — ECS 准备、Nginx HTTPS、Python 启动、可选 systemd、验收与备份更新。

A personal music player for private Aliyun OSS audio: React + TypeScript on the Web, the same UI packaged locally with Capacitor 8 for Android/iOS, and a Python/FastAPI streaming backend. It complements [media-to-oss](../media-to-oss): upload there, listen here.

**Public anonymous access is intentional. There is no login, account, password, or application token. Anyone who can reach the service can listen, rename tracks, change favorites, and generate OSS/ECS charges. HTTPS, CORS, Host checks, and the client header are not authentication.**

- 列出 `OSS_PREFIX` 下的全部音频（mp3 / m4a / aac / ogg / opus / wav / flac），自动翻页，按上传时间倒序。
- 通过本机服务**按字节范围转发** OSS 数据：拖动进度条秒开，不需要公共读 Bucket、不需要配置 CORS，浏览器也拿不到签名链接或密钥。
- 播放 / 暂停、上一首 / 下一首、进度拖动、音量与静音、随机播放、列表循环 / 单曲循环 / 顺序播放。
- 曲名、歌手、时长自动读取 media-to-oss 写在 OSS 上的 `catalog.json`；也可以在本机改名、收藏到“我喜欢”、搜索与排序，本机信息保存在 `data/library.json`，**不会修改 OSS 上的任何文件**。
- Device-local volume, playback mode, last track, and position are remembered without autoplay. This release covers foreground playback only: no offline download, background-playback guarantee, or lock-screen controls. The legacy browser Media Session integration (system metadata, playback state/position, and media-key actions) is intentionally not migrated in this release; in-page controls, position restoration, and keyboard shortcuts remain.
- 快捷键：`空格` 播放/暂停，`←` / `→` 快退/快进 5 秒，`/` 聚焦搜索框。

## 1. Local Web startup and development

### Requirements

| Tool | Requirement |
| --- | --- |
| Python / uv | Python 3.12.x only; uv 0.7.13 or later with lockfile support. |
| Node / npm | Node 24 recommended (package minimum 22.12); npm 10+. Implementation used Node 24.2.0 and npm 11.3.0. |
| Frontend | React 19.3.1, Vite 8.3.4, TypeScript 5.9.3, Vitest 5.0.5; use the npm lockfile. |
| Native | Capacitor core/CLI/Android/iOS are all pinned to 8.5.3; see section 5. |
| Production ingress | Nginx with HTTP SSL support; configuration targets 1.27.5 and requires at least 1.19.4 for rejecting unknown TLS names. |

Run from the repository root. Preserve an existing `.env`; otherwise create one from the example and fill in OSS settings. A configuration copied from media-to-oss is also supported; unknown backend fields are ignored.

```bash
uv sync --locked --python 3.12
npm --prefix frontend ci
npm --prefix frontend run build
test -f .env || cp .env.example .env
chmod 600 .env
# Edit .env before starting; never overwrite an existing working configuration.
uv run --locked python app.py
```

Open **http://127.0.0.1:8767**. Python serves `frontend/dist`; building it is required. An absent build returns 503, not the old `static/` UI. The index is `no-store`, hashed `/assets` files are immutable, and unknown assets/API paths return 404. Restart Python after changing its environment. Port 8767 does not conflict with media-to-oss on 8765.

Use this same `uv run --locked python app.py` entry point locally and on ECS. It initializes `truststore` so OSS HTTPS requests use the operating system's trusted certificate store before Uvicorn starts. Direct `uvicorn app:app` skips that initialization. The launcher fixes one worker, binds only `127.0.0.1:8767`, and trusts proxy headers only from `127.0.0.1`; process environment cannot widen that proxy trust or worker count. If uv itself needs enterprise system CAs while downloading dependencies, use its `--native-tls` option; never disable TLS verification.

For React hot reload, instead run these in two terminals from the root:

```bash
# Terminal 1: this flag adds exactly http://127.0.0.1:5173.
ENABLE_DEV_ORIGIN=true uv run --locked python app.py
# Terminal 2:
npm --prefix frontend run dev
```

Open **http://127.0.0.1:5173** (not `localhost:5173`). Vite forwards `/api` to port 8767, preserving Origin and Range. Development uses two processes; production uses Nginx for the built Web files and one Python API process, with no Node server. Keep local listeners on loopback.

## 2. 配置

| 配置项 | 说明 |
| --- | --- |
| `OSS_ENDPOINT` | 必填；Bucket 所在地域的 HTTPS Endpoint，例如 `https://oss-cn-hangzhou.aliyuncs.com` |
| `OSS_BUCKET` | 必填；Bucket 名称 |
| `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | 必填；RAM 用户或 STS 临时凭据 |
| `OSS_SECURITY_TOKEN` | 使用 STS 临时凭据时填写 |
| `OSS_PREFIX` | 只读取该前缀下的音频，默认 `media/`，与 media-to-oss 保持一致 |
| `LIBRARY_FILE` | 本机曲库（曲名、歌手、收藏）文件，默认 `data/library.json`，相对路径基于项目目录 |
| `LOG_LEVEL` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |
| `FRONTEND_DIST` | Python's built Web directory; default `frontend/dist`, resolved from the project root. Nginx has a separate explicit `root`, not an environment-variable substitution. |
| `ALLOWED_HOSTS` | JSON array of exact lowercase DNS/IPv4 hosts, without scheme, wildcard, or port. Default: `["localhost","127.0.0.1"]`. Add the public domain; retain `127.0.0.1` for health checks. |
| `ALLOWED_ORIGINS` | JSON array of exact canonical origins, no path, trailing slash, or default port. Native apps require `["capacitor://localhost","https://localhost"]`; Web-only can use `[]`. Same-origin Web needs no extra entry. |
| `ENABLE_DEV_ORIGIN` | Default `false`; `true` adds only `http://127.0.0.1:5173`. Keep `false` in production. |

Examples use single-quoted JSON in dotenv files. These quotes are removed by the dotenv parser, not sent as part of the JSON. The application reads the root `.env` directly; do not source it as a shell script or put credentials in frontend variables. In a remote deployment, the “local” metadata described below lives on the **server**, shared by Web and App clients; playback preferences remain on each device.

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

1. 本机 `data/library.json` 中手动填写的曲名 / 歌手（点击曲目右侧的 ✎；留空保存即恢复 catalog 中的名称）；
2. `catalog.json` 中的 `title` / `artist`；
3. 文件名：随机名显示为“未命名音频 d95ecc”，有意义的文件名（如 `media/album/夜曲.mp3`）直接显示。

播放器对 `catalog.json` **只读**，不需要额外权限（它在 `media/*` 下，已包含在 `oss:GetObject` 中）。文件不存在时按文件名显示；损坏或读取失败时列表照常可用，顶部会提示原因。

本机曲库文件只是 JSON，可以备份或手动编辑；文件损坏时服务会拒绝启动并提示，而不会覆盖它。

## 4. Streaming and the anonymous security boundary

- All clients use the Python `/api/stream?key=…` endpoint. Python forwards OSS byte ranges (206 and 416); it does not expose OSS credentials/signed links or fetch whole songs into client-side Blobs. Private buckets need no browser-facing OSS CORS policy.
- Only audio objects under `OSS_PREFIX` are readable; traversal is rejected. Logs redact credentials and signatures. The UI reports redacted errors, while server logs retain diagnostic error codes/RequestIds.
- Host and exact-origin checks reduce unintended browser cross-site access. Writes require `X-Player-Client: web`, a public marker that anyone can send, **not a credential**. Nonbrowser clients can access the service anonymously.
- Use a dedicated read-only OSS identity. An Internet-facing service exposes listening access and shared metadata changes to everyone who can reach it. Domain secrecy, TLS, CORS, and security headers do not make it private. Monitor usage, bandwidth, and spending alerts.
- OSS request/egress charges, ECS bandwidth/compute/storage, domain costs, and abuse can all incur fees. A same-region ECS instance may use the matching HTTPS OSS internal endpoint to reduce OSS-side external egress; client-facing ECS bandwidth is still billable.
- JSON metadata requires **one application instance and one Uvicorn worker**. Do not run overlapping deployments or rolling updates with two writers, including simultaneous manual and systemd launches. No database, Redis, Kubernetes, or second business service is needed.

## 5. Android and iOS apps

The generated source projects are `frontend/android` and `frontend/ios`, with ID **com.mediaplayeross.app**, display name **OSS 音乐**, and `webDir: dist`. The app contains local Web assets: there is no production `server.url`, no remote-page wrapper, no global cleartext allowance, and no ATS bypass. HTTPS APIs/media with a valid system-trusted certificate are supported.

On first launch, enter the server's HTTPS **origin**, for example `https://music.example.com`. Credentials, paths, queries, and fragments are rejected; a nondefault port is allowed. The app's connection settings can switch servers, stopping old playback and clearing old-server tracks/progress. Web always uses its own origin, even if a native default is configured.

To prefill a public native default, copy `frontend/.env.example` to the ignored `frontend/.env.local` and set `VITE_API_BASE_URL`, or pass it when preparing:

```bash
VITE_API_BASE_URL=https://music.example.com npm --prefix frontend run android:prepare
VITE_API_BASE_URL=https://music.example.com npm --prefix frontend run ios:prepare
```

These variables are compiled into the app, not backend runtime settings and never secrets. `VITE_ALLOW_HTTP_DEV=true` is effective only in Vite development mode and is ignored by production builds. The shipped native transport policies still block HTTP; use a trusted HTTPS development server rather than weakening release policies. Loopback on a phone is the phone, not the development computer.

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

## 6. ECS: Nginx static files and a loopback Python API

Production topology: browser/App → HTTPS Nginx → `127.0.0.1:8767` for API/media; Nginx reads Web files directly from `/opt/media-player-oss/frontend/dist`. Python retains its static routes for local use. There is no Node runtime server, alternate container deployment, or extra Python launcher. systemd is optional.

The following are **operator steps**, not commands executed during this deployment-source change. The ECS distribution has not been selected, so confirm package names, worker identity, configuration includes, and security policy on that host before installation.

### Step 1: prepare Linux dependencies and the frontend

- Ubuntu/Debian commonly use `apt` (`apt update`, then `apt install nginx ca-certificates`); Alibaba Cloud Linux/Rocky commonly use `dnf install nginx ca-certificates`. These are examples to confirm for the chosen release, not a universal installer. Install an appropriate uv, Python 3.12, and Node/npm separately; distribution defaults may not meet the versions in section 1.
- Provision a dedicated non-root `media-player` user/group using the distribution's account tools. Examples below use it as the runtime identity. Make uv and its cache available to this identity if using the manual command; do not rely on an administrator's private home or PATH. Dependency preparation and the manual `uv run` must have the needed virtual-environment permissions.
- Place reviewed source at `/opt/media-player-oss`. Prepare the virtual environment **on Linux**; never upload a macOS `.venv`. The Python 3.12 executable resolved by `.venv/bin/python`, all its parent directories, and its standard library must be readable/traversable by the service user. Use a system/shared interpreter installation, not an inaccessible administrator-only uv download directory.

From `/opt/media-player-oss`, prepare the dependencies and Web output:

```bash
uv sync --locked --python 3.12
npm --prefix frontend ci
npm --prefix frontend run build
```

Alternatively, build using the same source/lockfiles on a build machine and upload **the complete `frontend/dist` directory** to that exact location. The ECS host then needs neither Node/npm nor a frontend build. Native compilation is not needed for the Web server. Do not upload local secrets, libraries, caches, or native signing material with the artifact.

### Step 2: configure the root environment and persistent data

Create `.env` only if absent, fill in OSS settings and the deployment values below, then give the runtime user private access:

```bash
test -f .env || cp .env.example .env
# Edit .env; preserve existing credentials and settings.
sudo chown media-player:media-player .env
sudo chmod 600 .env
sudo install -d -m 0700 -o media-player -g media-player /var/lib/media-player-oss
```

```dotenv
ALLOWED_HOSTS='["music.example.com","127.0.0.1"]'
ALLOWED_ORIGINS='["capacitor://localhost","https://localhost"]'
ENABLE_DEV_ORIGIN=false
LIBRARY_FILE=/var/lib/media-player-oss/library.json
FRONTEND_DIST=frontend/dist
```

Replace the public domain both here and in the Nginx configuration; neither config edits the other. Host entries are exact DNS names/IPs without ports. Native origins are exact and canonical; same-origin Web requires no CORS entry. Keep all OSS secrets in the backend `.env`, never `VITE_*`. Process environment can override application settings, so remove stale exported application values. Python reads `.env` itself; no shell sourcing or systemd `EnvironmentFile` is required.

The **data directory**, not just the JSON, must belong to `media-player` and be writable: saves create a neighboring private temporary file and replace the JSON atomically. Keep existing library files private (0600) and owned by that user. The root example still uses `data/library.json` for local use; production should use the absolute path above.

For an existing library, stop its old writer first, take a protected backup, and explicitly copy it only into a verified empty destination. Never let an installation/update overwrite an existing destination. For a new library, leave the destination empty; the first metadata write creates it. There is no OSS catalog migration: local edits still override catalog metadata, which remains read-only.

Nginx's worker is commonly `www-data` on Ubuntu/Debian or `nginx` on Alibaba Cloud Linux/Rocky; confirm the actual `user` directive. Grant that identity only directory traversal on the project/frontend parents and read/search access to the built static tree, using scoped group permissions or ACLs. Do not add it to the private runtime group or grant it access to `.env`, `/var/lib/media-player-oss`, or backups. Do not recursively broaden permissions on the project. The configured static path and all ancestors must be real directories, not release symlinks, because Nginx checks every path component.

On SELinux-enforcing hosts, persist the static tree's `httpd_sys_content_t` labeling with the distribution's `semanage fcontext` and `restorecon` tools, and authorize Nginx's loopback connection to `127.0.0.1:8767` under the target policy. Review audit denials and parent-directory labels. Some distributions offer `httpd_can_network_connect`, which permits broader network access; approve its scope or use a scoped local policy. Confirm exact policy/package commands after selecting the distribution. Do not disable SELinux or use `chmod 777`.

### Step 3: start Python with one command

Run from `/opt/media-player-oss` as the prepared runtime user, with no other writer running:

```bash
uv run --locked python app.py
```

This stays in the foreground and listens only on `127.0.0.1:8767`. It uses one worker, explicitly enables proxy-header handling, trusts only the loopback peer, and preserves system certificate initialization. Do not replace it with a direct Uvicorn command. `/healthz` makes no OSS request; a healthy response does not verify OSS credentials. Do not start a second manual or supervised instance against the same library.

### Step 4: install the Nginx HTTPS entry point

The operator owns domain registration/DNS, certificate issuance and renewal, and ECS security-group/firewall setup. Point the domain at the host (publish AAAA only with working IPv6). Expose **TCP 80/443 only** for this application, not **8767/5173**; restrict administrative access separately. Allow the required outbound DNS/HTTPS for OSS and the chosen certificate workflow.

Supply a valid full certificate chain and protected private key at:

- `/etc/nginx/tls/music.example.com/fullchain.pem`
- `/etc/nginx/tls/music.example.com/privkey.pem`

Keep keys outside the repository, readable only by the privileged Nginx startup process as required. This configuration does not issue or renew certificates and does not provide an ACME HTTP challenge route. Arrange a suitable issuance/renewal method and a successful Nginx validation/reload after renewal. Never disable client certificate validation.

Inspect the existing main configuration instead of overwriting it. It must include `mime.types` and `/etc/nginx/conf.d/*.conf` **inside its `http` block**, once. Ubuntu/Debian may also enable `sites-enabled/default`; other distributions may ship a default server inside their main config. Review and reconcile conflicting default listeners so unknown hosts are rejected, without disrupting unrelated sites. There must be only one rejecting default per address/port. If IPv6 is disabled, adapt both default and domain listeners consistently. Audit inherited global headers, proxy settings, error pages, and real-IP rules: this sample assumes direct client connections, not a trusted upstream CDN/load balancer.

After replacing `music.example.com` in the site, **including the Host-map regular expression**, and checking certificate paths, install exactly these files (do not wildcard-copy both into `conf.d`):

```bash
sudo install -d -m 0755 /etc/nginx/conf.d /etc/nginx/snippets
sudo install -m 0644 deploy/nginx/media-player-oss.conf /etc/nginx/conf.d/media-player-oss.conf
sudo install -m 0644 deploy/nginx/media-player-oss-static.conf /etc/nginx/snippets/media-player-oss-static.conf
sudo nginx -t
# Only after a successful check, reload the already-running Nginx service:
sudo systemctl reload nginx
```

If Nginx is not running yet, start it using the selected distribution's service manager after a successful check. `nginx -s reload` is an alternative only when it addresses the correct existing master/configuration. Installing files alone does not activate them. The snippet must not be loaded by the top-level `conf.d/*.conf` include.

Configuration behavior:

- Unknown HTTP Hosts are closed without serving the app; unknown TLS SNI is rejected. Legal HTTP requests redirect to the **fixed** HTTPS domain. TLS supports only 1.2/1.3. The raw Host is checked even after a valid SNI handshake; Nginx also preserves its nondefault port when forwarding it to Python.
- `/` and `/index.html` are `no-store`; an unavailable index returns a diagnostic 503. Only flat, content-hashed `/assets` filenames are served. Successful 200/206/304 assets are immutable for one year; asset errors are `no-store`. All other static paths, dotfiles, legacy paths, nested asset paths, and missing files return 404, without a global SPA fallback. Symbolic links cannot escape the build root.
- Every static location setting a cache header includes the complete CSP, `nosniff`, `no-referrer`, and `DENY` header snippet. Its policy matches Python, including same-origin media/connect and necessary inline styles. This avoids older Nginx header-inheritance pitfalls without new-version directives.
- Exact `/api`, prefix `/api/`, and exact `/healthz` proxy to the loopback API using HTTP/1.1 with **no trailing URI** on `proxy_pass`; original encoded query strings and `/api` paths are preserved. The full forwarding-header set is shared by all proxy locations. Client forwarding values are replaced, not appended; `Forwarded` and `Connection` are cleared. Only local peers are trusted by Python, so this is not a defense against a malicious local process.
- API caching, error interception, response buffering, and gzip are off. Timeouts are 5 seconds to connect, 60 seconds for ordinary upstream reads/sends and downstream sends, and 300 seconds between reads on exact `/api/stream`. Range/If-Range pass unchanged; no forced ranges or sliced cache is used. Backend 200/206/416 and Range response headers are preserved.
- OPTIONS reaches Python. Nginx does not add CORS or duplicate backend CSP. **Nginx-generated 502/504 responses may lack CORS headers**, so native WebViews may report a generic network/CORS error; inspect the proxy/backend logs rather than broadening allowed origins.

### Step 5: optional systemd supervision

Use this only after the Linux virtual environment, runtime identity, private configuration, and writable data directory are ready. Stop the foreground instance before enabling supervision and wait for it to exit. Then:

```bash
sudo install -m 0644 deploy/media-player-oss.service /etc/systemd/system/media-player-oss.service
sudo systemctl daemon-reload
sudo systemctl enable --now media-player-oss
sudo systemctl status media-player-oss --no-pager
sudo journalctl -u media-player-oss -n 100 --no-pager
```

The unit works from `/opt/media-player-oss` and directly executes `/opt/media-player-oss/.venv/bin/python /opt/media-player-oss/app.py` as `media-player:media-player`. It is `Type=simple`, restarts on failure after 5 seconds, uses `UMask=0077`, and sends logs to the journal. It does not install dependencies, activate a shell, or load an `EnvironmentFile`. Verify the interpreter symlink target and its parent access on Linux. A still-running but unhealthy process is not automatically restarted by this policy; configure monitoring separately. Journal and Nginx log retention are host responsibilities.

### Backups, upgrades, and version recovery

1. Record the current source/lockfile revision, interpreter/tool versions, built frontend artifact, and installed deployment configuration. Retain the previous reviewed source and build outside the live static tree. Protect backups of `.env`, data, and certificate material using the host's encrypted backup process.
2. Schedule a maintenance interruption. Stop the one Python writer (`systemctl stop media-player-oss` if supervised, or stop the manual foreground process) and wait for exit. Do not run old/new versions simultaneously. Make a private backup of `/var/lib/media-player-oss/library.json` if it exists; preserve ownership/permissions. Test recovery only on an isolated copy.
3. Deploy the selected reviewed source **without overwriting `.env` or the library**. Re-run `uv sync --locked --python 3.12`, `npm --prefix frontend ci`, and `npm --prefix frontend run build`, or upload that revision's complete frontend build. Publish the complete static tree during the maintenance window; do not expose a half-uploaded build or switch to a symlink that this configuration rejects. Reapply scoped permissions/SELinux labels as needed.
4. Start exactly one Python instance (the manual command or `systemctl start media-player-oss`). If Nginx configuration/certificates changed, run `nginx -t` successfully before reload. Verify HTTPS, health, metadata edits/favorites, Range/seek, and persistence after restart before ending maintenance.
5. To recover the prior code version, stop the writer, preserve a new backup, restore the retained source/lockfiles and matching frontend build, recreate/sync Linux dependencies as needed, and start one instance. Keep the current library unless compatibility requires an explicitly approved restore. Restoring an older JSON discards newer edits/favorites: back up the current file first, restore deliberately with runtime-user ownership and mode 0600, and never automate overwriting a real library.

## 7. Troubleshooting and verification boundary

- **List access denied:** check bucket-level `oss:ListObjects`; object reads require `oss:GetObject` under the correct prefix. Expired STS credentials must be renewed on the server, never shipped to the app.
- **403 behind HTTPS:** check the exact Host/origin arrays, forwarded scheme, proxy trust boundary, and `X-Player-Client: web` for writes. Do not fix this by wildcard CORS or weakening Host validation.
- **App connects but audio fails:** check both native origins are allowed, the server's certificate chain is trusted, and the device supports that codec. WAV/FLAC/OGG/Opus support differs between WebViews. Use isolated test metadata for device acceptance.
- **Certificate errors:** verify the operator-supplied full chain, domain, expiration/renewal, and system trust. Install enterprise roots through approved OS mechanisms; do not disable certificate validation.
- **Cannot save metadata:** check runtime-user ownership, directory write/search access, file permissions, and applicable SELinux policy. Corrupt JSON causes a startup error rather than silently overwriting the file.
- **Nginx 503/404 or JavaScript MIME errors:** check the complete build, exact `root`, `mime.types`, worker permissions/labels, and absence of symlinks. Do not expose the project root to fix a missing build.
- **Nginx 502/504:** check whether the single loopback Python process is running, its logs, and SELinux loopback-proxy permissions. Nginx gateway failures may lack CORS; do not add wildcard CORS to mask them.

For a separate verification phase, after dependency installation:

```bash
uv run --locked pytest -q
uv run --locked ruff check .
npm --prefix frontend run test
npm --prefix frontend run typecheck
npm --prefix frontend run build
# On the prepared target host, after installing config and certificates:
sudo nginx -t
```

The startup regression coverage uses stubs to check system-trust initialization before Uvicorn, fixed loopback/single-worker/proxy settings despite process-environment overrides, failure before listening when trust initialization fails, and import without TLS mutation or starting the server. It does not open a listening socket or read real deployment settings during the re-executed entry point.

**This deployment implementation changed source/configuration and regression code only. Tests, lint, typecheck/build, Nginx syntax/runtime checks, and service starts/stops were not executed in this phase.** Separate verification must exercise isolated HTTP/HTTPS proxying, cache/error headers, unknown Host/SNI, encoded queries, spoofed forwarding headers, native preflights, 200/206/416 streaming, and gateway failures without touching the existing service or real metadata. The configuration targets the available Nginx 1.27.5 syntax, but that is not a validation result. Linux systemd, permissions/SELinux, real ECS networking, and system-trusted certificates on physical devices require target-host acceptance.

No signed APK/IPA, simulator/device acceptance, actual OSS/ECS integration acceptance, certificate issuance, Apple/Google account setup, or store/ECS deployment is delivered. Those require the separate verification phase and operator-owned infrastructure/signing credentials.

### Layout and official references

```text
frontend/src/       Shared React Web/App UI, API client, playback, connection settings
frontend/android/   Generated native Android sources and Gradle wrapper
frontend/ios/       Generated Xcode + SPM sources
frontend/scripts/   Native build command wrapper
frontend/dist/      Ignored Web build; Nginx serves it in production
app.py              HTTP API, byte streaming, health and local Web serving
config.py           Exact Host/origin validation and project-relative paths
library.py          Shared local JSON overrides and favorites
oss_store.py        Read-only OSS catalog/listing/Range access
security.py         Error redaction
logs.py             Log and credential redaction
deploy/nginx/       HTTPS site and static-only security-header snippet
deploy/media-player-oss.service  Optional single-process systemd unit
tests/              Backend regression tests
frontend/tests/     Frontend regression tests
```

Official references: [Capacitor 8 setup](https://capacitorjs.com/docs/getting-started/environment-setup), [Capacitor workflow](https://capacitorjs.com/docs/basics/workflow), [Android command-line builds](https://developer.android.com/build/building-cmdline), [Xcode build/archive](https://developer.apple.com/library/archive/technotes/tn2339/_index.html), [uv project environments](https://docs.astral.sh/uv/guides/projects/), [Nginx proxy directives](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), [Nginx static path handling](https://nginx.org/en/docs/http/ngx_http_core_module.html#disable_symlinks), [Nginx TLS](https://nginx.org/en/docs/http/ngx_http_ssl_module.html), [systemd services](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), and [Uvicorn proxy settings](https://uvicorn.dev/settings/).
