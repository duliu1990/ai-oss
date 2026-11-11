# cloud-oss-ai（轻云）

cloud-oss（私有 OSS 网盘 + 笔记）与 media-player-oss（OSS 音乐播放器）合并后的单应用：一个 FastAPI 后端、一次登录、一个 SPA，外加 Capacitor iOS / Android 客户端。原来的两个项目保持不动，可以与本项目同时运行。

## 目录结构

```
cloud-oss-ai/
  backend/    FastAPI 服务
              app.py config.py auth.py logs.py library.py oss_store.py media_store.py
              routes/{files,notes,upload,media}.py  tests/  data/library.json
              pyproject.toml uv.lock .env.example .env
  frontend/   React + Vite 单页应用和 Capacitor 原生工程
              src/main.tsx        入口（Office / Markdown 预览页或主应用）
              src/shell/          AppShell：登录门、侧栏、模块切换、底部播放条
              src/shared/         公共组件与基础设施（Icon、Toast、Dialog、LoginPage、AppSidebar、http、tokens、connection …）
              src/modules/drive/  网盘与笔记
              src/modules/player/ 音乐播放器
              ios/ android/ scripts/native-build.mjs tests/
  deploy/cloud-oss-ai.conf        只代理后端的 nginx 站点文件
  run.sh                          本地启动脚本
```

## 端口

| 项目 | 地址 |
| --- | --- |
| cloud-oss-ai 后端（UI + API） | `http://127.0.0.1:8790` |
| cloud-oss-ai Vite 开发服务 | `http://127.0.0.1:5173` |
| cloud-oss / media-player-oss / media-to-oss（旧项目） | 8700 / 8767 / 8765 |

后端只监听 `127.0.0.1`，只信任来自 `127.0.0.1` 的 `X-Forwarded-*`。

## 环境变量（`backend/.env`）

完整注释见 `backend/.env.example`。`.env` 只放在后端，权限应为 600，不要提交。

| 变量 | 说明 |
| --- | --- |
| `OSS_ENDPOINT` `OSS_BUCKET` `OSS_ACCESS_KEY_ID` `OSS_ACCESS_KEY_SECRET` `OSS_SECURITY_TOKEN` | 三个模块共用的一套 OSS 凭证 |
| `OSS_PREFIX` | 网盘前缀，默认 `driver/` |
| `NOTE_OSS_PREFIX` | 笔记前缀，默认 `my-note/` |
| `MEDIA_OSS_PREFIX` | 音乐前缀，默认 `media/`；三个前缀不能互相重叠 |
| `PORT` | 默认 `8790` |
| `ALLOWED_HOSTS` | Host 头白名单（JSON 数组），对外部署时加上公网域名 |
| `ALLOWED_ORIGINS` | 允许的跨源来源；`capacitor://localhost` 是 iOS App，`https://localhost` 是 Android App |
| `ENABLE_DEV_ORIGIN` | 为 `true` 时额外允许 `http://127.0.0.1:5173`；`./run.sh dev` 会自动打开 |
| `LIBRARY_FILE` | 音乐收藏与元数据文件，默认 `data/library.json` |
| `FRONTEND_DIST` | 后端同端口提供的 Web UI，默认 `../frontend/dist` |
| `LOG_LEVEL` | 默认 `INFO`；日志会对凭证和 token 打码 |
| `AUTH_USERNAME` `AUTH_PASSWORD_HASH` `JWT_SECRET_KEY` | 登录三项，**必填**；缺任意一项时所有受保护接口返回 503 |
| `JWT_EXPIRE_MINUTES` | 登录有效期，默认 1440 |

生成密码哈希和密钥：

```bash
cd backend
uv run python -c 'import bcrypt,getpass; print(bcrypt.hashpw(getpass.getpass("Password: ").encode(), bcrypt.gensalt()).decode())'
uv run python -c "import secrets; print(secrets.token_urlsafe(32))"
```

前端只有一个公开的构建变量 `VITE_API_BASE_URL`（见 `frontend/.env.example`），仅作为原生 App 的默认服务器地址；默认留空，App 首次打开时会让你填写服务器地址。Web 端总是访问自己的源。

## 启动

需要 Python 3.12、`uv`、Node.js 22.12+ 和 npm。

```bash
./run.sh setup   # uv sync + npm ci；没有 backend/.env 时从示例复制
# 填写 backend/.env 里的 OSS 和登录设置
./run.sh         # 等同 ./run.sh dev：后端 :8790 + Vite :5173，Ctrl-C 两个一起停
```

| 命令 | 作用 |
| --- | --- |
| `./run.sh dev`（默认） | 后端带 `ENABLE_DEV_ORIGIN=true` 跑在 8790，Vite 跑在 5173 并代理 `/api` |
| `./run.sh start` | 前端源码有改动就重新构建 `frontend/dist`，然后由 8790 同时提供页面和 API |
| `./run.sh backend` / `./run.sh frontend` | 只启动一侧 |
| `./run.sh build` | typecheck + 构建 `frontend/dist` |
| `./run.sh test` | 后端 pytest + ruff，前端 vitest + typecheck |

