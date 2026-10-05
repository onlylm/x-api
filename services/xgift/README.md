# Bugan.cn X API

独立 X API 服务，域名 `x.aifu.me`。可直接部署 Ubuntu 服务器（Node.js 22.18+、SQLite、Nginx），也保留 Cloudflare Worker / D1 运行入口。用户管理、点数钱包、HMAC 签名接口、订单、账号及代理配置与 Bugan.cn 主站隔离，不能使用主站数据库。

## 当前范围

- 管理员开户、禁用用户、重置密码、凭证入账、独立用户价格。
- 用户登录查看余额、流水、订单，生成及撤销密钥，配置签名回调；商户可管理自己的套餐卡密。
- AES-256-GCM 加密保存 Cookie、代理凭据、API Secret，密钥仅生成时返回。
- 数据库触发器保障订单冻结／消费／退回与状态变更原子执行；账务流水不可修改。
- X 赠送资格检查与报价；服务器原生支持认证 HTTP CONNECT / SOCKS5 代理，Worker 需要出口网关，不会静默改用直连。
- 自动支付执行端的签名协议、账号互斥、可配置每日上限、原任务查询、证据校验已实现。
- 后台「卡台与卡池」可填写持卡人账单资料（英文姓名、账单邮箱、国家与地址），以 AES-GCM 加密保存，仅管理员可读取。接收用户名由每笔订单提供，不要求单独配置测试用户名。保存资料不会开卡、注资或启用赠送；当前指定卡使用已有卡，旧自动开卡流程的 PP5583RC 与资金边界单独保留。
- React 19 + Cloudflare Kumo 2 + Vite 8 独立后台；管理员与用户工作区共用签名及会话后端。
- ZovoCard 沙盒／正式环境配置、账户余额、脱敏卡池、卡产品、消费／充值记录及幂等开卡／注资操作。
- VPS 原生执行器串联 X 建账单、Stripe 金额与收款方核验、按需开卡、单次付款及原账单查询。正式到账仍需用户首笔真实订单验收；银行验证、未知响应保留待核对。

默认套餐是上游仓库的 3／6 个月目录，300／600 BDT 是预期成本校验值。初始迁移中的 300／600 点仅为占位值；上线配置须调整为 1700／3400 点，按 1 点 = 人民币 0.01 元计价。主站当前售价分别为 35／55 元（后台最新配置）；原始迁移的 17／34 元为首次报价，部署不会覆盖后台已调整的价格，上游 BDT 成本单独核验，不能混同汇率。实际 X 商品或接口变化需要重新验证，不能用配置强制上游币种。

## 开发与部署

### 卡密兑换与直充两种模式

两种入口共用订单、商户点数钱包、支付执行器和对账流程。卡密表示一个固定套餐的兑换资格；它不代表已付款、已赠送或预先冻结了商户额度。

| 模式 | 操作人及流程 | 点数来源 |
| --- | --- | --- |
| 卡密兑换 | 管理员选择所属商户生成卡密，或商户登录后为自己生成已启用套餐的卡密；持有人在 `/redeem` 公开兑换页验卡、检查 X 账号资格、确认兑换，再凭原卡查询进度 | 兑换成功创建订单时，按所属商户当时的套餐点数价冻结 |
| 直充 | 登录商户后台或调用签名接口，选择套餐、检查 X 用户名与数字 ID，再提交订单 | 当前登录／签名商户的钱包 |

管理员或商户生成卡密时可设置批次说明、数量（1–100）和有效天数（1–365），并撤销尚未使用的卡密。商户用开户邮箱及密码登录，进入「卡密管理」操作；只能生成、查询和撤销归属于自己的卡密，也能查看自己卡密绑定的原订单。卡密归属由服务端登录会话决定，不接受客户端改为其他商户；不开放付款卡、账号代理或其他商户数据。

