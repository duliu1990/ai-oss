# 轻存储 · Media to OSS

一个本地单用户网页工具：输入在线视频或音频链接，识别媒体、下载为 MP3 或视频，并可上传到自己的阿里云 OSS。

- 使用 `yt-dlp` 解析 YouTube 等受支持站点，识别普通网页中的媒体候选和音视频直链。
- 使用 FFmpeg 提取 MP3 音频或合并视频，下载完成后校验媒体轨道。
- 支持 OSS 私有对象上传、短期签名访问链接、上传失败后重试。
- 可选接入 OpenAI 兼容接口，对已发现的网页媒体候选进行 AI 排序。
- **不配置 OSS 和 AI，也可以使用仅下载模式。**

## 1. 快速启动

当前项目位置：`/Users/Darrendu/Projects/media-to-oss`。

已有依赖环境时，在终端执行：

```bash
cd /Users/Darrendu/Projects/media-to-oss
uv run --locked python app.py
```

也可以从任意目录启动：

```bash
uv --directory /Users/Darrendu/Projects/media-to-oss run --locked python app.py
```

浏览器打开：**http://127.0.0.1:8765**。

- 保持启动终端运行；按 `Ctrl+C` 停止服务。
- 如果已有服务占用此端口，直接打开网页，不要重复启动。
- 修改 `.env` 后，先停止服务，再执行启动命令。页面的“重新读取”只刷新状态，不会重新加载配置。
- **服务重启会清空内存中的任务和分析记录，并中止正在处理的任务。** 请尽量等待任务结束后再重启。

## 2. 首次安装

### 环境要求

| 依赖 | 要求 |
| --- | --- |
| 操作系统 | 已验证 macOS；实现依赖 POSIX 文件锁和进程组，不支持直接在原生 Windows 运行 |
| Python | **3.12.x**；项目限制为 `>=3.12,<3.13` |
| uv | 管理 Python 依赖和虚拟环境 |
| FFmpeg / FFprobe | 音频提取、视频合并和输出文件校验 |
| Node.js | yt-dlp 的 JavaScript 运行时；当前已验证 Node.js 26 |

不需要安装前端依赖，也不需要执行 `npm install`；页面使用原生 HTML/CSS/JavaScript。

### macOS 安装步骤

以下命令假定已安装 Homebrew；已有的工具可以跳过安装。

```bash
brew install uv ffmpeg node

cd /Users/Darrendu/Projects/media-to-oss
uv --native-tls sync --locked --python 3.12

test -f .env || cp .env.example .env
chmod 600 .env

uv run --locked python app.py
```

`uv` 会创建项目内的 `.venv`，并在需要时下载 Python 3.12。复制配置的命令只在 `.env` 不存在时执行，**不会覆盖已有密钥**。

安装完成后可以检查：

```bash
uv run --locked python --version
ffmpeg -version
ffprobe -version
node --version
```

## 3. 配置 OSS 上传

编辑项目根目录的 `.env`。程序按文件位置读取配置，与启动时的终端目录无关；同名进程环境变量优先于 `.env`。

示例中的地域和 Bucket 请替换为自己的实际值：

```dotenv
OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
OSS_BUCKET=your-bucket-name
OSS_ACCESS_KEY_ID=your-access-key-id
OSS_ACCESS_KEY_SECRET=your-access-key-secret
OSS_SECURITY_TOKEN=
OSS_PREFIX=media/
SIGNED_URL_SECONDS=300
```

| 配置项 | 说明 |
| --- | --- |
| `OSS_ENDPOINT` | 必填；Bucket 所在地域的 HTTPS 服务 Endpoint，不是控制台链接，也不是包含 Bucket 名或对象路径的文件地址 |
| `OSS_BUCKET` | 必填；Bucket 名称 |
| `OSS_ACCESS_KEY_ID` | 必填；RAM 用户或临时凭据的 AccessKey ID |
| `OSS_ACCESS_KEY_SECRET` | 必填；对应的 AccessKey Secret |
| `OSS_SECURITY_TOKEN` | 使用 STS 临时凭据时填写；普通 RAM AccessKey 留空 |
| `OSS_PREFIX` | 对象目录前缀，默认 `media/`；可以留空 |
| `SIGNED_URL_SECONDS` | 签名链接有效期，默认 300 秒，允许 60～3600 秒 |

