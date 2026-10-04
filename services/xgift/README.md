# GPTibo X API

独立 X API 服务，域名 `x-api.gptibo.com`。可直接部署 Ubuntu 服务器（Node.js 22.18+、SQLite、Nginx），也保留 Cloudflare Worker / D1 运行入口。用户管理、点数钱包、HMAC 签名接口、订单、账号及代理配置与 GPTibo 主站隔离，不能使用主站数据库。

## 当前范围

- 管理员开户、禁用用户、重置密码、凭证入账、独立用户价格。
- 用户登录查看余额、流水、订单，生成及撤销密钥，配置签名回调。
- AES-256-GCM 加密保存 Cookie、代理凭据、API Secret，密钥仅生成时返回。
- 数据库触发器保障订单冻结／消费／退回与状态变更原子执行；账务流水不可修改。
- X 赠送资格检查与报价；服务器原生支持认证 HTTP CONNECT / SOCKS5 代理，Worker 需要出口网关，不会静默改用直连。
- 自动支付执行端的签名协议、账号互斥、可配置每日上限、原任务查询、证据校验已实现。
- 后台「卡台与卡池」可填写持卡人账单资料（英文姓名、账单邮箱、国家与地址），以 AES-GCM 加密保存，仅管理员可读取。接收用户名由每笔商城订单提供，不要求单独配置测试用户名。保存资料不会开卡、注资或启用赠送；原生执行器使用 PP5583RC，并强制执行已确认的首单验收资金上限。
- React 19 + Cloudflare Kumo 2 + Vite 8 独立后台；管理员与用户工作区共用签名及会话后端。
- ZovoCard 沙盒／正式环境配置、账户余额、脱敏卡池、卡产品、消费／充值记录及幂等开卡／注资操作。
- VPS 原生执行器串联 X 建账单、Stripe 金额与收款方核验、按需开卡、单次付款及原账单查询。正式到账仍需用户首笔真实订单验收；银行验证、未知响应保留待核对。

默认套餐是上游仓库的 3／6 个月目录，300／600 BDT 是预期成本校验值。初始迁移中的 300／600 点仅为占位值；上线配置须调整为 1700／3400 点，按 1 点 = 人民币 0.01 元计价。主站当前售价分别为 35／55 元（后台最新配置）；原始迁移的 17／34 元为首次报价，部署不会覆盖后台已调整的价格，上游 BDT 成本单独核验，不能混同汇率。实际 X 商品或接口变化需要重新验证，不能用配置强制上游币种。

## 开发与部署

### 直接部署服务器

1. 本地运行 `npm ci`、`npm ci --prefix services/xgift/server`、`npm run xgift:build`，将 `services/xgift/src`、`server`（包含其生产依赖）、`dist`、`migrations` 和 `shared/xgift-signature.ts` 按原目录结构放入 `/opt/xgift/releases/<commit>`。服务器无需编译前端。
2. 建立独立 `xgift` 系统用户，将 `/srv/xgift/data` 和 `/srv/xgift/backups` 设为其私有目录；程序目录保持 root 所有。`/opt/xgift/current` 指向实际版本。
   使用核对官方 SHA256 的 Node.js 官方 LTS 运行包，将 `/opt/node` 指向其目录。部分 Ubuntu 软件源的 Node.js 关闭了 TypeScript 支持，即使版本号满足也无法运行此入口；不要直接假设 `/usr/bin/node` 支持它。
3. 根据 `server/service.env.example` 创建 root 所有、0600 权限的 `/etc/xgift/service.env`。迁移必须保留旧 `MASTER_KEY`、管理员密码和签名密钥，不要生成新密钥替换。
4. D1 使用 `wrangler d1 export --remote --no-schema` 导出本服务的应用表（见 `server/import.ts`）。停服务后执行 `node --experimental-strip-types server/import.ts NEW_DATABASE DATA_ONLY_EXPORT`。目标必须没有用户业务数据；导入会暂时移除触发器，校验外键与账务，再原子恢复触发器，避免重复入账。切换前应停止旧服务写入并重新导出，不能同时运行两个可写版本。
5. 安装本目录 `server/xgift.service`、`xgift-backup.service`、`xgift-backup.timer`，启用服务与每日备份。进程仅监听 `127.0.0.1:8791`，Nginx 在 HTTPS 域名代理到该端口，覆盖 `Host` 为实际域名、`X-Real-IP` 为可信客户端 IP。DNS 切换、证书签发、腾讯云 80/443 入站规则需就绪后才开放公网。
6. 卡台选择「服务直连」，将服务器实际公网 IPv4 加入卡台白名单。X 代理在后台单独配置，不影响卡台出口。首单验收时配置 `NATIVE_EXECUTION=true`、`PAYMENTS_ENABLED=true` 和从 X 官方客户端核实的 `STRIPE_PUBLISHABLE_KEY=pk_live_...`。银行卡、Cookie、API Secret 不进入前端或源码。

