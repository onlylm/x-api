# 蓝 V 后台联调：双端隔离部署

这些文件仅新增两个实例，不替换既有 GPT、X、partner gateway 或平台订单只读服务。代码与离线测试不代表已经部署。发布前保存本轮提交；两个 tar 以同一 40 位提交 SHA 标识。主发布者负责实际连接和执行。

## 固定运行契约

| 项目 | X 联调实例 | Quefa 管理员入口 |
|---|---|---|
| 实例 | systemd `x-bluev-sandbox` | 新容器 `bluev-test-console` |
| 运行 | Node 24，用户 `xbluevsandbox` | Node 24，UID/GID `1000:1000` |
| 监听 | `127.0.0.1:3112` | `0.0.0.0:3114`，仅现有 Docker 内网，不 publish |
| 程序 | `/opt/x-bluev-sandbox/releases/<commit>` | `/opt/bluev-test-console/releases/<commit>` 只读挂载 `/app` |
| 环境 | `/etc/x-bluev-sandbox/service.env` | `/etc/bluev-test-console/service.env` |
| 数据 | `/srv/x-bluev-sandbox/bluev-sandbox.sqlite` | 无数据库、无旧环境或数据卷 |
| 新销售门闩 | `/srv/x-bluev-sandbox/sales.enabled` | 无 |

X 入口 `dist/bluev-sandbox-server.js`，health 为 `{success:true,service:"bluev-sandbox",isolated:true}`。新库由入口创建并写入用途与密钥指纹，不能预先 touch 空数据库。新商品由后端固定为 3/6 个月、22/44 元且启用，仅运行测试库的付款补查和赠送履约；不注册平台 webhook、结算、退款、旧后台和公开商户接口。新销售门闩关闭后，在途补查与履约继续运行。

Quefa 入口 `dist/bluev-test-console-server.js`，health 为 `{ok:true,service:"bluev-test-console"}`。固定 `QUEFA_FINANCE_ORIGIN=http://app_finance:3100`、`BLUEV_TEST_BASE_URL=https://x.aifu.me/bluev-sandbox`。每次仅用现有 `merchant_admin` Cookie 调用 finance `/admin/api/session` 实时验证。专用 `BLUEV_TEST_KEY` 只在服务器之间使用，不进入 HTML、浏览器或日志。

## 路由与旧后台兜底

X 只新增：

- `/bluev-sandbox/callbacks/alipay`：仅 POST，转新 3112 `/callbacks/alipay`。
- `/bluev-sandbox/internal/bluev-test/*`：仅源地址 `154.198.43.105` 与 loopback 可达，后端还必须验证专用 key。
- `/bluev-sandbox` 其他路径一律 404。旧 `/partner`、`/api`、`/v1`、`/redeem`、`/assets` 不变。

Quefa 只新增 `/admin/bluev-test`、`/admin/api/bluev-test/*`，以及精确 GET/HEAD `/admin`、`/admin/` 的 HTML 壳代理；所有旧业务 API 仍沿旧 handle。壳优先访问新 sidecar，其不可达时直接回退 `app_finance:3100`，当前请求得到 5xx 也立即走原 finance。有限重试仅适用于这些 GET/HEAD 请求；不存在写请求重放或代理回环。

Caddy 候选按引号/注释之外的块父级仅定位 `api.quefa.cn` 的直接子级 `route`，已有 `/bluev/*` 内嵌 `route` 原字节保留；再在原容器内 `adapt --validate`。apply 先保持新容器停止，安装并 reload 候选配置，实际检查 `/admin` 与 `/admin/` 的 GET 原 HTML 字节 SHA、HEAD 200，以及旧 `/admin/api/session`、`/admin/api/test/orders` 匿名状态和响应 SHA 不变，证明旧壳不依赖新容器；通过后才启动新 sidecar 并验证蓝 V 链接和匿名拒绝。

兜底配置使用 [Caddy 官方 reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) 的 `first` 策略、被动健康检查、有限重试及 `handle_response`。目标服务器真实版本的 validate 仍是必要检查。

## 构建和上传清单

X tar 根目录仅包含 `package.json`、`package-lock.json` 和完整 `dist/`。prepare 在全新 release 中执行 `npm ci --omit=dev --ignore-scripts`；不使用或修改旧 node_modules。

Quefa tar 最小布局：

```text
package.json                    # {"type":"module"}
dist/bluev-test-console-server.js
dist/bluev-test-console.js
dist/bluev-test-page.js
```

不得带源码、数据库、环境文件、隐藏文件、符号链接或本机 node_modules。两个 tar 都要求 SHA256。独立目录上传以下脚本，保持文件名，普通配置和备份不输出：

- 两端：`bluev_deploy_common.py`。
- X：`deploy-bluev-sandbox.py`、`configure-bluev-sandbox.mjs`、`x-bluev-sandbox.service`、`bluev-sandbox-nginx.conf`。
- Quefa：`deploy-bluev-test-console.py`、`bluev-test-console-caddy.conf`。

在服务器生成一个独立的 43–128 字符 base64url key，用受限服务器到服务器通道放到两端相同内容的 root 所有、权限 600 的独立文件。`--key-file` 只传路径；不把值放进参数或日志。不要复用旧平台 API Key、后台 token 或商户 secret。

