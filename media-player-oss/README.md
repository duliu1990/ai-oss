# 轻听 · Media Player OSS

A personal music player for private Aliyun OSS audio: React + TypeScript on the Web, the same UI packaged locally with Capacitor 8 for Android/iOS, and a Python/FastAPI streaming backend. It complements [media-to-oss](../media-to-oss): upload there, listen here.

**Public anonymous access is intentional. There is no login, account, password, or application token. Anyone who can reach the service can listen, rename tracks, change favorites, and generate OSS charges. HTTPS, CORS, Host checks, and the client header are not authentication.**

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

Use the `uv run --locked python app.py` entry point locally. It initializes `truststore` so OSS HTTPS requests use the operating system's trusted certificate store before Uvicorn starts. Direct `uvicorn app:app` skips that initialization. The launcher runs one worker on `127.0.0.1:8767`. If uv itself needs enterprise system CAs while downloading dependencies, use its `--native-tls` option; never disable TLS verification.

For React hot reload, instead run these in two terminals from the root:

```bash
# Terminal 1: this flag adds exactly http://127.0.0.1:5173.
ENABLE_DEV_ORIGIN=true uv run --locked python app.py
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
| `LIBRARY_FILE` | 本机曲库（曲名、歌手、收藏）文件，默认 `data/library.json`，相对路径基于项目目录 |
| `LOG_LEVEL` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |
| `FRONTEND_DIST` | Python's built Web directory; default `frontend/dist`, resolved from the project root. |
| `ALLOWED_HOSTS` | JSON array of exact lowercase DNS/IPv4 hosts, without scheme, wildcard, or port. Default: `["localhost","127.0.0.1"]`. |
| `ALLOWED_ORIGINS` | JSON array of exact canonical origins, no path, trailing slash, or default port. Native apps require `["capacitor://localhost","https://localhost"]`; Web-only can use `[]`. Same-origin Web needs no extra entry. |
| `ENABLE_DEV_ORIGIN` | Default `false`; `true` adds only `http://127.0.0.1:5173` for Vite hot reload. |

Examples use single-quoted JSON in dotenv files. These quotes are removed by the dotenv parser, not sent as part of the JSON. The application reads the root `.env` directly; do not source it as a shell script or put credentials in frontend variables. Shared metadata lives in the backend's local `data/library.json`; playback preferences remain on each device.

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
- Use a dedicated read-only OSS identity. TLS, CORS, Host checks, and security headers do not make the app private. Monitor OSS usage, bandwidth, and spending alerts.
- JSON metadata requires **one local application instance and one Uvicorn worker**. Do not run two local backend processes against the same library file.

## 5. Android and iOS apps

The generated source projects are `frontend/android` and `frontend/ios`, with ID **com.mediaplayeross.app**, display name **OSS 音乐**, and `webDir: dist`. The app contains local Web assets: there is no `server.url`, remote-page wrapper, global cleartext allowance, or ATS bypass. HTTPS APIs/media with a valid system-trusted certificate are supported.

On first launch, enter the server's HTTPS **origin**, for example `https://music.example.com`. Credentials, paths, queries, and fragments are rejected; a nondefault port is allowed. The app's connection settings can switch servers, stopping old playback and clearing old-server tracks/progress. Web always uses its own origin, even if a native default is configured.

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
- **403 requests:** check the exact Host/origin arrays and `X-Player-Client: web` for writes. Do not fix this by wildcard CORS or weakening Host validation.
- **App connects but audio fails:** check both native origins are allowed, the server's certificate chain is trusted, and the device supports that codec. WAV/FLAC/OGG/Opus support differs between WebViews. Use isolated test metadata for device acceptance.
- **Certificate errors:** verify the development server's full chain, domain, expiration, and system trust. Install enterprise roots through approved OS mechanisms; do not disable certificate validation.
- **Cannot save metadata:** check local directory write/search access and file permissions. Corrupt JSON causes a startup error rather than silently overwriting the file.

For a separate verification phase, after dependency installation:

```bash
uv run --locked pytest -q
uv run --locked ruff check .
npm --prefix frontend run test
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

The startup regression coverage uses stubs to check system-trust initialization before Uvicorn, fixed loopback/single-worker settings despite process-environment overrides, failure before listening when trust initialization fails, and import without TLS mutation or starting the server. It does not open a listening socket during the re-executed entry point.

No signed APK/IPA, simulator/device acceptance, actual OSS integration acceptance, or Apple/Google account setup is included. Those require separate verification and owner-provided signing credentials.

### Layout and official references

```text
frontend/src/       Shared React Web/App UI, API client, playback, connection settings
frontend/android/   Generated native Android sources and Gradle wrapper
frontend/ios/       Generated Xcode + SPM sources
frontend/scripts/   Native build command wrapper
frontend/dist/      Ignored Web build served locally by Python
app.py              HTTP API, byte streaming, health and local Web serving
config.py           Exact Host/origin validation and project-relative paths
library.py          Shared local JSON overrides and favorites
oss_store.py        Read-only OSS catalog/listing/Range access
security.py         Error redaction
logs.py             Log and credential redaction
tests/              Backend regression tests
frontend/tests/     Frontend regression tests
```

Official references: [Capacitor 8 setup](https://capacitorjs.com/docs/getting-started/environment-setup), [Capacitor workflow](https://capacitorjs.com/docs/basics/workflow), [Android command-line builds](https://developer.android.com/build/building-cmdline), [Xcode build/archive](https://developer.apple.com/library/archive/technotes/tn2339/_index.html), [uv project environments](https://docs.astral.sh/uv/guides/projects/), and [Uvicorn settings](https://uvicorn.dev/settings/).