域名迁移时可先用 Certbot DNS 验证签发证书，再切换 DNS。Nginx 使用 `server/nginx-https.conf`，HTTP 与 HTTPS 都保留 ACME 验证文件路径，兼容 Cloudflare 的 HTTPS 重定向。使用橙云代理时，将 `server/cloudflare-realip.conf` 安装到 `/etc/nginx/conf.d/`；仅信任 Cloudflare 官方网段的客户端 IP，直接连接不能伪造 `CF-Connecting-IP` 绕过登录限流。升级时与 `https://www.cloudflare.com/ips-v4`、`ips-v6` 核对网段。

DNS 生效后必须将首次手工证书改为自动 HTTP 验证续期：`sudo certbot reconfigure --cert-name x-api.gptibo.com --webroot --webroot-path /var/www/xgift-acme --preferred-challenges http --non-interactive`。该命令会进行测试续期，成功后才保存配置。将 `server/renew-nginx.sh` 以 root 所有、0755 权限安装到 `/etc/letsencrypt/renewal-hooks/deploy/xgift-nginx`，启用 `certbot.timer`，续期成功后重载 Nginx；不要遗留需要手工 DNS 验证的续期配置。

备份脚本使用 SQLite 在线备份接口，保留最近 14 份；数据库和备份包含加密业务资料，必须限制读取权限并另行做异机备份。升级前备份数据库，原子切换版本目录后重启服务；代码回滚不能盲目撤销已应用的数据库迁移。

### Cloudflare Worker 运行方式

在仓库根目录运行：

```sh
npm ci
npm run xgift:check
node --test tests/xgift.test.ts
node --test tests/xgift-cards.test.ts
npm run xgift:build
npm run xgift:dev
```

1. `npx wrangler d1 create gptibo-x-api`，把返回 ID 写入本目录 `wrangler.jsonc`。
2. `npx wrangler d1 migrations apply gptibo-x-api --remote --config services/xgift/wrangler.jsonc`。
3. 为独立 Worker 设置 `MASTER_KEY`（64 位十六进制随机值）和 `ADMIN_PASSWORD`（至少 24 位随机密码），使用 Wrangler Secret，不写进源码。必须备份 MASTER_KEY；替换它会使已有加密数据无法读取。
4. `npm run xgift:deploy`。自定义域名指向 `x-api.gptibo.com`。确保该域名尚未被其他应用使用。
5. 管理员用 `admin` 登录；开通 GPTibo 专用用户，用户生成 Key ID / Secret。不要把管理员密码当接口密钥。

本地 `.dev.vars` 放在本目录，已被 gitignore 排除：

```dotenv
MASTER_KEY=<64 hex characters>
ADMIN_PASSWORD=<at least 24 random characters>
LOCAL_ORIGIN=http://127.0.0.1:8791
```

`LOCAL_ORIGIN` 仅放在本地 `.dev.vars`，用于 Wrangler 自定义域名的本地 Host 重写；不能配置到生产环境。

`npm run xgift:dev` 在 `http://127.0.0.1:8791` 提供完整后台和 API。需要 React 热更新时，在另一个终端运行 `npm run xgift:frontend`，打开 `http://127.0.0.1:5191`；其开发代理只将该本地来源的 Origin 映射到 8791，其他来源仍由后端拒绝。

### GPTibo 连接

主站 Worker 的 Secrets：`XGIFT_USER_ID`、`XGIFT_KEY_ID`、`XGIFT_CLIENT_SECRET`。
可选 `XGIFT_API_BASE=https://x-api.gptibo.com/v1`。后台「服务接入」显示余额与商品，主站服务器适配器位于 `worker/xgift/client.ts`。前台入口 `/product/x-premium`，主站 `XGIFT_CHECKOUT_ENABLED=true` 时开放。填写用户名后由 `/api/orders/xgift/eligibility` 代签请求，浏览器不接触 X API 密钥。资格凭证绑定买家、用户名、X 数字 ID、套餐和点数，5 分钟有效；付款确认后再次检查账号身份。支付宝回调、前台刷新和每分钟 Cron 通过持久化互斥锁调度同一原订单。

