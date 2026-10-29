# 轻听 · Media Player OSS 部署手册

适用方案：**ECS Linux + Nginx HTTPS/静态文件 + 单实例 Python API**。不需要 Docker、Caddy、Gunicorn，也不运行生产 Node 服务。systemd 可选，建议生产使用。

> **访问风险：本项目按设计公开匿名访问，没有登录。能访问服务的人可以播放、修改共享曲名与收藏，并产生 OSS/ECS 流量费用。HTTPS、CORS、Host 检查都不是身份认证。上线前确认接受这一边界，并设置费用告警。**

## 0. 最短路径与使用约定

首次部署按下面顺序进行，不要直接跳到启动命令：

1. 准备 Linux、域名/DNS、有效证书与安全组；确认工具版本。
2. 创建 `media-player` 用户，将审核过的源码放到 `/opt/media-player-oss`。
3. 用该用户准备 Python 3.12 环境，执行 `uv sync --locked --python 3.12`、`npm --prefix frontend ci`、`npm --prefix frontend run build`。
4. 首次创建项目根 `.env`，填写 OSS 配置；准备独立数据目录和 Nginx 读取权限。
5. 从项目根执行 **`uv run --locked python app.py`**，检查本机 API。
6. 安装 Nginx 站点和安全头片段；`nginx -t` 成功后才启动或重载 Nginx。
7. 验收 HTTPS 页面、播放/拖动、编辑/收藏；需要常驻时，正常停止前台实例，再启用 systemd。

本文命令供操作者在 **目标 ECS** 逐段执行，不是一键安装脚本。任何步骤失败都应停止排查，不要继续覆盖文件。需要 `sudo` 的操作使用管理员账户；构建和运行使用专用用户，切换处会明确说明。

`music.example.com`、`your-bucket-name`、`REPLACE_WITH_…` 都是虚构占位值；必须换成自己的值。仓库地址未知，请使用你自己的源码交付渠道，不存在本文指定的克隆地址。

### 架构、目录与端口

| 项目 | 固定示例/作用 |
| --- | --- |
| 浏览器入口 | `https://music.example.com`；80 固定跳转 HTTPS |
| Nginx 静态根 | `/opt/media-player-oss/frontend/dist`，不能改成项目根 |
| Python API | `127.0.0.1:8767`；Nginx 转发 `/api`、`/api/`、`/healthz` |
| 后端配置 | `/opt/media-player-oss/.env`，仅后端读取 |
| 生产共享元数据 | `/var/lib/media-player-oss/library.json` |
| 共享解释器目录 | 本文使用 `/opt/uv-python`，避免管理员私有 home |
| 服务用户 home | `/var/lib/media-player`，用于该用户的工具缓存 |
| Nginx 站点 | `/etc/nginx/conf.d/media-player-oss.conf` |
| 静态安全头片段 | `/etc/nginx/snippets/media-player-oss-static.conf` |
| 可选服务单元 | `/etc/systemd/system/media-player-oss.service` |

应用公网入口只开放 **TCP 80/443**，不要开放 **8767/5173**。SSH 等管理端口另按管理员来源限制。Nginx 与 Python 必须在同一台主机；若增加负载均衡/CDN，需重新审核代理信任，不直接套用本手册。

## 1. 准备 Linux、域名和工具

### 1.1 主机与网络

ECS 发行版尚未确定。先确认发行版、CPU 架构、软件源、现有服务以及 80/443 端口用途，不要覆盖已有站点。

- 域名 A 记录指向 ECS；只有 IPv6 确实可用才发布 AAAA。
- 安全组与主机防火墙同时放行 80/443；保留必要的出站 DNS/HTTPS，供依赖下载、OSS 和证书工作流使用。
- 域名备案、接入备案及其他合规要求取决于 ECS 地域、接入商和服务性质；中国内地部署应向阿里云及主管政策确认，不能把域名解析成功视为合规完成。
- 证书申请、续期、私钥保管由操作者管理；本项目不会自动签发证书。

### 1.2 工具版本与安装入口