生成不扣点、不预留库存额度；请在客户兑换前确保商户有足够点数。商户只能为当前已启用的套餐生成卡密，页面显示该商户当前套餐点数价，实际冻结价格以兑换时为准。卡密使用 192 位随机值，仅在生成响应中返回一次；数据库仅保存 SHA-256 摘要及后四位，管理列表和审计日志不会返回完整卡密。请在生成后的弹窗中复制并妥善交付原始卡密；不能从数据库恢复其明文。

公开兑换接口不要求商户登录，但要求同源 POST，并按客户端 IP、有效卡密和所属商户限制资格查询频率。卡密始终在 JSON 请求体中提交，不放入 URL 或浏览器本地存储。资格查询只允许有效且未使用的卡密，正式兑换会重新验证用户名对应的 X 数字 ID 与赠送资格。

同一卡密永久绑定首次成功创建的订单。重复提交同一账号返回原订单；改换账号返回 409，不生成第二单、不重复冻结。余额不足、暂停支付、商品／所属商户停用或每日接单额度已满时不消耗卡密。订单状态未知时继续冻结点数并查询原任务；明确失败时退回所属商户点数，但卡密仍保留失败原单，不能再次兑换。补发须由管理员核对后另行生成新卡。

新增订单的 `mode` 为 `direct` 或 `voucher`，历史订单迁移为 `direct`；卡密订单额外保存内部 `voucher_id`。卡密、直充共同遵守原生执行器每日接单额度及同一接收账号的未结单保护。不同账号可以排队，付款仍逐笔执行。卡密生成不会开启支付、接单、开卡或注资。本服务已停止新的支付宝扫码购买，历史收款继续核对。

以下接口均使用现有 `{ data: ... }`／`{ error: ... }` 响应封装：

| 方法与路径 | 请求／返回 |
| --- | --- |
| `POST /api/admin/vouchers` | 管理员会话；`{user_id,product_code,quantity,expires_in_days,batch_label}`，返回批次 ID 和仅本次可见的卡密 |
| `GET /api/admin/vouchers?page=1` | 管理员会话；返回脱敏卡密列表 |
| `POST /api/admin/vouchers/:id/revoke` | 管理员会话；`{note}`，撤销未使用卡密 |
| `POST /api/vouchers` | 商户会话；`{product_code,quantity,expires_in_days,batch_label}`，只为当前商户生成已启用套餐的卡密，明文仅本次返回 |
| `GET /api/vouchers?page=1&status=available&q=批次` | 商户会话；只查询本商户的脱敏卡密，先筛选再分页 |
| `POST /api/vouchers/:id/revoke` | 商户会话；`{note}`，只撤销本商户未使用卡密；其他商户卡密与不存在的 ID 均返回 404 |
| `POST /api/redeem/inspect` | `{code}`，查询套餐、有效期和卡密状态 |
| `POST /api/redeem/eligibility` | `{code,username}`，只读返回规范用户名、数字 ID 和资格 |
| `POST /api/redeem` | `{code,recipient,recipient_id}`，创建或查询已绑定订单 |
| `POST /api/redeem/status` | `{code}`，查询原绑定订单的公开进度 |
| `GET /api/capabilities` | 公开只读；返回执行是否就绪、是否接受新订单、简要阻断代码及支持模式，不返回账户、额度或订单详情 |
| `POST /api/eligibility` | 商户会话；`{username}`，直充资格检查 |
| `POST /api/orders` | 商户会话；沿用直充请求与幂等规则 |

公开卡密视图只包含 `state`（`available/redeemed/revoked/expired`）、`product`（`code/name/months`）、`expires_at`，以及可选 `order`（`id/product_code/recipient/status/failure_code/created_at/updated_at`）。不公开商户身份、点数价格、商户单号、收据或支付凭据。`redeemed` 表示卡密已绑定订单，须继续查看订单状态；原生执行器的成功仍表示已验证结账，接收账号权益需到 X 核对。

