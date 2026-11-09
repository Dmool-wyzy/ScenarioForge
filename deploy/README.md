# Ubuntu 单机部署

访问地址是 `https://175.27.143.14`。Next.js 和 Python MCP 使用项目目录内的运行时，由 systemd 常驻管理；nginx 使用服务器已经缓存的镜像，仅它监听公网 80/443。Node 只监听回环 3000，MCP 只监听回环 8000，数据库沿用已有 MySQL 3307。所有应用数据放在 MySQL，浏览器只访问网页入口。

不需要拉取 Node、uv 或 Certbot 容器镜像。`compose.yaml` 仅包含 proxy，指定 `pull_policy: never`，不会访问不可达的镜像仓库。此配置使用 Linux host network；一个 Next.js 实例负责网页和后台任务，不横向扩容。

## 1. 项目内的运行时和依赖

部署路径为 `/home/ubuntu/scenarioforge`，以下命令均在项目根目录由 ubuntu 用户执行。创建私有目录后，下载并核验官方 Node 24 Linux x64 tarball，解压到 `deploy/private/runtime/node`。当前验证版本为 24.22.2，校验文件来自同一官方版本目录：

```sh
umask 077
mkdir -p deploy/private/runtime/node deploy/private/acme deploy/private/letsencrypt
chmod 700 deploy/private
chmod 755 deploy/private/acme
cd deploy/private/runtime
curl --fail --location --remote-name https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz
curl --fail --location --remote-name https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
sha256sum --check --ignore-missing SHASUMS256.txt
tar -xJf node-v24.22.2-linux-x64.tar.xz -C node --strip-components=1
cd ../../..
export PATH="$PWD/deploy/private/runtime/node/bin:$PATH"
node --version
npm --version
```

使用主机 Python 3.10 创建仅供安装工具使用的 venv，其中安装 uv 和支持 IP 证书的 Certbot 5.9.0。应用另用 uv 托管的 Python 3.11：

```sh
python3 -m venv deploy/private/certbot-venv
deploy/private/certbot-venv/bin/pip install --no-cache-dir uv certbot==5.9.0
export UV_PYTHON_INSTALL_DIR="$PWD/deploy/private/runtime/python"
export UV_CACHE_DIR="$PWD/deploy/private/uv-cache"
deploy/private/certbot-venv/bin/uv python install 3.11
cd mcp-server
../deploy/private/certbot-venv/bin/uv sync --locked --no-dev --python 3.11
cd ..
npm ci --no-audit --no-fund
```

这些操作不更换系统 Python。Git、发行版基础库及 MySQL 仍由主机提供；镜像缓存或下载归档不得当作用户数据清理。

## 2. 私有配置与生产构建

```sh
cp deploy/runtime.env.example deploy/private/.env.local
chmod 600 deploy/private/.env.local
ln -s deploy/private/.env.local .env.local
```

若根目录已有 `.env.local`，先确认其内容并迁入私有目录，不能覆盖未知配置。安装器只接受指向该私有文件的根目录软链。将已验证的 MySQL CA 复制到 `deploy/private/mysql-ca.pem`，设为 600；配置和 CA 必须可被 ubuntu（UID 1000）读取。

配置中的关键项：

- `DATABASE_URL` 指向 `127.0.0.1:3307/projectdb`，使用项目账号，CA 路径为主机绝对路径 `/home/ubuntu/scenarioforge/deploy/private/mysql-ca.pem`。保留 `sslaccept=strict`，遇到校验错误应修复证书，不关闭校验。
- `SCENARIOFORGE_PUBLIC_ORIGIN=https://175.27.143.14` 必须与用户访问地址一致，用于修改请求的来源校验。
- `SCENARIOFORGE_INTERNAL_TOKEN` 至少 32 字符，Node 与 MCP 使用相同值，可用 `openssl rand -hex 32` 生成。
- 未取得真实模型凭据时，保持 `OPENAI_API_KEY=` 和 `SCENARIOFORGE_MODEL=` 为空、`SEARCH_PROVIDER=mock`、`RAG_ENABLED=false`。登录和项目管理可以独立演示；研究请求明确报配置缺失，不填假 key。
- 模型 key、数据库密码、内部令牌均不得使用 `NEXT_PUBLIC_` 前缀。
- 项目模型设置需要 `SCENARIOFORGE_SETTINGS_KEY`：32 字节随机数据的 base64 编码，生成一次后写入私有环境文件。已部署实例须保留原值，并与数据库备份分开私密保管；不要用本机开发配置覆盖，当前没有自动密钥轮换工具。

