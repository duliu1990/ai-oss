# 阿里云 ECS 个人部署手册

适用项目：当前 React + FastAPI + 阿里云 OSS 项目；目标服务器为 Ubuntu ECS。

## 1. 推荐方案

**本地构建 React，SSH 上传代码和静态文件，ECS 用 systemd 托管一个 Python 进程，通过 SSH 隧道私人访问。**

前后端仍然分离开发，但部署时 FastAPI 直接提供 `frontend/dist`，浏览器和 API 同源，不需要额外配置 CORS、Nginx、Node.js 常驻服务或 Docker。ECS 只安装 Python 3.12、运行依赖和少量系统工具，不在低配服务器上构建前端。macOS 的 `.venv`、`node_modules` 不能直接复制到 Linux；Python 环境必须在 ECS 上创建。

**当前项目没有登录功能，任何能访问接口的人都能操作、下载和删除 OSS 文件。因此不要开放公网 8700，也不要用 `0.0.0.0` 启动应用。** 本方案保留 `127.0.0.1:8700` 监听，SSH 隧道提供加密和 SSH 身份认证。没有域名也能使用，不需要为本方案配置网站域名和 HTTPS；如果以后转公网网站，需另行处理身份认证、HTTPS，以及中国内地网站适用的备案要求。

应用的分片上传状态保存在单进程内存中：保持一个 worker，不开 `--reload`；发布、重启或回滚前，先完成或取消正在进行的上传。

## 2. 准备清单

| 位置 | 要准备的内容 |
|---|---|
| 本机 Mac | Node.js >=22.12、npm >=10、OpenSSH；项目自带 `package-lock.json` |
| ECS | Ubuntu + systemd，sudo 权限，能访问 Ubuntu 软件源、Astral/GitHub 和 Python 包源 |
| 网络 | ECS 公网 IP 或其他可达的 SSH 入口；安全组仅向你的公网 IP 放行 SSH 端口 |
| OSS | 私有 Bucket、正确地域 Endpoint、限定 Bucket/前缀权限的 RAM 凭证 |
| 磁盘/内存 | 先检查余量；首次需下载 Python 和依赖，发布保留多个独立虚拟环境 |

不需要安装数据库：当前项目直接使用 OSS。建议准备至少约 1 GB 可用磁盘作为起点，实际依赖缓存、发布次数和临时上传文件会增加占用；内存能否满足要结合文件大小和并发实测，不以“服务启动了”作为容量保证。

在 ECS 控制台确认系统版本和 CPU 架构，也可登录后执行：

```bash
cat /etc/os-release
uname -m
free -h
df -h /
```

脚本要求 Ubuntu，但不强制具体版本：uv 会单独安装 Python 3.12，无须替换系统 Python；优先使用仍在安全维护期的 Ubuntu LTS。

## 3. 先配置 SSH

在本机 `~/.ssh/config` 增加一个别名，替换 IP、账号和密钥路径：