`configure-bluev-sandbox.mjs` 仅在 X 服务器内部读取 `/etc/x-partner-gateway/service.env`，拷贝支付宝与独立 X 商户的七项白名单值；在内存中规范化并验证支付宝 PEM。旧 MASTER_KEY、后台 token、平台 Key、数据库路径、门闩和加密密钥均不进入新服务。新数据库加密与 HMAC 密钥首次生成后不再重建；否则新库用途检查会拒绝启动。

Quefa 可使用本机已存在且未声明匿名 VOLUME 的 Node 24 镜像，但必须传完整不可变 `sha256:...` 镜像 ID；脚本不 pull 镜像。镜像中的旧业务 ENV 逐项显式清空；专用文件提供的七个变量由新 env-file 完整覆盖，不再传空 `--env`，因为 Docker 的显式 `--env` 优先于 env-file，和参数先后无关。设置固定 PATH，覆盖旧 entrypoint、user、working directory，不挂载任何旧数据；准备时以清空全部继承环境、无网络、只读临时新容器检查 Node 24。

## 分阶段命令

两个 `--proxy-sha256` 都必须来自执行当下原文件的原始字节；不得使用旧文档记载的 SHA 代替当前检查。

```sh
# X：新目录和名字必须未被占用；旧销售/worker门闩不存在且旧产品仍停用。
python3 /approved-release/deploy-bluev-sandbox.py prepare \
  --artifact /approved-release/bluev-sandbox.tar.gz \
  --sha256 <X产物SHA256> --release-id <40位commit> \
  --proxy-sha256 <当前/etc/nginx/sites-available/xgift原始SHA256> \
  --key-file /approved-private/bluev-test.key
python3 /approved-release/deploy-bluev-sandbox.py apply
python3 /approved-release/deploy-bluev-sandbox.py verify

# Quefa：网络必须与Caddy/app_finance共用，默认部署中为merchant-gateway_gateway。
python3 /approved-release/deploy-bluev-test-console.py prepare \
  --artifact /approved-release/bluev-test-console.tar.gz \
  --sha256 <控制台产物SHA256> --release-id <相同40位commit> \
  --proxy-sha256 <当前/opt/merchant-gateway/Caddyfile原始SHA256> \
  --key-file /approved-private/bluev-test.key \
  --image sha256:<本机Node24镜像64位ID> --network merchant-gateway_gateway
python3 /approved-release/deploy-bluev-test-console.py apply
python3 /approved-release/deploy-bluev-test-console.py verify
```

X prepare 仅建独立用户/目录、解包、安装新依赖、生成新环境与新门闩，不启动、不修改 Nginx。apply 仅启动新 systemd，健康与匿名拒绝通过后写专用 snippet 和一个 include，`nginx -t` 成功才 reload。

全过程核对旧 X/partner/reader 与 Nginx 主进程 PID、启动时间、current 链接；旧 unit/env/products/partner snippet 哈希与原关闭门闩不变。Quefa 核对所有既有 merchant-gateway 容器 ID/image/StartedAt、compose 哈希、Caddy 文件/活动 JSON 哈希。单文件 bind 原位写、fsync，绝不 rename Caddyfile；检查 inode 和容器所见内容一致。

同一已完成 prepare 的参数重复执行会校验后返回；已 installed 的 apply 只 verify；已 rolled_back 可同版本 apply，代码/环境/原路由和实例身份均必须保持一致。脚本或产物变化不能覆盖已有状态，也不能编辑状态绕过。prepare 中途失败保留现场并拒绝覆盖重跑；它不是跨版本升级器。

## 回滚

```sh
python3 /approved-release/deploy-bluev-test-console.py rollback
python3 /approved-release/deploy-bluev-sandbox.py rollback
```

Quefa 在无并发修改时原位恢复原 Caddy 文件并 reload，只停止新增 sidecar，保留代码、环境及备份；不会影响 X 的回调/worker。

X 首先关闭自己的新销售门闩。独立库出现 `orders`、`checkout_intents` 或 `bluev_test_requests` 任一记录即保留 callback 和 worker，标记 `rollback_required`，防止丢失在途付款。首次扫描为空时先排空新服务，再检查一次；若竞态产生请求，仅重新启动新服务并保留回调。确认完全空库才恢复原 Nginx 并停用新 systemd。任何数据库都不恢复、不删除，旧服务不重启。

检测到并发文件、活动配置、旧实例身份变化会拒绝覆盖并保留现场。备份与部署状态只留各自新 `/opt/.../backups/<commit>` 和 `deploy-state.json`。实际管理员登录、套餐/账号和一笔明确授权的付款赠送联调由主任务完成；部署探针不会创建真实付款、赠送或退款。

## 离线验证

```text
python -m unittest discover -s services/partner-gateway/deploy -p test_bluev_sandbox_deploy.py -v
node --test services/partner-gateway/deploy/test-configure-bluev-sandbox.mjs
python -m py_compile services/partner-gateway/deploy/bluev_deploy_common.py services/partner-gateway/deploy/deploy-bluev-sandbox.py services/partner-gateway/deploy/deploy-bluev-test-console.py
```