| 工具 | 要求 |
| --- | --- |
| Python | **3.12.x**；项目限制为 `>=3.12,<3.13`，不要使用系统 Python 3.14，也不要替换系统 Python |
| uv | 0.7.13 或更新；本文选项已对照 0.7.13 帮助核对 |
| Node/npm | 服务器构建时推荐 Node 24；项目最低 Node 22.12、npm 10 |
| Nginx | 按原样配置至少 **1.19.4**，因为 `ssl_reject_handshake` 从该版提供；该最低版本不是安全维护建议 |
| TLS | Nginx 要带 HTTP SSL 模块；TLS 1.3 需要兼容的 TLS 库，OpenSSL 至少 1.1.1 |

生产选用官方或发行版仍维护的稳定版及安全补丁，实际版本以 [Nginx 软件包说明](https://nginx.org/en/linux_packages.html) 为准。旧 Ubuntu/Debian 默认包可能过旧；不要为了兼容旧包删掉拒绝未知 SNI 的设置。本机验证过 1.27.5，只是兼容性参考，不代表目标 ECS 已验证。

下面两组只选择与你发行版相符的一组；先核对软件源及版本，包安装可能自动启动默认站点。公网开放前先完成站点审核。

```bash
# Ubuntu / Debian; confirm repository versions first.
sudo apt update
sudo apt install nginx ca-certificates curl rsync acl

# Alibaba Cloud Linux / Rocky; confirm release/package availability first.
sudo dnf install nginx ca-certificates curl rsync acl
```

uv 从 [官方安装页](https://docs.astral.sh/uv/getting-started/installation/) 获取匹配 ECS 架构的二进制或按受信任包管理方式安装；先审核下载来源与发布校验信息。本文约定管理员将 uv 安装为 `/usr/local/bin/uv`、root 所有且模式 0755；不要把远程脚本不经审核直接管道给 `sudo`。

Node 按 [官方下载入口](https://nodejs.org/en/download) 选择 Node 24 的受支持安装方式，确保 `node`、`npm` 对服务用户可执行，而非仅存在于管理员私有版本管理器目录。安装后在 ECS 确认：

```bash
/usr/local/bin/uv --version
node --version
npm --version
nginx -v
nginx -V
```

系统级安装路径与包名需要在目标发行版确认。Python 由下一节 uv 单独准备，无需把系统 `python3` 改成 3.12。

## 2. 创建用户并放置源码

管理员先检查是否已有同名账户；已有则审核其用途、组与 home，不能盲目重建或改归属：

```bash
getent passwd media-player
getent group media-player
command -v nologin
```

仅当用户、组均不存在且上一步找到了 `nologin` 时创建：

```bash
sudo useradd --system --user-group --create-home \
  --home-dir /var/lib/media-player --shell "$(command -v nologin)" media-player
sudo install -d -m 0750 -o media-player -g media-player /opt/media-player-oss
sudo install -d -m 0750 -o media-player -g media-player /opt/uv-python
sudo install -d -m 0750 -o media-player -g media-player /var/lib/media-player-oss
```

若 `/opt` 本身不能遍历，按主机策略为指定用户授予搜索权限，不要全局放宽目录权限。以上路径及静态目录父级使用真实目录，不用指向版本目录的符号链接。

从自己的可信仓库导出/检出已审核版本，或上传经检查的源码包到 ECS 暂存目录。**不要直接打包整个开发工作区**：排除 `.env`、真实 `data/`、`.venv/`、`node_modules/`、缓存、原生构建产物、签名文件及私钥；保留 `.env.example`、Python/npm 锁文件和 `deploy/`。

下面的 `SOURCE` 表示你已经检查好的源码目录，必须改成实际路径。仅用于首次部署到新建的空项目目录；不用于合并未知的线上文件，也不使用删除目标文件的同步选项：

```bash
SOURCE=/var/tmp/media-player-oss-source
sudo rsync -a --chown=media-player:media-player \
  --include='.env.example' --exclude='.env*' --exclude='.git/' \
  --exclude='.venv/' --exclude='node_modules/' --exclude='data/' \
  --exclude='dist/' --exclude='build/' --exclude='.devcheck/' \
  "$SOURCE/" /opt/media-player-oss/
sudo chmod 0750 /opt/media-player-oss
```

这些排除项只是额外保护，不代替源码包审核。不要上传未知的符号链接或秘密文件。`frontend/` 的源码、配置与 npm 锁文件必须齐全；首次部署目录应由 `media-player` 所有，后续不要用 root 运行 npm/uv 把文件归属混乱。

## 3. 准备 Python 3.12 和 Web 构建

管理员显式进入专用用户的 Bash；这不需要为服务账户开启密码/SSH 登录：

```bash
sudo -u media-player -H /bin/bash
```

以下直到 `exit` 都在该用户终端执行。本文将工具放在公共可执行路径，并让 uv 管理的 Python 位于该用户可访问的独立目录：

```bash
export PATH=/usr/local/bin:/usr/bin:/bin
export UV_PYTHON_INSTALL_DIR=/opt/uv-python
export UV_MANAGED_PYTHON=true
umask 027
cd /opt/media-player-oss
uv python install 3.12
export UV_PYTHON_DOWNLOADS=never
uv sync --locked --python 3.12
.venv/bin/python --version
npm --prefix frontend ci
npm --prefix frontend run build
exit
```

若主机工具位于其他审核过的目录，应调整 PATH；不要加入管理员私有 home。`UV_PYTHON_DOWNLOADS=never` 在安装完成后设置，避免后续静默另装解释器。记录具体 3.12 补丁版本，保留 `.venv/bin/python` 指向的解释器及其目录，不要清理仍被服务使用的 `/opt/uv-python`。

`uv sync` 与日常 `uv run` 都采用默认依赖组，不混用 `--no-dev`，避免首次运行意外补装依赖。构建必须使用锁文件；npm 的 `build` 已包含类型检查，产物是 `frontend/dist`。不要上传 macOS 虚拟环境到 Linux。

若企业 CA 导致 uv 下载失败，按批准流程安装系统根证书，并按需使用 `uv --native-tls …`；不要关闭 TLS 验证。

**可选：构建机产物。** 可以在本地/构建机按同一源码及 npm 锁文件执行 npm 的上述两条命令，再上传完整 `frontend/dist` 到服务器对应位置。这样 ECS 不需要 Node/npm；Python 环境仍必须在 Linux 准备。产物归服务用户所有，随后仍执行静态权限配置。不要只上传 `index.html`，也不要运行 Vite 开发服务器代替部署。

## 4. 首次生成配置与保护数据

再次进入专用用户终端，在项目根创建配置。先确认已有 `.env` 不是符号链接；已有文件只能人工审核调整，不能由示例覆盖：

```bash
sudo -u media-player -H /bin/bash
cd /opt/media-player-oss
umask 077
if [ ! -e .env ] && [ ! -L .env ]; then
  cp --no-clobber .env.example .env
fi
chmod 600 .env
```

保持该用户身份，用可用的文本编辑器编辑 `.env`，不要把密钥写进命令参数、聊天记录或截图。下面只是内容样例，所有凭据占位符必须替换后才能连接 OSS：

```dotenv
OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
OSS_BUCKET=your-bucket-name
OSS_ACCESS_KEY_ID=REPLACE_WITH_READ_ONLY_ACCESS_KEY_ID
OSS_ACCESS_KEY_SECRET=REPLACE_WITH_READ_ONLY_ACCESS_KEY_SECRET
OSS_SECURITY_TOKEN=
OSS_PREFIX=media/
LIBRARY_FILE=/var/lib/media-player-oss/library.json
FRONTEND_DIST=frontend/dist
LOG_LEVEL=INFO
ALLOWED_HOSTS='["music.example.com","127.0.0.1"]'
ALLOWED_ORIGINS='["capacitor://localhost","https://localhost"]'
ENABLE_DEV_ORIGIN=false
```

- Endpoint 必须匹配实际 Bucket 地域；同地域内网 Endpoint 也应使用相应 HTTPS 地址。使用 STS 时填写 token 并自行安排到期更新。
- RAM 身份只需要前缀内对象的 `oss:GetObject` 和 Bucket 的 `oss:ListObjects`，具体策略见 [README](README.md)。服务不写 OSS。
- `ALLOWED_HOSTS` 是精确 DNS/IPv4 主机 JSON 数组，不含协议、端口或通配符；保留 `127.0.0.1` 供本机检查。
- App 来源准确写为 `capacitor://localhost` 和 `https://localhost`，无路径、尾斜杠或 `:443`；纯 Web 可用空数组，同源网页无需额外允许。
- 根 `.env` 由应用读取，不要 `source`，不配置 systemd `EnvironmentFile`。旧的 shell 导出值可能覆盖应用配置，应核查并清除相关冲突值，不要打印完整环境泄密。
- Nginx 不会展开 `.env`；域名、证书、静态 `root` 要在 Nginx 配置中另行对应修改。
- `VITE_API_BASE_URL` 是编译进 App 的公开服务器地址，不是后端秘密；OSS 密钥绝不能进入任何 `VITE_*` 变量。

编辑后执行 `exit` 回到管理员终端。生产数据目录使用前面创建的 0750、`media-player:media-player` 归属；已有 JSON 应为该用户所有、0600。目录也必须可写，因为保存会在同目录创建临时文件并原子替换，不能只给 JSON 写权限。

全新库不要手工创建空 JSON；首次保存会生成文件。迁移旧库必须先停止旧写入进程、备份、确认目标不存在，再人工导入并校验归属。**不允许两个进程写同一 JSON，也不自动覆盖已有库。**

## 5. 给 Nginx 只读静态权限

管理员查看目标 Nginx 主配置的 `user`，Ubuntu/Debian 常为 `www-data`，RHEL 派生常为 `nginx`；以实际配置为准。不要把 Nginx 加入私有 `media-player` 组。

在已确认静态树没有符号链接的前提下，用 ACL 精确授予权限。`NGINX_USER` 必须按本机修改；命令只对静态树递归，不对整个项目递归：

```bash
NGINX_USER=www-data
sudo setfacl -m "u:${NGINX_USER}:--x" /opt/media-player-oss /opt/media-player-oss/frontend
sudo setfacl -R -m "u:${NGINX_USER}:r-X" /opt/media-player-oss/frontend/dist
sudo -u "$NGINX_USER" test -r /opt/media-player-oss/frontend/dist/index.html
sudo -u "$NGINX_USER" test ! -r /opt/media-player-oss/.env
sudo -u "$NGINX_USER" test ! -r /var/lib/media-player-oss
```

检查父目录（包括 `/opt`）是否可遍历；如需补充，只授权特定用户的搜索权限。应用源码、密钥、数据和备份不应因此被开放。构建或上传新 dist 后需要重新核对 ACL；Nginx 的 `disable_symlinks on` 会拒绝路径任意一级符号链接。

SELinux enforcing 的 RHEL 派生系统还需按目标策略持久设置静态树的 `httpd_sys_content_t` 标签（`semanage fcontext` 后 `restorecon`），核对父目录搜索权限，并授权 Nginx 到 `127.0.0.1:8767` 的网络连接。先查看审核日志，按发行版确认策略工具包和规则；`httpd_can_network_connect` 可能允许更宽的出站范围，启用前应获批准，或使用受限本地策略。**不关闭 SELinux，不用 `chmod 777`。**

## 6. 前台启动与本机检查

管理员先辨认端口占用，不要盲目杀进程：

```bash
sudo ss -ltnp 'sport = :8767'
```

有占用时确认进程所有者、用途及启动方式，经授权正常停止旧实例。端口空闲后进入运行用户终端：

```bash
sudo -u media-player -H /bin/bash
export PATH=/usr/local/bin:/usr/bin:/bin
export UV_PYTHON_INSTALL_DIR=/opt/uv-python
export UV_PYTHON_DOWNLOADS=never
cd /opt/media-player-oss
uv run --locked python app.py
```

前台保持运行；另开管理员 SSH 终端执行以下 **GET** 检查，不能用 `curl -I` 替代 `/healthz` 请求：

```bash
curl --fail --silent --show-error http://127.0.0.1:8767/healthz
curl --fail --silent --show-error http://127.0.0.1:8767/api/config
curl --fail --silent --show-error http://127.0.0.1:8767/api/tracks
```

健康应返回 `{"status":"ok"}`，但它不访问 OSS；`oss_ready` 只检查必填配置是否齐全，真实权限/网络要由列表和播放验证。列表可能包含私有文件名，勿把输出公开发布。

该入口先启用操作系统证书信任，再启动 Uvicorn，固定单 worker、loopback 监听且只信任 `127.0.0.1` 的代理头。不要改用直接 Uvicorn 命令。前台正常退出使用原终端 Ctrl+C，等待关闭完成；不要同时启动 systemd。

## 7. 安装 Nginx HTTPS 入口

### 7.1 证书与主配置

操作者先将有效完整链和私钥安全安装到下面位置；替换域名后目录也要一致：

- `/etc/nginx/tls/music.example.com/fullchain.pem`
- `/etc/nginx/tls/music.example.com/privkey.pem`

私钥不入仓库、不上传到静态目录，通常由 root 保管、0600，供有权限的 Nginx 主进程启动时读取。确认有效期、SAN 域名、完整链及续期负责人。当前站点不提供 ACME HTTP challenge 路由；按证书提供方选择适配的申请/续期方式，例如 DNS 验证。续期后必须检查配置再重载。

不要覆盖系统 `nginx.conf`。确认它在 **http 上下文**包含 `mime.types` 和一次 `/etc/nginx/conf.d/*.conf`。检查其他默认站点，每个监听地址/端口只能有一个默认服务器；保留拒绝未知 Host/SNI 的默认策略，不让本应用成为兜底站点。IPv6 不可用时要一致调整两类服务器的 IPv6 listen。

还需审核主配置继承的 header、error_page、代理和 real-IP 设置；样例假设 Nginx 直接接收客户端，不信任外来转发头链。

### 7.2 安装、编辑、检查后生效

从管理员终端安装；若这些目标文件已存在，先备份、对照差异再决定更新，不直接覆盖本机定制内容：

```bash
sudo install -d -m 0755 /etc/nginx/conf.d /etc/nginx/snippets
sudo install -m 0644 /opt/media-player-oss/deploy/nginx/media-player-oss.conf /etc/nginx/conf.d/media-player-oss.conf
sudo install -m 0644 /opt/media-player-oss/deploy/nginx/media-player-oss-static.conf /etc/nginx/snippets/media-player-oss-static.conf
```

用 `sudoedit /etc/nginx/conf.d/media-player-oss.conf` 修改已安装副本：逐处替换 `server_name`、固定重定向域名、证书路径，以及 Host map 中的 `music[.]example[.]com` 正则。只替换普通 `music.example.com` 字符串会漏掉正则。保留 Host 的合法端口匹配和所有安全边界。

**不能把静态安全头片段也放进 conf.d**：它只应被静态 location include，不能被 `*.conf` 当作 http 顶层站点自动加载。完成证书和域名修改后：

```bash
sudo nginx -t
```

仅当成功才继续：Nginx 已运行时用 `sudo systemctl reload nginx`；尚未运行且目标发行版使用 systemd 时用 `sudo systemctl enable --now nginx`。非 systemd 主机按发行版服务管理方式处理；`nginx -s reload` 只适用于已确认配置路径和主进程的实例。

### 7.3 不应改坏的行为

- `/` 与 `/index.html` 为 `no-store`，缺失构建返回明确 503；只开放扁平哈希 assets，成功 200/206/304 才一年 immutable，错误不缓存。
- 点文件、旧静态路径、未知页面、缺失/嵌套 assets 返回 404，没有全局 SPA 回退；静态 root 不暴露 `.env` 或库文件。
- CSP 与 Python 保持一致：media/connect 同源、必要 inline style，附加 `nosniff`、`no-referrer`、`DENY`；设置缓存头的静态 location 要保留完整片段 include。
- API 的 `proxy_pass` **不加尾部 URI**，以保留 `/api` 和原始编码 query。所有代理继承完整 Host/转发头集合，Host 用 `$http_host` 保留端口；客户端转发值被覆盖而非追加。
- OPTIONS 交给 Python；不在 Nginx 添加宽泛 CORS、不重复 API CSP，不隐藏 Range 响应头。仅本机代理受后端信任，本机不可信进程不在此防护范围内。
- 代理缓存、响应缓冲、错误拦截和 gzip 关闭；连接 5 秒、普通读/发送 60 秒，精确 `/api/stream` 读 300 秒。Range/If-Range 原样转发，不强制范围、不切片缓存。

## 8. 可选：用 systemd 常驻运行

先在前台终端 Ctrl+C 并等待 Python 退出，执行 `exit` 返回管理员身份。确认 8767 不再被旧实例占用；然后安装并启用单元：

```bash
sudo -u media-player /opt/media-player-oss/.venv/bin/python --version
sudo install -m 0644 /opt/media-player-oss/deploy/media-player-oss.service /etc/systemd/system/media-player-oss.service
sudo systemctl daemon-reload
sudo systemctl enable --now media-player-oss
sudo systemctl status media-player-oss --no-pager
sudo journalctl -u media-player-oss -n 100 --no-pager
```

已有单元时先比较/备份，不能覆盖未知定制。单元实际使用 `media-player:media-player`，工作目录 `/opt/media-player-oss`，直接运行 `.venv/bin/python /opt/media-player-oss/app.py`；不执行依赖安装、不用 `EnvironmentFile`。解释器、标准库和所有父目录必须对该用户可访问。

这是 `Type=simple`、失败后 5 秒重启、`UMask=0077` 的单进程服务；正常运行却健康异常不会自动触发重启。日志写 journal，保留策略由系统管理。启用后不要再手工启动第二个实例。

## 9. Web、App 与上线验收

浏览器打开 `https://music.example.com`。手机 App 的服务器地址填写 **`https://music.example.com`**，不加 `/api`、路径、查询或尾斜杠；手机上的 `127.0.0.1` 是手机自身。证书必须受手机系统信任且链完整，禁止用 `VITE_ALLOW_HTTP_DEV` 或关闭 TLS 验证绕过生产限制。App 构建、签名参见 [README 的 Android/iOS 章节](README.md#5-android-and-ios-apps)。

逐项验收：

- [ ] HTTP 跳到固定 HTTPS 域名，未知 Host/SNI 不展示应用；浏览器没有证书警告。
- [ ] 首页、配置、列表能加载；API 请求同源且没有代理引入的 CORS/混合内容错误。
- [ ] 在获准修改的测试曲目上编辑曲名/歌手、收藏并刷新；清空本地名称后回退 OSS catalog，再回退文件名；之后恢复原值。
- [ ] 播放、暂停、拖动进度条及不同音频编码正常；重启后共享元数据仍在。手机应独立测试，不以桌面代替真机。
- [ ] 页面/资源缓存头正确，未知路径确实 404，而不是误回首页。

以下是 GET 检查，先替换 BASE。没有凭据，不需要给普通 GET 加写入标识；命令不会跳过 TLS 校验：

```bash
BASE=https://music.example.com
curl --silent --show-error -D - -o /dev/null "$BASE/"
curl --fail --silent --show-error "$BASE/healthz"
curl --fail --silent --show-error "$BASE/api/config"
curl --fail --silent --show-error "$BASE/api/tracks"
curl --silent --show-error -D - -o /dev/null "$BASE/not-a-page"
curl --silent --show-error -D - -o /dev/null "$BASE/.env"
curl --silent --show-error -D - -o /dev/null "$BASE/assets/missing-Ab12_cd3.js"
```

前面三个异常路径应为 404、`Cache-Control: no-store`；合法哈希资源请从当前网页 Network 中取实际 URL，检查 200/206/304 缓存，不硬编码旧构建文件名。静态 503 表示首页构建不可用，不能拿 `/healthz` 成功替代页面验证。

范围请求必须选择列表中真实存在、长度足够的测试对象。下面 KEY 仅是包含特殊字符的虚构例子；替换为原始对象 key，不要手工预编码，`--get --data-urlencode` 会正确处理中文、空格、`+`、`&`、`?`、`#`、`%`：

```bash
KEY='media/测试 + &?#100%.mp3'
curl --silent --show-error --get --data-urlencode "key=$KEY" \
  --header 'Range: bytes=0-1023' -D - -o /dev/null "$BASE/api/stream"
```

预期 206、`Accept-Ranges: bytes`、正确 `Content-Range`/`Content-Length`。测试 416 时，将 Range 起点设为前一步 `Content-Range` 中的总字节数或更大，预期 `Content-Range: bytes */总字节数`。小型测试文件可去掉 Range 验证完整 200；会产生实际下载流量，勿用大文件反复探测。

原生预检可单独检查；200 应允许准确请求来源，不能是通配符：

```bash
curl --silent --show-error -X OPTIONS -D - -o /dev/null "$BASE/api/stream" \
  --header 'Origin: capacitor://localhost' \
  --header 'Access-Control-Request-Method: GET' \
  --header 'Access-Control-Request-Headers: Range'
```

再以 `https://localhost` 检查另一来源。浏览器写入会发送 `X-Player-Client: web`，它是公开标识而非密码。Nginx 自己产生的 502/504 可能没有 CORS，App 可能只显示网络错误；不能为掩盖网关故障扩大来源白名单。

`nginx -t` 只验证配置语法及相关文件加载，不替代上述浏览器、音频和真机验收。

## 10. 备份、更新和恢复

### 10.1 先授权、停写、备份

维护前告知使用者并获得共享库/密钥备份授权，记录当前源码版本、两个锁文件、Python 补丁版、完整 dist 和已安装 Nginx/systemd 配置。保留前一版审核过的发行包，不把秘密放进源码包。

若使用 systemd，先 `sudo systemctl stop media-player-oss`；手动启动则在原终端正常停止。确认没有第二个写入进程，再做一致性备份。下面为管理员命令，创建唯一私有备份目录，不覆盖已有备份；失败时停止维护流程：

```bash
(
  set -e
  sudo install -d -m 0700 -o root -g root /var/backups/media-player-oss
  BACKUP=$(sudo mktemp -d /var/backups/media-player-oss/backup.XXXXXXXX)
  sudo install -m 0600 -o root -g root /opt/media-player-oss/.env "$BACKUP/backend.env"
  sudo cmp --silent /opt/media-player-oss/.env "$BACKUP/backend.env"
  if sudo test -f /var/lib/media-player-oss/library.json; then
    sudo install -m 0600 -o root -g root /var/lib/media-player-oss/library.json "$BACKUP/library.json"
    sudo cmp --silent /var/lib/media-player-oss/library.json "$BACKUP/library.json"
  fi
  printf 'Backup directory: %s\n' "$BACKUP"
)
```

代码块用子 shell 的 `set -e` 在创建/复制/比对失败时停止；成功后记下输出的唯一备份路径。`cmp` 返回 0 表示复制内容一致，不会打印密钥。新库可能尚无 JSON，这是正常情况；若已使用过却找不到，先核对实际 `LIBRARY_FILE`，不能假装已备份。按组织流程加密异地保存并校验传输，限制授权人员访问；证书/私钥和配置另按受控流程备份。不要把完整备份或日志上传公开渠道，先在隔离副本测试恢复。

### 10.2 更新源码和静态文件

1. 在独立暂存目录准备选定的新版本，审核差异。保留当前已修改文件，不执行强制 reset，不在未知脏工作区直接拉取覆盖；仓库 URL 与发布版本由你确认。
2. 进入维护窗口、完成上述停写备份。将审核过的源码同步到真实项目目录，**始终排除 `.env` 和真实库**；迁移/删掉旧源码文件应逐项审核，不用整目录强删。
3. 以 `media-player` 用户按第 3 节的环境设置重新执行 `uv sync --locked --python 3.12` 和 npm 构建，或部署同一版本完整 dist。不要移动/复制另一目录的 `.venv` 作为当前环境。
4. 注意：原地构建/替换 dist 期间，旧页面可能请求已不存在的哈希资源，出现 404。安排静态发布维护窗口，完整发布后再开放访问并提示刷新；如需过渡保留旧资源，只保留经过审核的旧哈希 assets，不混用旧 index，不承诺零停机。
5. 静态路径不可使用 release 符号链接。复核文件归属、静态 ACL 和 SELinux 标签后，只启动一个实例：`sudo systemctl start media-player-oss`，或使用前台命令。
6. 单独修改 `.env`/后端代码时需重启后端；前端源码变化必须重新构建，只重启 Python 不会更新 bundle。单纯替换完整静态文件通常无需 Nginx reload。
7. 修改 Nginx 配置/证书后，必须 `sudo nginx -t` 成功再 `sudo systemctl reload nginx`；修改 unit 则先 `sudo systemctl daemon-reload` 再重启后端。
8. 重做第 9 节验收，确认共享数据保存正常才结束维护。不要为减少中断启动重叠写入实例。

### 10.3 恢复到前一版本

先停写并重新备份当前数据，再用保留的源码/锁文件和匹配 dist 恢复代码；在 Linux 当前路径重新同步依赖，保留现有 `.env` 和库，核对权限后启动一个实例。不要通过破坏性 Git 命令丢弃未提交成果。

只有版本兼容确实要求时，才经明确授权恢复旧 JSON：先在隔离副本校验内容，保留当前库备份，确认目标路径后人工恢复为 `media-player:media-player`、0600，数据目录继续 0750 且可原子写。旧快照会丢失较新的曲名/收藏；不要把覆盖真实库写成自动升级动作。

## 11. 快速排障

| 现象 | 优先检查 |
| --- | --- |
| Nginx 502/504 | Python 是否启动、是否只有一个实例、loopback 8767 是否正确；SELinux 是否允许代理连接；上游超时与日志 |
| API 403 / Host 400 / 连接被关闭 | 区分 Python 来源拒绝、Host 校验和 Nginx 未知域名拒绝；检查实际域名、Origin、写入标识，不扩大白名单 |
| 静态 403/404/503 | dist 是否完整、root 是否准确、`mime.types`、用户/父目录权限、ACL、SELinux、路径是否包含符号链接；不改 root 到项目根 |
| 本机 API 正常，公开 API 失败 | 检查 HTTPS 转发协议、保留端口的 Host、完整继承的代理头；不要在 stream location 单独加 header 导致丢失父级设置 |
| TLS/手机证书错误 | DNS/SNI 与证书 SAN、完整链、有效期、系统时间、设备信任；不能用 `-k` 或绕过 WebView TLS 限制 |
| systemd 报解释器权限/找不到文件 | `.venv/bin/python` 的真实目标、`/opt/uv-python` 及父目录、用户归属；不能引用管理员私有 home |
| 保存失败 | 数据目录和 JSON 的用户归属/权限、磁盘空间及 SELinux；坏 JSON 会报错而非自动重置，先备份修复 |
| 音频不能 seek | 确认原始 key 编码、200/206/416 与 Range 头、代理未压缩/缓存；区分对象权限和手机 codec 支持 |
| 更新后仍是旧页面 | 确认部署了新构建及配套 assets、实际 root、旧进程/站点和浏览器缓存；仅重启后端不产生新 bundle |

后端前台日志输出到终端 stderr；systemd 下使用 `journalctl -u media-player-oss`，项目没有固定后端日志文件。Nginx 样例未指定日志路径，继承目标主配置的 `access_log`/`error_log`；Linux 常见 `/var/log/nginx/`，但必须以实际配置为准。日志含对象路径等信息，分享前脱敏并控制保留周期。

## 12. 已有验证与仍需完成的工作

已有隔离验证记录包括 143 项 Python 测试、89 项前端测试、Nginx/HTTPS 协议链路，以及 HTTP 镜像入口的浏览器流程通过；HTTP 浏览器结果不等同于真实证书 HTTPS 真机验收。

本手册编写没有在 ECS 执行安装或部署。目标 Linux 的软件包、账户/权限、SELinux、systemd、域名/证书续期、安全组、真实 OSS 与手机系统信任链仍需操作者逐项确认，不能据此宣称生产已经验收。

参考：[uv 安装](https://docs.astral.sh/uv/getting-started/installation/) · [uv Python 管理](https://docs.astral.sh/uv/concepts/python-versions/) · [Nginx 软件包](https://nginx.org/en/linux_packages.html) · [Nginx TLS/最低指令版本](https://nginx.org/en/docs/http/ngx_http_ssl_module.html#ssl_reject_handshake) · [systemctl](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html) · [Linux ACL](https://man7.org/linux/man-pages/man1/setfacl.1.html)