上线前先备份数据库、应用新增迁移，再发布对应服务与前端。测试只使用内存数据库及模拟上游，不可用真实卡密或真实付款验收并发用例。若需回滚，保留新数据库和订单绑定记录，不能回到不认识卡密订单的旧版本继续接单。

### 直接部署服务器

1. 本地运行 `npm ci`、`npm ci --prefix services/xgift/server`、`npm run xgift:build`，将 `services/xgift/src`、`server`（包含其生产依赖）、`dist`、`migrations` 和 `shared/xgift-signature.ts` 按原目录结构放入 `/opt/xgift/releases/<commit>`。服务器无需编译前端。
2. 建立独立 `xgift` 系统用户，将 `/srv/xgift/data` 和 `/srv/xgift/backups` 设为其私有目录；程序目录保持 root 所有。`/opt/xgift/current` 指向实际版本。
   使用核对官方 SHA256 的 Node.js 官方 LTS 运行包，将 `/opt/node` 指向其目录。部分 Ubuntu 软件源的 Node.js 关闭了 TypeScript 支持，即使版本号满足也无法运行此入口；不要直接假设 `/usr/bin/node` 支持它。
3. 根据 `server/service.env.example` 创建 root 所有、0600 权限的 `/etc/xgift/service.env`。迁移必须保留旧 `MASTER_KEY`、管理员密码和签名密钥，不要生成新密钥替换。
4. D1 使用 `wrangler d1 export --remote --no-schema` 导出本服务的应用表（见 `server/import.ts`）。停服务后执行 `node --experimental-strip-types server/import.ts NEW_DATABASE DATA_ONLY_EXPORT`。目标必须没有用户业务数据；导入会暂时移除触发器，校验外键与账务，再原子恢复触发器，避免重复入账。切换前应停止旧服务写入并重新导出，不能同时运行两个可写版本。
5. 安装本目录 `server/xgift.service`、`xgift-backup.service`、`xgift-backup.timer`，启用服务与每日备份。进程仅监听 `127.0.0.1:8791`，Nginx 在 HTTPS 域名代理到该端口，覆盖 `Host` 为实际域名、`X-Real-IP` 为可信客户端 IP。DNS 切换、证书签发、腾讯云 80/443 入站规则需就绪后才开放公网。
6. 卡台选择「服务直连」，将服务器实际公网 IPv4 加入卡台白名单。X 代理在后台单独配置，不影响卡台出口。当前部署使用下文的后台指定卡与每日接单设置；仅旧环境变量模式需要 `NATIVE_EXECUTION=true`、`PAYMENTS_ENABLED=true` 与有效 `STRIPE_PUBLISHABLE_KEY=pk_live_...`。银行卡、Cookie、API Secret 不进入前端或源码。

域名迁移时可先用 Certbot DNS 验证签发证书，再切换 DNS。Nginx 使用 `server/nginx-https.conf`，HTTP 与 HTTPS 都保留 ACME 验证文件路径，兼容 Cloudflare 的 HTTPS 重定向。使用橙云代理时，将 `server/cloudflare-realip.conf` 安装到 `/etc/nginx/conf.d/`；仅信任 Cloudflare 官方网段的客户端 IP，直接连接不能伪造 `CF-Connecting-IP` 绕过登录限流。升级时与 `https://www.cloudflare.com/ips-v4`、`ips-v6` 核对网段。

DNS 生效后必须将首次手工证书改为自动 HTTP 验证续期：`sudo certbot reconfigure --cert-name x.aifu.me --webroot --webroot-path /var/www/xgift-acme --preferred-challenges http --non-interactive`。该命令会进行测试续期，成功后才保存配置。将 `server/renew-nginx.sh` 以 root 所有、0755 权限安装到 `/etc/letsencrypt/renewal-hooks/deploy/xgift-nginx`，启用 `certbot.timer`，续期成功后重载 Nginx；不要遗留需要手工 DNS 验证的续期配置。