页面路由用 URL hash：`#/files`（文件）、`#/notes`（笔记）、`#/music`（全部音乐）、`#/music/favorites`（我喜欢）。切到网盘时音乐继续播放，底部播放条在所有模块都可用。

## API 与安全边界

- 公开：`GET /healthz`、`/`、`/assets/*`、`GET /api/auth/status`、`POST /api/auth/login`（单进程 5 分钟内最多 5 次失败，超出返回 429）。
- 需要登录（Bearer 头或 `?token=`）：
  - `GET /api/config` — `{bucket, oss_ready, oss_missing, drive_prefix, note_prefix, media_prefix}`
  - 网盘：`/api/files`、`/api/files/search`、`/api/files/download`、`/api/files/edit`、`/api/files/create`、`/api/files/folder`、`/api/files/rename`、`/api/files/move`、`/api/files/upload/*`
  - 笔记：`/api/notes`、`/api/notes/folder`、`/api/notes/content`
  - 音乐：`GET /api/tracks`、`PUT /api/tracks/meta`、`GET /api/stream`（Range 转发）
- 同一个 token 对三个模块通用。`<iframe>`、`<audio>` 不能带请求头，所以下载和音频流接受 `?token=`；对外代理时不要记录查询串（`deploy/cloud-oss-ai.conf` 已处理）。
- 所有写请求必须带 `X-App-Client: web`，否则返回 403。它只是公开的标记，不是凭证。
- 请求体按路由限制：登录和 `/api/tracks/meta` 4 KiB；文本创建 / 编辑和笔记 7 MiB；上传接口保持原有限制（直传 < 5 MiB，分片 5 MiB）。
- 音乐收藏与元数据保存在本机 JSON 文件中，只能运行**一个后端进程、一个 Uvicorn worker**。
- 分片上传的 upload ID 保存在进程内存里，重启前应先取消未完成的上传。

## 原生 App（Capacitor）

appId `com.cloudossai.app`，名称「轻云」，`webDir: dist`（暂定，可改）。原生工程已生成，**不要再对已有目录执行 `cap add`**。服务器地址在运行时设置，并按服务器地址分别保存登录令牌；侧栏底部的「连接设置」可以切换服务器。

| 命令（`npm --prefix frontend run …`） | 作用 |
| --- | --- |
| `native:sync` | 构建后 `cap sync` 两个平台 |
| `ios:prepare` / `android:prepare` | 构建并同步单个平台 |
| `ios:open` / `android:open` | 打开 Xcode / Android Studio |
| `ios:simulator` | 构建 iOS 模拟器 Debug 版（不签名） |
| `ios:archive` | Release 归档（`CODE_SIGNING_ALLOWED=NO`，不是可安装的 IPA） |
| `android:debug` | Gradle `:app:assembleDebug` |
| `android:release` | `:app:assembleRelease :app:bundleRelease`，未配置签名时产物未签名 |

- **iOS**：需要 Xcode 26+，Swift Package Manager 工程，打开 `frontend/ios/App/App.xcodeproj`。`CloudFilesPlugin`（`SceneDelegate.swift`）用 QuickLook 预览或分享网盘文件；JS 调用时传入当前服务器地址，Swift 端校验后再下载。`Info.plist` 的 ATS 设置允许 HTTP 服务器和媒体加载。
- **Android**：需要 Java 21、Android SDK 36（通过 Android Studio 或私有的 `frontend/android/local.properties` 配置）。Android 同时支持 HTTP 和 HTTPS 服务器（已开启明文流量和混合内容；模拟器访问本机后端用 `http://10.0.2.2:8790`，并把 `10.0.2.2` 加入 `ALLOWED_HOSTS`）。没有 CloudFiles 插件，原生打开文件会退回到浏览器下载方式。
- 原生客户端登录要求后端 `ALLOWED_ORIGINS` 包含 `capacitor://localhost` 和 `https://localhost`。

## nginx（只代理后端）

`deploy/cloud-oss-ai.conf` 是放在 `conf.d` 下的独立站点文件，所有指令都属于 `http { }` 级别，与 `cloud-oss.conf` 结构相同：

- `= /healthz`、`= /api/auth/login`（每个客户端每分钟 10 次的限流）
- `= /api/files/download` 和 `= /api/stream`：不缓冲，读超时 1 小时，错误日志不记录带 token 的 URL
- `^~ /api/files/upload`：6m、请求不缓冲
- `/api/` 其余接口：8m、读超时 300 秒；`/` 返回 404

安装（先把 `cloud.example.com` 换成你的域名，并加进 `ALLOWED_HOSTS`）：

```bash
sudo cp deploy/cloud-oss-ai.conf /etc/nginx/conf.d/cloud-oss-ai.conf
sudo nginx -t && sudo systemctl reload nginx
```

nginx 必须和后端在同一台机器上。不要在 `http { }` 之外 include 这个文件，否则 `nginx -t` 会报错。