`deploy/private/` 和根 `.env.local` 被 Git 忽略。两个服务通过 systemd `EnvironmentFile` 及根软链读取同一份配置。

```sh
npm run db:generate
npm run db:deploy

```

生产只应用已提交的 MySQL migrations，不运行 `migrate dev` 或 `db push`；升级已有数据前先备份。

## 3. 公网 IP 的可信 HTTPS 证书

云安全组和主机防火墙需允许 TCP 80/443 入站。3000/8000 保持回环监听。

Let’s Encrypt 支持公网 IP 证书，必须使用 `shortlived` profile，有效期 160 小时。Certbot 5.4+ 支持 IP 的 webroot 验证；本项目使用 5.9.0，无需域名。官方说明：[IP证书](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)、[Certbot操作](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html)。

首次签发启动只提供 ACME 验证、其他请求返回 503 的临时 HTTP 服务：

```sh
sudo docker run -d --name scenarioforge-acme --network host \
  --mount "type=bind,src=$PWD/deploy/nginx-bootstrap.conf,dst=/etc/nginx/conf.d/default.conf,readonly" \
  --mount "type=bind,src=$PWD/deploy/private/acme,dst=/var/www/acme,readonly" \
  ghcr.nju.edu.cn/world9566/world.blog:nginx-1.28.2-alpine

sudo sh deploy/certbot.sh certonly --non-interactive \
  --agree-tos --register-unsafely-without-email \
  --preferred-profile shortlived \
  --webroot --webroot-path "$PWD/deploy/private/acme" \
  --ip-address 175.27.143.14 --cert-name scenarioforge

sudo docker stop scenarioforge-acme
sudo docker rm scenarioforge-acme
```

若已有运维邮箱，用 `--email 运维邮箱` 替代 `--register-unsafely-without-email`。测试签发可添加 `--staging --cert-name scenarioforge-staging`，正式命令仍使用 `scenarioforge`，staging 证书不受浏览器信任。已经有正式证书时不要重复签发。

证书及续期账户保存在 `deploy/private/letsencrypt/`；证书名必须为 `scenarioforge`，与 nginx 路径一致。

## 4. 启动常驻服务与自动续期

```sh
sudo sh deploy/install-services.sh
sudo docker compose up -d --wait
sudo sh deploy/install-renewal-timer.sh
sudo sh deploy/certbot.sh renew --dry-run --cert-name scenarioforge
curl --fail --location --head https://175.27.143.14
```

安装器生成 `scenarioforge-web.service`、`scenarioforge-mcp.service`，以 ubuntu 运行并自动恢复、开机启动。proxy 独立由 Docker 的重启策略恢复。

nginx 保留 SSE，上传请求上限 30MB；应用仍执行每文件 5MB、最多5个的校验。公网 `/api/internal/` 返回404，IP、协议等来源头由 nginx 覆盖。HTTP 除 ACME 外全部转 HTTPS，生产会话 Cookie 为 Secure。

`scenarioforge-cert-renew.timer` 每天两次并带随机延迟检查续期，随后校验并 reload nginx。整个证书目录只读挂载给 nginx，续期不会因单文件挂载而保留旧证书；Certbot 运行在主机 venv，不拉取镜像。

## 5. 检查和更新

```sh
systemctl status scenarioforge-web scenarioforge-mcp --no-pager
journalctl -u scenarioforge-web -u scenarioforge-mcp -n 100 --no-pager
sudo docker compose logs --tail=100 proxy
systemctl list-timers scenarioforge-cert-renew.timer --no-pager
journalctl -u scenarioforge-cert-renew.service -n 50 --no-pager
```

更新代码时使用独立源码目录构建，旧网页继续运行。2026-11-08 原地构建曾出现异常资源占用并导致服务器失联；重启后独立源码目录加资源上限的构建成功。首次安装的构建也采用此方式，不在包含私有运行时和历史产物的应用目录直接构建。