备份脚本使用 SQLite 在线备份接口，保留最近 14 份；数据库和备份包含加密业务资料，必须限制读取权限并另行做异机备份。升级前备份数据库，原子切换版本目录后重启服务；代码回滚不能盲目撤销已应用的数据库迁移。

### Cloudflare Worker 运行方式

模板名称 `bugan-x-api` 仅用于新建资源；已有 Worker / D1 应保留实际资源名称与数据库 ID，品牌变更不要求迁移或重建数据库。当前 VPS 发布不会部署 Worker。

在仓库根目录运行：

```sh
npm ci
npm run xgift:check
node --test tests/xgift.test.ts
node --test tests/xgift-cards.test.ts
npm run xgift:build
npm run xgift:dev
```

1. `npx wrangler d1 create bugan-x-api`，把返回 ID 写入本目录 `wrangler.jsonc`。
2. `npx wrangler d1 migrations apply bugan-x-api --remote --config services/xgift/wrangler.jsonc`。
3. 为独立 Worker 设置 `MASTER_KEY`（64 位十六进制随机值）和 `ADMIN_PASSWORD`（至少 24 位随机密码），使用 Wrangler Secret，不写进源码。必须备份 MASTER_KEY；替换它会使已有加密数据无法读取。
4. `npm run xgift:deploy`。自定义域名指向 `x.aifu.me`。确保该域名尚未被其他应用使用。
5. 管理员用 `admin` 登录；开通 Bugan.cn 专用用户，用户生成 Key ID / Secret。不要把管理员密码当接口密钥。

本地 `.dev.vars` 放在本目录，已被 gitignore 排除：

```dotenv
MASTER_KEY=<64 hex characters>
ADMIN_PASSWORD=<at least 24 random characters>
LOCAL_ORIGIN=http://127.0.0.1:8791
```

`LOCAL_ORIGIN` 仅放在本地 `.dev.vars`，用于 Wrangler 自定义域名的本地 Host 重写；不能配置到生产环境。

`npm run xgift:dev` 在 `http://127.0.0.1:8791` 提供完整后台和 API。需要 React 热更新时，在另一个终端运行 `npm run xgift:frontend`，打开 `http://127.0.0.1:5191`；其开发代理只将该本地来源的 Origin 映射到 8791，其他来源仍由后端拒绝。

### Bugan.cn 连接

主站 Worker 的 Secrets：`XGIFT_USER_ID`、`XGIFT_KEY_ID`、`XGIFT_CLIENT_SECRET`。
可选 `XGIFT_API_BASE=https://x.aifu.me/v1`。后台「服务接入」显示余额与商品，主站服务器适配器位于 `worker/xgift/client.ts`。前台入口 `/product/x-premium`，主站 `XGIFT_CHECKOUT_ENABLED=true` 时开放。填写用户名后由 `/api/orders/xgift/eligibility` 代签请求，浏览器不接触 X API 密钥。资格凭证绑定买家、用户名、X 数字 ID、套餐和点数，5 分钟有效；付款确认后再次检查账号身份。支付宝回调、前台刷新和每分钟 Cron 通过持久化互斥锁调度同一原订单。

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

### 卡密工作流与后台分区

后台将常用任务分开：**订单与队列**查看排队、执行与待核对订单；**接单设置**调整每日额度与新接单开关；**X 付款设置**管理发布公钥、主卡、备用卡与付款开关；**卡台与卡池**管理卡台连接、账单资料和卡列表。客户使用 `/redeem` 卡密兑换，商户点数直充继续保留。支付宝配置和新购买入口退出主流程，历史收款在订单页单独查阅。保存设置不会自动开启真实交易。

配置顺序：