### 出口代理

后台可保存 HTTP CONNECT 或 SOCKS5 节点、启停节点、给账号绑定出口。普通 Worker fetch 不会自动使用系统代理。本版只读报价走：

```
Worker → HTTPS 出口网关 → 指定代理 → X / ipinfo
```

可选 `gateway.py` 使用 Python 标准库，支持认证 HTTP CONNECT，绑定本机 `127.0.0.1:8790`，需要在服务器上由 Caddy 等提供 HTTPS。设置服务器 `GATEWAY_SECRET`，Worker 设置 `OUTBOUND_GATEWAY_URL`、同值 `OUTBOUND_GATEWAY_SECRET`。该网关的 `/v1/request` 只允许 GET X 商品报价与出口检测；`/v1/cards` 另支持白名单中的卡台资金管理接口。它不是通用转发或 X 支付服务。SOCKS5 配置需要另一个兼容网关或执行端，内置网关会明确拒绝。不要把网关直接暴露在公网 HTTP。

### ZovoCard 卡台

在后台「卡台与卡池」填写 API Secret（`sk_...`）、可选 App ID（`ak_...`），选择沙盒或正式环境。仅支持文档中的两个固定 API 主机，不允许自定义第三方地址。Secret 加密保存，前端列表只显示卡号后四位，CVV 不存储。切换环境必须填写该环境的密钥。

文档要求 API Key 配置 IP 白名单。Worker 没有固定出口；默认选择「固定出口网关」，在服务器部署本目录 `gateway.py`，HTTPS 域名通过 Caddy 等转发到回环端口。把服务器实际公网出口 IP 加入卡台白名单，再设置 Worker 的 `OUTBOUND_GATEWAY_URL` 与 `OUTBOUND_GATEWAY_SECRET`。卡台走 `/v1/cards`，签名请求和响应（响应包含 HTTP 状态）；不会经 X 账号的地区代理。只有卡台允许 Worker 出口时才选择直连。

开卡／充值默认关闭。启用后每次操作需 `CHARGE` 确认，金额填写美元分，卡台另收文档规定的手续费。网关服务器还需 `CARD_WRITES_ENABLED=true` 才允许这两个 POST。卡台余额与用户点数分别记账，不会因卡台充值而给用户入账。

操作凭证号绑定请求内容，先落库再向卡台发送一次；未知 400、202、超时、未验证响应都保留待核对，不重新发送 POST；同卡充值与未知开卡有数据库互斥。卡台只缓存 2xx 幂等响应，不能对失败响应盲目重试。结果不明时管理员在卡台核对真实资金记录后，填写核对凭证、实际卡 ID 和 `RESOLVE` 人工确认；人工确认不执行支付，也不影响 X 订单。终态不可再次修改。

文档末尾的 `product=x` 是本人新订阅，首版地区列表不含 BDT，且文档明确不表示已上线。它不是 X Premium 赠送 API。卡台取卡及资金管理与赠送执行是两个步骤，现有卡台接入不会自动开放赠送订单；原生 X／Stripe 执行器位于 `server/native-executor.ts`，独立于卡台自带充值产品。

### 自动支付执行端协议

服务器可选择原生执行器（`NATIVE_EXECUTION=true` + 有效 Stripe 公钥）或外部执行器（有效 `EXECUTOR_URL` + 至少 32 位 `EXECUTOR_SECRET`），两者都需 `PAYMENTS_ENABLED=true` 才接受新订单。账号需配置并启用，执行端负责银行卡管理及真实支付核验。关闭付款后已有任务仍继续查询。

`POST /v1/jobs` 收到：`order_id,recipient,product_code,months,stripe_product,currency,amount_minor,account_id,account,proxy`。请求头 `Idempotency-Key=order_id`。Cookie 等凭据只发给管理员部署的可信 HTTPS 执行端。执行端必须先持久化任务和原支付证据，再发起有副作用的操作，且永久按 order_id 去重。Worker 不会自动重新发送丢失响应的 POST。

后续 `GET /v1/jobs/:order_id` 只查询原任务。请求签名原文为换行分隔的 `method,path,timestamp,nonce,SHA256(raw_body)`，使用 HMAC-SHA256。响应必须设置 `X-Response-Signature=HMAC(secret,timestamp+'.'+nonce+'.'+raw_response_body)`，绑定本次请求。执行端也应校验时间与随机数，禁止签名重放。