配置保存并重启后，页面应显示 OSS 配置已就绪，即可勾选“同时上传到 OSS”。**就绪只代表必填字段齐全，不代表凭据或网络已经验证成功。**

安全与权限建议：

- 使用仅授权目标 Bucket/目录的 RAM 凭据，不使用主账号密钥。
- 需要上传和读取目标对象的权限；对象访问策略也必须允许相应操作。“已上传文件”列表还需要 Bucket 级的 `oss:ListObjects`，列表中的“删除”需要 `oss:DeleteObject`。参考策略：

  ```json
  {
    "Version": "1",
    "Statement": [
      { "Effect": "Allow", "Action": ["oss:PutObject", "oss:GetObject", "oss:DeleteObject"], "Resource": "acs:oss:*:*:your-bucket-name/media/*" },
      { "Effect": "Allow", "Action": "oss:ListObjects", "Resource": "acs:oss:*:*:your-bucket-name", "Condition": { "StringLike": { "oss:Prefix": "media/*" } } }
    ]
  }
  ```
- 上传使用随机对象名和对象级 `private` ACL，不修改 Bucket ACL。
- 曲目信息文件 `media/catalog.json` 同样使用 `private` ACL，需要上面的 `PutObject` / `GetObject` 权限（已包含在 `media/*` 中）。
- 不需要把 Bucket 设置为公共读，也不需要为此网页配置 OSS CORS；上传由本机后端执行。
- 签名链接属于临时访问凭据，请勿随意分享。STS 凭据若提前过期，链接也可能提前失效。
- `.env` 已加入 `.gitignore`，不要提交、截图或发送真实密钥。

当前 OSS 适配使用 `oss2.Auth` / `oss2.StsAuth` 的默认 V1 签名；若所在地域或 Bucket 策略强制要求 V4，需要调整签名实现后再使用。

## 4. 可选 AI 配置

目前 AI 用于**对已抽取的候选排序，优先选择可能的音频**，不是让模型凭空生成下载地址，也不会自动控制浏览器寻找隐藏请求。

以阿里云百炼的 OpenAI 兼容接口为例：

```dotenv
AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_API_KEY=your-api-key
AI_MODEL=qwen-plus
```

也可以填写其他 OpenAI 兼容服务，注意：

- 三个字段全部填写才会启用，`AI_BASE_URL` 必须是 HTTPS 地址。
- 填写接口基础地址，**不要追加 `/chat/completions`**，程序会自动添加该路径。
- 示例地址、模型及密钥须属于相互匹配且有访问权限的服务地域。
- 只有普通网页发现至少两个候选时才调用 AI；YouTube 专用解析和媒体直链不调用 AI。
- 发送给模型的是候选 ID、脱敏标题和媒体类型，不发送媒体 URL、OSS 密钥或 Cookie。
- 模型返回未知或重复 ID、请求失败时，自动保留规则识别结果并显示提示。
- 调用模型可能产生所选服务的 API 费用。

没有模型接口时，将三个字段留空即可。

## 5. 使用流程