1. 保存正式环境、服务直连的卡台 API，完成 X 赠送账号、代理、真实持卡人账单资料及套餐配置。
2. 在 X 付款配置填写从 X 官方客户端核实的 `pk_live_` 发布公钥，从卡台列表选择一张已有 `ACTIVE` 主卡，可按顺序再选最多 3 张备用卡。每张卡余额至少 10 USD 是检查门槛，**不是该卡的硬消费限额**；请在卡台自行核实实际限额。默认不配置备用卡，不会自动开卡、充值、调整限额或从未授权卡池选卡。
3. 检查并确认启用 X 付款（`ENABLE_PAYMENTS`），在「接单设置」设定每日上限并确认开放（`UPDATE_ORDER_LIMITS`）。暂停新接单不会取消原单或停止已接订单履约与核对。服务器 `PAYMENTS_LOCKED=true` 可强制停付。后台配置优先于旧的 `PAYMENTS_ENABLED`，但不能绕过紧急锁。
4. 为商户配置足够点数，在「卡密管理」生成并交付卡密。不同接收账号的兑换订单可以同时进入队列；不需要配置支付宝。

#### 多单排队与原单处理

原生执行器按创建时间、订单 ID 依次取队首，并在同一数据库事务中占用执行位置。即使有多个任务进程，或原单尚未到下次查询时间，也不会同时执行下一笔付款。有 `running` 或 `unknown` 原单时，后续订单留在队列；同一接收账号仍只允许一笔未结单。每日限额、商户点数冻结、卡密永久绑定与终态账务触发器继续有效。

管理员在「订单与队列」可筛选状态、查看排队位置并操作原单：

- **核对原单**：只查询选中的原支付，不新建账单、不提交扣款，也不顺带执行其它队列订单。
- **打开付款界面**：只为已提交付款、仍待核对的原生订单返回保存的原 Stripe 结账地址；不会拼接一个新链接。须是 HTTPS、精确 `checkout.stripe.com` 主机且会话与原订单相符。链接仅管理员按需获取，不出现在卡密公开查询或普通商户列表。打开后先查看支付状态，可能需要本人完成银行验证；自动付款尚未提交的订单不能通过此入口抢先付款。
- **关闭订单**：填写原因并确认。排队且尚未执行，或服务器能确定尚未创建外部付款会话的订单，可安全关闭并由账务触发器退回商户冻结点数。卡密仍绑定原关闭单，不能重复兑换。工作进程仍占用订单时先等本次操作完成再核对。已有付款会话、3DS 或结果不明的订单不按本地“未付”强行关单，仍需核实原付款；关闭本站记录不等于取消 Stripe 会话或退款。

这些管理操作均要求管理员会话；更改状态要求同源 JSON、明确确认，并保留操作记录。升级不自动扩大既有每日额度，不主动发起验收付款。

#### 卡台列表同步与备用卡容错

「同步卡台」会重新读取卡台当前卡列表，不修改已选卡或启停设置。页面可见且未正在操作表单或确认弹窗时，每 30 秒也会更新列表并从读取错误恢复，不覆盖未保存的选卡草稿。余额与状态标明为卡台缓存数据；本版不假设官方列表接口支持强制向发卡行同步。保存配置、启用付款和实际执行前仍使用既有单卡实时核验。只因某张卡不在当前分页，不能判定已删除；更换卡台后必须在新卡台重新选卡，不复用旧卡台相同数字 ID。

原生订单会冻结主卡、备用卡顺序及卡台配置。仅在生成 Stripe 支付方式之前，且卡片身份和数据完整、确认冻结／注销／过期或余额不足时，才按顺序切到下一张指定备用卡。每次切换持久化并记入操作记录，不更改全局主卡、不重复创建赠送订单。卡台网络异常、身份或响应异常不触发换卡；银行卡信息提交结果不明、已生成支付方式、已提交扣款、3DS 或扣款结果未知时，保持原卡与原账单核对，绝不换卡重扣。