1. 备份数据库和将覆盖的源码，检查磁盘空间。源码归档使用明确文件清单，排除私有配置、运行时、node_modules、venv、历史构建、缓存和临时文件。
2. 将源码解压到 /home/ubuntu/scenarioforge-build-<发布标识>。依赖完全相同且 Prisma 客户端兼容时，可软链现有 node_modules；依赖或客户端有变化时，在独立目录准备，避免在线修改共享依赖。配置软链指向服务器已有私有配置，不上传本机环境文件。
3. 确认 stage 为此次源码目录绝对路径后执行下列命令。参数来自本次 8 GiB 主机成功发布；失败时停止发布，旧网页继续服务。

~~~sh
build_unit="scenarioforge-build-$(date -u +%Y%m%dT%H%M%SZ)"
sudo systemd-run --unit="$build_unit" --wait --pipe \
  --uid=ubuntu --working-directory="$stage" \
  -p MemoryMax=4G -p MemoryHigh=3500M -p MemorySwapMax=0 \
  -p CPUQuota=200% -p TasksMax=128 -p OOMScoreAdjust=800 \
  -p RuntimeMaxSec=600 \
  /usr/bin/env \
  PATH="/home/ubuntu/scenarioforge/deploy/private/runtime/node/bin:$PATH" \
  NODE_OPTIONS=--max-old-space-size=2048 npm run build
test -s "$stage/.next/BUILD_ID"
~~~

4. 构建成功后确认无活动/排队研究及运行中的成员任务，短暂停止 Web；涉及 MCP 更新时也停止 MCP。再次检查任务状态，应用已在隔离库验证的迁移，更新源码和匹配依赖。把旧 .next 改名保留，再移动完整的新 .next 到应用目录；同一文件系统内使用目录改名，Web 不读取半成品。
5. 启动服务，检查首页、鉴权和迁移状态。失败时恢复此次备份源码和旧构建；数据库是否回退需单独判断，不能用旧库覆盖发布后用户数据。保留至少上一版构建和源码/数据库备份，按明确路径清理本次临时构建。

~~~sh
systemctl is-active scenarioforge-web scenarioforge-mcp mysql-isolated
curl --retry 5 --retry-connrefused --retry-delay 1 --fail http://127.0.0.1:3000/ -o /dev/null
~~~

成功发布标识 personal-review-staged-20261108T085510Z，记录见 docs/VALIDATION.md。临时发布脚本含固定清单与路径，不是通用部署命令，不可直接用于下一次更新。
仅修改 `.env.local` 时重启两个应用服务即可。仅修改 nginx 配置时：`sudo docker compose exec -T proxy nginx -t && sudo docker compose exec -T proxy nginx -s reload`。

验收除首页外还包括注册/登录、创建项目、6位邀请码加入、拒绝非成员、退出和重启后数据保留。真实模型、搜索、Embedding 需提供真实配置后另外验收。

尚未提供数据库自动备份；IP 证书只有六天多，必须保持80端口及续期定时器可用。

## 6. GitHub 文档交付同步

项目创建者在“团队 Git 工作区”关联公开空仓库，生成项目专用部署公钥，在该仓库的 Deploy keys 中添加并启用 Allow write access，随后检查连接、预览并确认推送。成员已确认交付先保存到任务分支，由创建者审查合并本地 main。推送校验审阅过的本地提交和上次检查的远程提交，使用普通推送并再次核对结果；远程有分叉时停止，网页尚不提供拉取和冲突编辑。

Git 存储默认在 deploy/private/repositories（可由 SCENARIOFORGE_GIT_ROOT 指定），每项目凭据在 credentials/<projectId>，私钥不出服务器。使用 ssh.github.com:443、固定官方 Ed25519 主机公钥和严格校验；主机公钥将来轮换时需核验 GitHub 官方公告后更新，不可关闭校验。备份必须同时包含数据库、项目仓库和私有凭据，权限保持目录 0700/文件 0600。轮换/撤销部署密钥在 GitHub 仓库设置中执行；网页尚未提供轮换操作。

2026-11-08 已通过生产网页推送“申威课设”的 README 和测试交付，发布 git-sync-20261108T093232Z，无新增迁移。源码、数据库及上一版构建保留，详细位置见交接第 19 节。2026-11-08 交接清理后服务器剩余约 8.9 GiB；后续构建前仍需检查空间。有效新备份和前一构建对应关系见 docs/HANDOVER.md，清理详情见 docs/CLEANUP.md；当前仍是单 Web 进程仓库锁。