1. 打开本地网页，粘贴完整的 `http://` 或 `https://` 链接。
2. 点击“分析链接”，查看标题、解析来源和媒体候选；多个候选时选择其中一个。
3. 选择默认的 **MP3 音频**，或选择**视频**；纯音频候选不能选择视频模式。
4. 按需勾选“同时上传到 OSS”；未配置时默认仅下载。
5. 点击“创建下载任务”，在下方查看排队、下载、处理及上传状态。
6. 完成后点击“下载文件”取回本地文件；上传成功后可查看 OSS 对象路径、生成或刷新短期访问链接。
7. 左侧“已上传文件”菜单会列出 `OSS_PREFIX` 下的全部对象（包括服务重启前上传的），可按需“加载更多”，并为任意对象生成签名访问链接。列表只读取配置前缀，不会列举或签名前缀之外的对象。
8. 在“已上传文件”中点击“删除”并确认后，会从 OSS 永久删除该对象（不可恢复，除非 Bucket 开启了版本控制），同时从 `catalog.json` 移除对应记录。已签发的签名链接随即失效；上传该文件的任务卡片会去掉 OSS 对象信息，若本地文件仍在，可以“重试上传”。正在上传中的文件、`catalog.json` 本身以及前缀之外的对象不能删除。

### 曲目信息文件 catalog.json

OSS 对象名是随机的，不含标题。为了在列表里显示可读的名称，每次上传成功后，程序会把这个文件的信息写入同一前缀下的全局 JSON 文件 `<OSS_PREFIX>catalog.json`（默认 `media/catalog.json`）：

```json
{
  "version": 1,
  "updated_at": "2026-10-20T03:12:45Z",
  "files": {
    "media/d95ecce8cc204eef9238c073d3443aef.mp3": {
      "title": "歌曲标题",
      "artist": "歌手或上传者",
      "duration": 213.4,
      "source": "yt-dlp · BiliBili",
      "source_host": "www.bilibili.com",
      "mode": "audio",
      "size": 8423468,
      "content_type": "audio/mpeg",
      "uploaded_at": "2026-10-20T03:12:45Z"
    }
  }
}
```

- `files` 以 OSS 对象路径为键；除 `title` 外的字段都可能缺失（取决于来源站点是否提供）。`artist` 优先取站点的歌手字段，没有时使用上传者名称。
- 不记录媒体下载地址或页面完整 URL（可能带签名参数），只记录来源站点的主机名。
- “已上传文件”列表以 OSS 实际对象为准，再用 `catalog.json` 补充标题、歌手、时长和来源；`catalog.json` 本身不出现在列表中。已从 OSS 删除的对象即使仍留在 JSON 里也不会显示。
- 本功能之前上传的文件没有记录，列表中仍显示文件名。可以手动编辑 `catalog.json` 补充，格式同上。
- 写入是“读取 → 修改 → 覆盖”。上传（任务子进程）和删除（服务进程）通过本机文件锁 `.runtime/.catalog.lock` 依次执行，同一服务内不会互相覆盖。不要同时运行多个实例（或多台机器）写同一个前缀，也不要在任务上传或删除时手动修改该文件，否则可能丢失一条记录。
- 删除时先删 OSS 对象，再更新 `catalog.json`。若 `catalog.json` 损坏或更新失败，文件仍会删除，页面提示“catalog.json 未同步更新”；残留的记录不影响列表（列表以实际对象为准），修复后可手动清理。
- `catalog.json` 内容损坏（不是有效 JSON 或缺少 `files`）时，列表会提示并按文件名显示；新的上传仍会成功，但**不会覆盖**损坏的文件，任务中会提示“曲目信息未写入”。修复或删除该文件后恢复写入。
- 写入失败不会让上传任务失败，只在任务卡片上提示，文件本身已在 OSS 中。

上传失败时，已下载的文件会保留。在文件仍存在、OSS 配置就绪且任务记录未丢失的情况下，可以点击“重试上传”，不必重新下载。

分析结果有效期为 **15 分钟**；修改链接或分析过期后，需要重新分析。视频会保留实际可用的容器格式，可能是 MP4、WebM 或 MKV，不保证一律转换成 MP4。

## 6. 下载限制与文件保留