候选卡只按顺序轮转一轮。全部不可用时订单保留待核对并显示明确原因，不伪报失败退款或成功；最后一张候选卡仍可只读重查，管理员恢复其余额或状态后，可在原订单与原配置下继续。已有历史订单不自动吸收后来增加的备用卡。异常提示与切卡记录位于后台订单及操作记录，本功能不等同于已配置 Telegram 推送。

#### 历史支付宝订单保留

服务端默认停止新扫码购买、资格查询、新建二维码及重新启用支付宝的操作，不能通过旧页面或直接 API 绕过。既有加密配置、售价和订单不删除；有效凭证仍可在 `/buy` 查询原单。历史签名通知、原交易查询、已付款履约及到期窗口核对继续运行，但不补建二维码。兼容性测试显式注入 `ALIPAY_SALES_ENABLED` 来覆盖旧链路；生产服务器入口不读取或开启该开关。

历史收款以服务端 RSA2 验签及冻结的商户、订单、金额校验为准，不信任浏览器的付款成功标记。重复回调、刷新和恢复任务只入账并创建同一赠送订单一次；人民币实收与内部履约点数分开管理，系统结算用户不用于客户余额充值。支付宝已收款不等于 X 权益已到账；赠送失败或需要 3DS 时保持“已付款，待处理”，不伪报成功、不另开新卡重扣。

原生新订单受**后台每日接单上限**约束，按北京时间 00:00 重置，卡密、直充与历史扫码预占共享额度；确认付款转赠送订单不会重复计算，跨日付款仍归原二维码创建日。已有订单不会因降低上限或暂停接单被取消，已付款扫码订单仍按原付款配置履约。未结赠送订单不会阻止不同账号排队，但阻止下一单付款；历史未结收款仍保留其核对保护。指定卡或卡台连接在未结单时不可随意更改。

预创建同时设置交易与二维码期限，重试只能缩短剩余有效期，不能延长原订单截止时间。过期窗口只在验签关单、查询及并发检查通过后释放；网络超时、未知响应和未决成功证据继续保留原单待核对。关闭付款窗口**不代表退款**。本版本不自动退款，实收后赠送失败须由管理员核对支付宝交易与 X 原账单，按实际结果人工处理；不要通过删除数据库记录、重复下单或恢复旧数据库来处理资金异常。

收款版本使用 `0006`、`0007` 迁移；每日接单版本追加 `0008`，保留既有数据库、主密钥、付款与收款开关。接单设置初始为暂停、每日 1 笔，须管理员自行调整并确认开放；不会自动扩大真实扣款额度。缺少真实商户配置时仅可完成本地模拟验证；上线后仍需商户自行完成授权的真实验收。