响应：

```json
{
  "order_id": "ord_...",
  "status": "succeeded",
  "evidence": {
    "payment_status": "paid",
    "gift_status": "completed",
    "recipient": "username",
    "product_code": "x-premium-3m",
    "currency": "bdt",
    "amount_minor": 30000,
    "receipt_id": "verified-payment-reference"
  }
}
```

成功只有在证据全部匹配订单快照时消费点数。`failed` 还必须带 `financial_state=not_charged` 才退回；超时、异常响应、已扣款但赠送未确认全部保留 `unknown` 并冻结余额。运行中的订单不可通过后台手动取消。原生服务器每 5 秒处理一个任务并投递一个回调，Worker 入口每分钟；第一版适用于小规模业务，扩大吞吐应再接 Queues。账号每日上限默认 300，可在 1–300 之间调整且无需重新填写 Cookie；这是本服务的调度额度，并非 X 平台允许赠送次数的保证。以 UTC 日期计数，失败提交也占用本日槽位；X 的实际窗口与资格仍必须由执行端核验。

## 外部 API

### 首单验收边界

商城和 X API 分别原子保留一个真实赠送名额，防止两笔客户付款争用首单额度。取消未付款订单可以释放商城名额；不明支付不会释放名额或自动重试扣款。首笔已完成后须核实真实到账，再另行调整验收额度。

首笔订单通过资格、BDT 价格和 Stripe 收款方检查后才开 PP5583RC 卡，注资 20 USD，开户费最多 0.50 USD。开卡参数把单笔、日、月与总交易限额设为 10 USD；数据库还限制每日注资最多 20 USD。首单版本不会循环开新卡或自动追加资金。卡号与 CVV 只在支付调用期间使用，不写入数据库或日志；订单、结账会话与付款证据加密持久化。

付款提交前先持久化阶段，提交丢失响应后只查询同一 Stripe 会话。`checkout_completed` 代表已核验 X 赠送结账付款，未独立证明接收账号权益到账，前台明确要求到 X 核对。3DS／其他人工验证停留待核对，不伪报成功、不重复扣款。`PAYMENTS_ENABLED=false` 可暂停尚未提交的付款；已经提交的会话仍可只读查询。

GPTibo 初次内部履约点数须使用注明用途的管理入账凭证，不把内部额度记成客户现金充值。部署需要先迁移独立 SQLite 和主站 D1，再更新两边程序；保留数据库、加密主密钥与原签名凭据。若已有真实订单，不回退到不认识原生执行阶段的版本，也不恢复旧数据库快照覆盖账务。

所有接口需要 `X-Partner-Id`、`X-Key-Id`、`X-Timestamp`、`X-Nonce`、`X-Signature`，POST 加 `Idempotency-Key`。签名算法见 `shared/xgift-signature.ts`，与 GPTibo 的现有签名格式一致。时间偏差最多 300 秒，同一 Key 的 nonce 不可重复。

| 方法 | 路径                               | 功能                                             |
| ---- | ---------------------------------- | ------------------------------------------------ |
| GET  | `/v1/products`                     | 用户商品及点数价格                               |
| GET  | `/v1/balance`                      | 可用／冻结点数                                   |
| POST | `/v1/eligibility`                  | `{username}`；只读检测 eligible，返回规范用户名、数字 ID 和原因，每用户 20 次/分钟 |
| GET  | `/v1/capabilities`                 | 执行器与剩余首单验收名额状态 |
| POST | `/v1/orders`                       | 下单：merchant_order_no、product_code、recipient；原生模式另需 recipient_id、expected_points |
| GET  | `/v1/orders/:id`                   | 查询原订单                                       |
| GET  | `/v1/orders?merchant_order_no=...` | 按商户单号查询                                   |

同一用户的商户单号和幂等键绑定同一请求；变更参数返回 409。余额整数计点；货币金额用最小单位。回调配置在用户后台：签名 `HMAC-SHA256(secret,timestamp+'.'+raw_body)`，`X-Event-Id` 去重，最多重试 10 次。查询接口是回调遗漏后的补偿途径。不会在日志、用户接口或列表接口返回 Cookie 和 Secret。

## 验证

真实 SQLite 事务测试覆盖并发余额、冻结和终态结算、重复入账与下单、租户隔离、签名重放、密钥撤销、权限和 CSRF、秘密脱敏、未知支付只查询原单、执行端证据及回调重试。测试数据全为虚构凭据，不会创建真实 X 账单或付款。