以下配置均位于 `.env`，修改后需要重启：

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `MAX_FILE_MB` | `500` | 单个最终文件及下载阶段的大小限制，单位 MB |
| `MAX_STORAGE_MB` | `2000` | 工具临时目录的空间额度，单位 MB |
| `MAX_QUEUE` | `5` | 等待队列容量；同一时间只处理一个下载/上传任务 |
| `ANALYZE_TIMEOUT_SECONDS` | `90` | 单次链接分析超时，单位秒 |
| `DOWNLOAD_TIMEOUT_SECONDS` | `1800` | 下载及转码阶段总超时，单位秒 |
| `UPLOAD_TIMEOUT_SECONDS` | `900` | 上传阶段超时，单位秒 |
| `RETENTION_HOURS` | `24` | 已结束任务本地文件的保留时间，单位小时，允许 1～168 小时 |

`MAX_STORAGE_MB` **必须至少为 `MAX_FILE_MB` 的三倍**，以预留下载和转码中间文件空间。空间不足时会拒绝开始新下载，不会通过删除尚未过期的文件腾出空间。

- 后端文件位于 `.runtime/<任务 ID>/`，默认在任务结束约 24 小时后、服务执行清理时删除；上传失败的文件也遵循该规则。
- 服务停止期间不会运行清理，重新启动后会检查过期文件。
- 重启不会立即删除未过期文件，但不会恢复历史任务，也不能恢复原任务的上传重试入口。
- 通过浏览器另存的文件独立于 `.runtime`，不会被本工具自动清理。
- 自动清理仅涉及本机任务文件，**不会删除 OSS 上的对象**；OSS 存储及流量可能产生费用。

## 7. 服务日志

页面上的错误提示是经过脱敏的概要；定位问题请看启动终端的服务日志，那里会记录原始原因（如 OSS 返回的错误码、RequestId、yt-dlp 的报错）。

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `LOG_LEVEL` | `INFO` | 日志级别，可选 `DEBUG`、`INFO`、`WARNING`、`ERROR`；排查问题时可改为 `DEBUG` |
| `LOG_FILE` | 空 | 额外写入的日志文件路径，相对路径基于项目目录，例如 `.runtime/server.log`；单文件 10 MB，保留 3 个历史文件。为空时只输出到终端 |

日志中每条任务记录带有 `task=<任务 ID>`，子进程（下载、上传）的日志以 `[<任务 ID>]` 开头。一次失败的上传大致如下：

```text
2026-10-16 17:00:01,234 INFO    jobs: 任务开始上传 task=bc91e0d1... bucket=darren-note key=media/8f3c....mp3
2026-10-16 17:00:02,345 ERROR   oss: [bc91e0d1...] OSS 上传失败 key=media/8f3c....mp3 status=403 code=AccessDenied request_id=6AD1E89A... ec=0003-00000001 message=You have no right to access this object because of bucket acl.
2026-10-16 17:00:02,350 ERROR   jobs: 任务失败 task=bc91e0d1... stage=uploading 用时 1.1s：UserError: OSS 上传失败，本地文件已保留：访问被拒绝，请检查来源权限或 OSS 凭据及 RAM 授权。
```

日志不会写入 AccessKey Secret、签名链接或 Bearer Token：常见的凭据字段和签名参数会被替换为 `[已隐藏]`，媒体链接仅记录域名。尽管如此，分享日志前仍请自行检查。

## 8. 常见问题

### 端口占用或提示已有服务运行

每个项目目录只允许运行一个实例。先尝试打开 http://127.0.0.1:8765，或到原启动终端按 `Ctrl+C` 后重启，不要删除锁文件或直接强行终止未知进程。

需要使用其他端口时，先停止已有服务，再运行：

```bash
uv run --locked uvicorn app:app --host 127.0.0.1 --port 8766 --no-access-log
```

随后访问 http://127.0.0.1:8766。不要添加多个 worker，也不要把监听地址改成 `0.0.0.0`。

### 依赖安装提示 UnknownIssuer / 证书验证失败

使用系统证书库重新安装：

```bash
uv --native-tls sync --locked --python 3.12
```

运行时工作进程也使用系统证书库。公司网络需要的根证书应通过正规渠道安装并信任；不要通过关闭 TLS 校验解决问题。

### 页面提示缺少 FFmpeg、FFprobe 或 Node.js