协议依据：[支付宝预创建](https://developer.alibaba.com/docs/api.htm?apiId=862&docType=4)、[关闭交易](https://developer.alibaba.com/docs/api.htm?apiId=1058&docType=4)。

### 旧环境变量 / 外部执行器兼容

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

### 每日接单与资金边界

后台「接单设置」允许管理员设置 1–10000 笔的全站原生接单日上限。统计非失败订单与尚未释放的历史扫码预占，同一购买只计一次；明确失败的赠送订单、经核实关闭且未支付的二维码可以释放额度。不明支付不会释放名额或自动重试扣款。此限额不是银行卡消费限额，也不替代 X 账号的每日调度额度；外部执行器保持原有接单行为，未接入这项原生限额。

管理员接口：`GET /api/admin/admission` 返回开关、北京时间当日用量、余额、下次重置时间与实际未就绪原因；`POST /api/admin/admission/config` 以 `{revision,enabled,daily_limit,confirmation}` 保存，开放时须 `confirmation=UPDATE_ORDER_LIMITS`，过期版本返回 409；`POST /api/admin/admission/enabled` 仅接受 `{enabled:false}` 暂停新接单。均要求管理员会话，写操作校验 CSRF。暂停新单与关闭 X 付款是两个不同操作。

以下自动开卡规则仅保留用于**未保存后台付款配置的旧原生执行流程**，不是当前指定卡模式：首笔订单通过资格、BDT 价格和 Stripe 收款方检查后才开 PP5583RC 卡，注资 20 USD，开户费最多 0.50 USD；开卡参数将单笔、日、月与总限额设为 10 USD，数据库每日注资最多 20 USD。后台指定卡模式始终不调用开卡或充值，不自动修改已有卡限额。卡号与 CVV 只在支付调用期间使用，不写数据库或日志；订单、结账会话与付款证据加密持久化。

付款提交前先持久化阶段，提交丢失响应后只查询同一 Stripe 会话。`checkout_completed` 代表已核验 X 赠送结账付款，未独立证明接收账号权益到账，前台明确要求到 X 核对。3DS／其他人工验证停留待核对，不伪报成功、不重复扣款。`PAYMENTS_ENABLED=false` 可暂停尚未提交的付款；已经提交的会话仍可只读查询。

Bugan.cn 初次内部履约点数须使用注明用途的管理入账凭证，不把内部额度记成客户现金充值。部署需要先迁移独立 SQLite 和主站 D1，再更新两边程序；保留数据库、加密主密钥与原签名凭据。若已有真实订单，不回退到不认识原生执行阶段的版本，也不恢复旧数据库快照覆盖账务。

所有接口需要 `X-Partner-Id`、`X-Key-Id`、`X-Timestamp`、`X-Nonce`、`X-Signature`，POST 加 `Idempotency-Key`。签名算法见 `shared/xgift-signature.ts`，与 Bugan.cn 的现有签名格式一致。时间偏差最多 300 秒，同一 Key 的 nonce 不可重复。

| 方法 | 路径                               | 功能                                             |
| ---- | ---------------------------------- | ------------------------------------------------ |
| GET  | `/v1/products`                     | 用户商品及点数价格                               |
| GET  | `/v1/balance`                      | 可用／冻结点数                                   |
| POST | `/v1/eligibility`                  | `{username}`；只读检测 eligible，返回规范用户名、数字 ID 和原因，每用户 20 次/分钟 |
| GET  | `/v1/capabilities`                 | 执行器就绪及当前是否可接新单（含原生每日额度、未结订单保护） |
| POST | `/v1/orders`                       | 下单：merchant_order_no、product_code、recipient；原生模式另需 recipient_id、expected_points |
| GET  | `/v1/orders/:id`                   | 查询原订单                                       |
| GET  | `/v1/orders?merchant_order_no=...` | 按商户单号查询                                   |

同一用户的商户单号和幂等键绑定同一请求；变更参数返回 409。余额整数计点；货币金额用最小单位。回调配置在用户后台：签名 `HMAC-SHA256(secret,timestamp+'.'+raw_body)`，`X-Event-Id` 去重，最多重试 10 次。查询接口是回调遗漏后的补偿途径。不会在日志、用户接口或列表接口返回 Cookie 和 Secret。

## 验证

真实 SQLite 事务测试覆盖并发余额、冻结和终态结算、重复入账与下单、租户隔离、签名重放、密钥撤销、权限和 CSRF、秘密脱敏、未知支付只查询原单、执行端证据及回调重试。卡密回归测试额外覆盖不同账号并发兑换只生成一单、失败后不复活、过期／撤销／暂停／余额不足不误耗卡、资格复核、限流和直充兼容；所有夹具按顺序加载完整迁移。测试数据全为虚构凭据，不会创建真实 X 账单或付款。完整运行命令为 `npm test`，卡密专项为 `node --test tests/xgift-vouchers.test.ts`；每日限额专项 `node --test tests/xgift-admission.test.ts` 覆盖北京时间日界、三入口最后名额竞争、支付宝转单不重复计数、暂停／降额／跨日的已付款履约、管理员权限及升级数据保全。