```sshconfig
Host driver-ecs
    HostName YOUR_ECS_PUBLIC_IP
    User ubuntu
    IdentityFile ~/.ssh/your_ecs_key
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

`ubuntu` 只是示例，以你实际可登录且有 sudo 权限的账号为准；不要为了部署开启 root 密码登录。密码、私钥和 OSS 凭证都不要发送给他人或写入仓库。

```bash
chmod 600 ~/.ssh/your_ecs_key
ssh driver-ecs
# 核对第一次连接的主机指纹；确认来自 ECS，不要跳过校验。
sudo -v
exit
```

ECS 安全组的入方向只向你的公网 IP `/32` 放行 SSH（通常 TCP 22），不要新增 80、443、8700、5173 规则。若已有更宽泛的规则，确认是否还被其他服务使用，再收紧；本脚本不会修改安全组或 UFW，避免把你锁在服务器外。公网 IP 变化后需更新 SSH 放行来源。

## 4. 首次初始化服务器

以下发布命令都在**本机项目目录**执行：

```bash
cd /Users/Darrendu/Projects/driver-oss
bash deploy/deploy.sh setup driver-ecs
```

脚本通过 SSH 上传初始化文件，再请求 sudo。它会：

- 安装 `curl`、CA 证书、基础编译工具和 `util-linux`。
- 如果尚未安装，使用 Astral 官方安装脚本把 uv 安装到 `/usr/local/bin`，不会修改登录用户的 PATH。
- 创建无登录权限的 `driver-oss` 服务账号及 `/opt/driver-oss`。
- 创建 `/etc/driver-oss.env`（首次从示例复制）及 systemd 服务，但此时不会启动应用。

初始化会以 root 权限执行官方 uv 安装器；需要更严格的软件供应链控制时，先审阅脚本，将安装 URL 固定到经过审核的 uv 版本。重复执行 setup 不会覆盖已有 OSS 配置，但会更新服务定义；已有服务需要之后发布或手动重启才应用新定义。

然后登录 ECS，**在服务器上单独编辑凭证**：

```bash
ssh driver-ecs
sudoedit /etc/driver-oss.env
```

按 `.env.example` 填写：

```dotenv
OSS_ENDPOINT=https://oss-cn-YOUR_REGION.aliyuncs.com
OSS_BUCKET=your-private-bucket
OSS_ACCESS_KEY_ID=your-ram-access-key-id
OSS_ACCESS_KEY_SECRET=your-ram-access-key-secret
OSS_SECURITY_TOKEN=
OSS_PREFIX=personal-drive/
PORT=8700
```

以上全是占位值，不可直接使用。建议 `OSS_PREFIX` 使用专用非空前缀，避免应用操作整个 Bucket。不要使用主账号 AccessKey；RAM 最小权限应覆盖项目需要的列举、读取、写入、分片上传、复制和删除，并按 Bucket/前缀限制。注意限制对象资源之外，列举权限也需正确设置前缀条件。临时 STS 凭证过期后需要更新，本项目没有自动刷新机制。

ECS 与 OSS 同地域时可以考虑 OSS 内网 Endpoint，但必须确认地域和网络可达性；本机开发通常仍用公网 Endpoint。不要为了连通而将 Bucket 改为公开。配置文件保持 `root:driver-oss`、`640` 权限，部署脚本不会上传本机 `.env`。

修改完成后 `exit` 返回本机。服务通过 `.env` 符号链接读取配置；systemd 固定监听端口为 8700，不支持仅修改文件中的 `PORT` 来更换部署端口。

## 5. 本机一条命令发布

```bash
cd /Users/Darrendu/Projects/driver-oss
bash deploy/deploy.sh deploy driver-ecs
```

脚本会在本机执行 `npm ci` 和 `npm run build`，仅打包明确允许的 Python 源码、锁文件和 `frontend/dist`。然后上传并在 ECS 执行：

1. 为新版本建立独立发布目录，通过 `uv sync --locked --no-dev --no-install-project --python 3.12` 安装运行依赖。
2. 以服务账号检查 OSS 必填配置，再切换 `current` 链接并重启单进程服务。
3. 检查 systemd 状态及 `/healthz`、首页、`/api/config`；成功后设置开机启动。

新环境准备失败不会切换已有版本；切换后 HTTP 检查失败会尝试恢复旧版本，首次发布失败则停止服务并报告错误。**不是零停机发布**：切换会短暂中断请求，现有连接和进行中的上传不会迁移。HTTP 检查不代表 OSS 权限和网络都正确，下面仍需实测目录列举和一个小文件。

低配优化包括：不装前端运行时、不安装 Python 开发依赖、限制 uv 安装并发、单 worker。不自动创建 swap，也不设置未经测量的硬性内存限制。首次部分依赖可能需要少量编译，并非完全离线发布。

## 6. 私人访问与首次验收

在本机另开一个终端，保持运行：

```bash
cd /Users/Darrendu/Projects/driver-oss
bash deploy/deploy.sh tunnel driver-ecs
```

浏览器打开 **http://127.0.0.1:18700**。本机用 18700 避开开发服务的 8700；隧道只监听本机回环地址。关闭终端或按 Ctrl+C 后隧道断开，但 ECS 服务仍继续运行并支持开机启动。若端口被占用，请关闭占用进程或手动选择不同本地端口：

```bash
ssh -N -T -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:18701:127.0.0.1:8700 driver-ecs
```

首次验收：

```bash
curl --fail http://127.0.0.1:18700/healthz
curl --fail http://127.0.0.1:18700/api/files
```

再在网页内上传、预览、下载一个**专门用于测试的小文件**，确认内容一致后，仅删除该测试文件。不要在现有真实目录上试递归删除或批量移动。通过同一台 Mac 的 SSH 隧道访问才会成功；其他设备的 `127.0.0.1` 不是这台 ECS。

## 7. 日常维护与回滚

改代码后重复 `deploy` 命令即可。以下维护命令在 ECS 上执行：

```bash
sudo systemctl status driver-oss --no-pager
sudo journalctl -u driver-oss -n 100 --no-pager
sudo journalctl -u driver-oss -f
sudo systemctl restart driver-oss
sudo systemctl stop driver-oss
readlink -f /opt/driver-oss/current
ls -1 /opt/driver-oss/releases
sudo ss -lntp | grep ':8700'
free -h
df -h /
```

`ss` 输出应为 `127.0.0.1:8700`，不是 `0.0.0.0:8700` 或 `[::]:8700`。日志不要公开粘贴，可能包含文件名和业务信息。

发布成功会打印当前和上一版本 ID。要回滚，在**本机**运行（替换为 `releases` 下真实存在的完整目录名）：

```bash
bash deploy/deploy.sh rollback driver-ecs 20261027T020000Z-AbCd1234
```

回滚复用旧代码、静态文件和虚拟环境，重新执行启动检查；**不会回滚共享的 `/etc/driver-oss.env`，更不能恢复已删除或覆盖的 OSS 文件**。修改凭证后需重启；错误的新凭证也可能让旧代码无法工作。

每次发布保留一个虚拟环境，脚本不自动删除旧版本。定期查看磁盘，只手动清理明确不用、且既非当前也非预留回滚目标的完整发布目录。配置文件应另行安全备份；OSS 的版本控制和备份策略需单独规划，并评估费用。

## 8. 常见问题

| 现象 | 排查与处理 |
|---|---|
| SSH 超时 | ECS 是否运行、公网 IP/SSH 端口、安全组来源 IP、UFW、SSH 服务 |
| sudo 失败 | 使用有 sudo 权限的 SSH 账号；脚本通过 `ssh -t` 请求终端，首次建议在交互终端运行 |
| 首次下载很慢或失败 | 检查 ECS DNS、出网、Ubuntu 源、GitHub/Astral/PyPI 可达性；使用经过信任的源，不跳过 TLS 校验 |
| 缺内存或进程被杀 | `free -h`、`sudo journalctl -k --no-pager` 排查 OOM；降低并发/文件大小，必要时扩容或审慎添加 swap |
| 健康检查成功但文件接口失败 | `/healthz` 不访问 OSS；核对 Endpoint、地域、RAM 权限、前缀、STS 是否过期 |
| 页面连接失败 | 隧道是否仍运行；本机访问的是 18700；ECS 服务是否运行；检查本机端口冲突 |
| 首页 503 | 前端构建缺失或安装目录错误；重新通过脚本完整发布，不用 Vite 开发服务器替代 |
| 发布中断 | 先检查 `current` 和服务日志；SSH 中断不保证远端发布已终止，锁释放前不要并行操作 |
| 分片上传重启后失败 | 上传状态在内存中，重启后需重新上传；OSS 侧配置合适的未完成分片清理生命周期并评估影响 |

不要因故障临时把应用端口放行到公网，这会绕过本方案唯一的访问控制边界。

## 9. 工具选择

| 工具 | 用途和建议 |
|---|---|
| OpenSSH / scp | 本方案直接使用；无需额外管理平台，适合个人项目 |
| uv | 安装指定 Python、按 `uv.lock` 建立环境；无需手动替换 Ubuntu Python |
| systemd / journalctl | 开机启动、异常重启、集中查看日志，无额外常驻管理进程 |
| 阿里云云监控 | 查看 CPU、网络等 ECS 指标；内存等指标可能需安装 Agent，启用项及费用以控制台为准 |
| Tailscale | 多设备私人访问的备选方案；涉及第三方服务、网络连通性和额外常驻客户端，本方案不安装 |
| Caddy / Nginx | 将来需要公网域名时再考虑；先补上身份认证和 HTTPS，不能只加反向代理就公开当前应用 |
| Docker Compose | 服务变多时可考虑；本项目暂时不需要，避免在低配 ECS 构建镜像 |

参考资料：

- [阿里云 ECS 安全组说明](https://www.alibabacloud.com/help/en/ecs/user-guide/start-using-security-groups)
- [uv 官方安装说明](https://docs.astral.sh/uv/getting-started/installation/)
- [uv Python 版本管理](https://docs.astral.sh/uv/concepts/python-versions/)