确认它们已安装，并且启动服务的终端能找到可执行文件：

```bash
command -v ffmpeg
command -v ffprobe
command -v node
```

安装或修正 `PATH` 后重启服务。FFprobe 通常随 FFmpeg 一起安装。

### YouTube 或其他地址无法下载

可能原因包括视频已移除、登录验证、地区限制、网络安全网关、站点解析规则变化，或页面依赖动态脚本。工具不自动读取浏览器 Cookie，也不绕过 DRM、付费墙、访问权限或网关认证。

先确认该地址在当前网络下可合法访问，再尝试单条媒体页面或直接媒体链接。更新解析器时，在项目目录执行：

```bash
uv --native-tls lock --upgrade-package yt-dlp
uv --native-tls sync --locked
```

此操作会更新 `uv.lock`；更新后重新运行测试并重启服务，不能保证所有站点都能下载。

### OSS 上传失败

先看服务日志中 `oss:` 那一行的 `code` 和 `message`：`AccessDenied` 通常是 RAM 用户缺少 `oss:PutObject` 权限；`NoSuchBucket` 或 Endpoint 不匹配说明 Bucket 或地域配错；`InvalidAccessKeyId`/`SignatureDoesNotMatch` 说明密钥错误或 STS 已过期。仅看到“配置已就绪”不足以证明上传可用。

“已上传文件”列表提示访问被拒绝、日志为 `OSS 列举失败 ... code=AccessDenied ec=0003-00000905` 时，是 RAM 用户缺少 Bucket 级的 `oss:ListObjects`（资源需写成 `acs:oss:*:*:bucket`，而不是 `bucket/media/*`）；上传和签名链接不受影响。

点击“删除”提示访问被拒绝、日志为 `OSS 删除失败 ... code=AccessDenied` 时，是 RAM 用户缺少 `oss:DeleteObject`；此时文件和 `catalog.json` 都保持不变。

如果只需恢复网络或云端权限，可在原任务中重试；如果修改了 `.env` 并重启，历史任务会清空，需要重新创建任务。不要将原始密钥或签名链接贴到公开日志中。

### 重启后找不到任务

这是当前内存任务管理的预期行为，不是 OSS 文件丢失。需要长期保留的本地文件，请在过期前用“下载文件”另存；已上传的对象仍位于 OSS Bucket。

## 9. 测试与开发

在项目目录运行：

```bash
uv run --locked pytest -q
uv run --locked ruff check .
```

已完成的验证包括 247 项自动测试、浏览器实际 MP3/视频下载和取回、FFprobe 输出校验、YouTube 公开元信息解析、移动端布局及错误状态检查。

**真实 OSS 上传和 AI 服务联调仍需填写自己的配置后验证。** 自动测试中的 OSS/AI 外部请求使用模拟响应；OSS 签名另有不联网的 SDK 测试，不等同于真实云端上传成功。

主要文件：

```text
app.py          本机网页服务与 HTTP API
config.py       配置加载及校验
security.py     URL 校验与错误脱敏
logs.py         服务日志配置与凭据脱敏
extract.py      站点解析及网页媒体候选识别
ai.py           可选 AI 候选排序
media.py        下载、转码及最终文件校验
oss_store.py    OSS 私有上传、对象列举与签名链接
jobs.py         队列、任务状态、超时及文件清理
worker.py       隔离子进程执行入口
static/         中文网页界面
tests/          自动测试
.env.example    无密钥的配置模板
uv.lock         Python 依赖版本锁定
```

## 10. 使用边界

仅下载你有权保存的单条媒体，不支持播放列表、直播和 DRM 内容。只接受标准 HTTP/HTTPS 端口的公开地址，拒绝本机、内网及云元数据地址。

入口校验不等于对 yt-dlp/FFmpeg 内部请求进行完整网络沙箱隔离。**此工具只面向可信用户在本机使用，没有多用户认证机制；不要通过公网、反向代理或内网穿透发布。**
