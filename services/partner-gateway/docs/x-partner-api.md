# AI京东蓝V接入说明（服务端 API）

本接口实现：客户在京东网站选套餐并确认 X 用户名 → 扫码向我方付款 → 我方确认到账并自动赠送 → 京东查询并展示结果。京东不需要部署履约服务，也不需要接入卡台。

接口基址：`https://api.quefa.cn/bluev/api/v1/checkout`。京东统一使用此域名和独立蓝V前缀，不改动原有 GPT 接口。

本文件是联调契约，不代表服务已通过生产验收。收到我方开售确认后再开放真实购买。初期只采用轮询，不使用发往京东的 Webhook；支付宝向我方发送的收款异步通知仍然启用。

## 1. 凭据与调用边界

- 京东后端携带我方为蓝V独立签发的 `X-API-Key`；不能复用现有 GPT 接口 Key。初期先使用独立 Key 验证，京东服务器出口 IP 确认后再约定客户级 IP 白名单。
- API Key 只存放在京东服务器的密钥配置中，不放在网页、App、浏览器请求、URL、公开仓库或日志中。
- 该 Key 不是后台管理员令牌，也不是底层 X 商户的签名密钥。京东不需要底层商户密钥、卡信息或支付宝私钥。
- 接口不需要 Cookie、登录 Session、ChatGPT Session、X 密码、`auth_token`、`ct0` 或卡密。只收集接收会员的 X 用户名。
- 京东后端负责校验自己的登录用户及订单归属；不要允许客户提交任意我方 `order_id` 来查询其他客户订单。本版本一个独立实例对应一个接入方，不是多个商户共享的多租户接口。
- 全部请求使用 HTTPS。JSON 请求使用 `Content-Type: application/json`。金额均为人民币、两位小数字符串，不能传浮点数。

## 2. 商品

| 商品编码 `product` | 套餐 | 我方供货价 | 数量 |
| --- | --- | --- | --- |
| `x_premium_3m` | X Premium 3个月 | ¥22.00 | 仅 `1` |
| `x_premium_6m` | X Premium 6个月 | ¥44.00 | 仅 `1` |

零售价由京东确定，并通过 `sell_price` 提交。必须不低于 `cost_price`，不高于商品接口返回的 `max_sell_price`。供货价不是消费者必付价，也不是我方实际履约成本。订单创建时冻结供货价，后续调价不改变原订单。

`GET /products` 返回：

```json
{
  "success": true,
  "items": [
    {
      "product": "x_premium_3m",
      "name_zh": "X Premium 蓝V 3个月",
      "name": "X Premium 3 Months",
      "cost_price": "22.00",
      "max_sell_price": "9999.00",
      "currency": "CNY",
      "max_qty": 1,
      "in_stock": true,
      "fulfillment_type": "x_gift",
      "required_input": {
        "field": "recipient",
        "type": "x_username",
        "label_zh": "X 用户名",
        "placeholder": "@username",
        "timing": "before_payment"
      },
      "automatic_fulfillment": true
    }
  ]
}
```

示例只展示一项；应按编码筛选这两个 SKU，并以接口当时的报价和 `in_stock` 为准。`in_stock=false` 时禁用购买按钮；库存与接单能力会变化，下单仍可能返回不可售。

## 3. 创建付款订单

`POST /orders`：

```json
{
  "product": "x_premium_3m",
  "quantity": 1,
  "sell_price": "30.00",
  "client_order_id": "JD-X-20261005-000001",
  "recipient": "@example_user"
}
```

- `client_order_id`：京东生成并永久保存的唯一业务订单号，1–64字符。建议使用 `JD-X-` 前缀。同一购买意图只能使用一个编号。
- `recipient`：付款前必填，接受可选前导 `@`，用户名为1–15位字母、数字或下划线；会转为小写。填写用户名而不是昵称、个人主页链接、邮箱或数字ID。
- 付款前必须让客户确认接收账号、套餐和金额。付款后不能换收件人。
- 我方在生成付款二维码前验证账号资格，并冻结接收账号、数字ID、套餐及内部扣点快照。资格验证失败时不会返回付款二维码。
- 当前对外接口没有独立的“只检查资格”接口。平台可以将按钮显示为“检查账号并获取付款码”：用户先确认用户名、套餐和金额，平台后端再调用 `POST /orders`。该调用会检查资格并创建待付款订单，不会自动从客户账户扣款。不要先向客户收款再调用本接口。
- 如需不创建付款订单的独立资格检查按钮，应先协商新增接口，不要直接调用底层 `/v1/eligibility`，也不要向浏览器提供底层商户签名密钥。资格通过是当前时点的结果，不保证付款时或赠送执行时账号状态不变。
- 3个月的 `30.00` 是零售价示例，不是固定报价；6个月改用 `x_premium_6m` 且售价不得低于 `44.00`。

成功响应（编号、二维码、时间仅为结构示例）：

```json
{
  "success": true,
  "order_id": "UP20261005030000A1B2C3D4E5",
  "client_order_id": "JD-X-20261005-000001",
  "status": "pending",
  "amount": "30.00",
  "qr": "https://qr.alipay.com/EXAMPLE_ONLY",
  "qr_image_url": "https://api.quefa.cn/bluev/payment-qr/UP20261005030000A1B2C3D4E5.png?token=EXAMPLE_ONLY",
  "expires_at": "2026-10-05T03:20:00.000Z",
  "recipient": "@example_user",
  "idempotent": false
}
```

京东后端应保存 `client_order_id`、我方 `order_id`、商品、接收账号、零售价及原响应。展示返回的 `qr_image_url` 即可；也可在本地把 `qr` 原样编码为二维码。不要把图片地址再次编码成付款二维码，不要删除图片地址中的 `token`，不要把它发给无关客户或第三方分析服务。

二维码图片地址自带订单签名，不需要把 API Key 交给浏览器。浏览器只从京东后端获得该图片地址与必要展示字段。

## 4. 幂等与超时

我方以请求正文中的 `client_order_id` 做幂等，不使用另加的 `Idempotency-Key` 请求头。

- 完全相同的订单号、商品、数量、金额、规范化接收账号重试：返回原订单，`idempotent=true`。
- 同一编号修改商品、金额或账号：返回 `409 idempotency_conflict`，不会修改原单。
- 创建请求超时、断网、5xx 或响应丢失：保存原请求，退避后原样重发同一编号。不能生成新编号，不能提示用户再买一单。
- 已取得 `order_id` 后优先查询原单。当前没有按 `client_order_id` 查询的独立接口；未取得 `order_id` 时使用同正文的创建接口取回原单。
- 不对创建请求做并行重试。下单按钮应有本地提交锁；后端数据库也应对京东业务订单号加唯一约束。
- `expired` 仅代表当前付款窗口已结束，不能当作支付宝绝对未扣款的证据。客户声称已付款时保留原单，交我方查账，不创建替代订单。

## 5. 查询付款和赠送结果

付款订单：`GET /orders/{order_id}`。

```json
{
  "success": true,
  "order_id": "UP20261005030000A1B2C3D4E5",
  "client_order_id": "JD-X-20261005-000001",
  "status": "paid",
  "amount": "30.00",
  "expires_at": "2026-10-05T03:20:00.000Z",
  "paid_at": "2026-10-05T03:02:00.000Z",
  "recipient": "@example_user"
}
```

`delivery_status` 在尚未获得履约结果时可能省略；排队、处理中和待核对请以赠送任务接口为准。付款 `status` 与赠送状态是两条状态线，不要混用：

| 付款状态 | 京东页面含义 |
| --- | --- |
| `pending` | 等待我方确认付款，不代表已扣款或未扣款 |
| `paid` | 我方已核实到账，赠送结果需继续查 |
| `expired` / `closed` | 付款窗口结束或订单关闭；如已付款则联系客服核实原单 |
| `refunded` | 我方已确认退款；不再提示重新支付该单 |

赠送任务：`GET /orders/{order_id}/activation`。

```json
{
  "success": true,
  "order_id": "UP20261005030000A1B2C3D4E5",
  "activation_quota": 1,
  "activation_used": 1,
  "activation_remaining": 0,
  "items": [
    {
      "activation_id": "act_EXAMPLE_ONLY",
      "task_id": "tsk_EXAMPLE_ONLY",
      "status": "success",
      "finished": true,
      "message_zh": "开通成功",
      "recipient": "@example_user",
      "updated_at": "2026-10-05T03:04:00.000Z"
    }
  ]
}
```

| 任务情况 | 京东页面处理 |
| --- | --- |
| `items=[]` 且订单 `paid` | 已到账、正在安排赠送；继续查，不要求填写 Session |
| `submitting` / `queued` / `running`，`finished=false` | 核实中、排队中或赠送中 |
| `requires_review=true` | 原单结果待核对；显示客服入口，保持原单，降低轮询频率 |
| `success` 且 `finished=true` | 赠送成功，停止该任务轮询 |
| `failed` 且 `finished=true` | 该任务明确失败，交客服处理；不自动再次下单或退款 |

不要仅依据 HTTP 200、`success:true`、浏览器跳转、客户截图、`status=paid` 或 `message_zh` 文案判定赠送成功。只有任务的 `status=success && finished=true` 才是履约成功。蓝V审核与徽章显示由 X 决定，成功赠送 Premium 不保证立即出现蓝色徽章。

建议京东后端每5秒查询付款；付款后每5–10秒查询赠送任务。超时或5xx时指数退避到30秒；页面离开后保留后台补查。待核对订单交客服并可每30–60秒补查，不能因为等待较久就创建新任务。

本次上线包含我方后台定期查询原支付宝付款订单的补偿机制，用于恢复异步通知延迟或丢失的情况；只查询并核实原付款单，不新建支付、不再次扣款。京东仍只轮询上述订单接口，不需要自行接入支付宝查账。该机制需在我方上线验收中完成模拟丢通知测试。

蓝V到账后由我方自动创建唯一赠送任务。京东不要调用 `POST /activate`，也不要展示 Session、邮箱开通或卡密表单。历史兼容接口并不是蓝V流程的必需步骤。

## 6. 错误处理

错误响应格式：`{"success":false,"error":"错误码","detail_zh":"说明"}`。

| HTTP / 错误码 | 处理方式 |
| --- | --- |
| `401 invalid_api_key` | 检查京东后端凭据，停止自动重试并联系我方 |
| `403 ip_not_allowed` | 联系我方核实代理链路；启用客户级白名单后同时核实京东后端实际出口IP |
| `404 product_not_found` / `order_not_found` | 核实商品编码或已保存的我方订单号；不要换编号重建 |
| `409 product_unavailable` | 暂停购买，稍后刷新商品状态 |
| `503 sales_paused` | 我方暂停新增接单；保留已有订单继续查询，不换编号重试收款 |
| `409 idempotency_conflict` | 恢复并查询原业务订单，禁止修改原请求重试 |
| `422 recipient_required` / `invalid_recipient` / `recipient_not_eligible` | 付款前提示客户核对用户名或接收资格 |
| `422 price_below_floor` / `price_above_max` | 后端重新校验商品报价；不能在同一订单号上改价 |
| `422 invalid_quantity` / `invalid_argument` | 修正参数格式；数量仅能为1 |
| `503 recipient_check_unavailable`、5xx、连接超时 | 保留业务编号和原请求，退避后查询或同请求重试 |

`requires_review`、查询失败和超时均不是退款依据。初期退款由我方核对原付款和原赠送订单后处理；京东不要自动调用退款接口。接口存在退款申请能力也不等于立即退款成功。

## 7. curl 联调示例

以下为 Bash/zsh 语法；所有值都是示例。必须替换服务端 API Key、唯一订单号及真实授权的接收用户名。真实下单会生成收款单，客户付款后会自动履约，请勿用陌生账号测试。

```bash
export X_PARTNER_BASE_URL='https://api.quefa.cn/bluev'
export X_PARTNER_API_KEY='REPLACE_WITH_SERVER_API_KEY'

curl --silent --show-error --fail-with-body --connect-timeout 10 --max-time 60 \
  -H "X-API-Key: ${X_PARTNER_API_KEY}" \
  "${X_PARTNER_BASE_URL}/api/v1/checkout/products"

curl --silent --show-error --fail-with-body --connect-timeout 10 --max-time 60 \
  -H "X-API-Key: ${X_PARTNER_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{"product":"x_premium_3m","quantity":1,"sell_price":"30.00","client_order_id":"JD-X-REPLACE-WITH-UNIQUE-ID","recipient":"@example_user"}' \
  "${X_PARTNER_BASE_URL}/api/v1/checkout/orders"

export X_PARTNER_ORDER_ID='REPLACE_WITH_RETURNED_ORDER_ID'

curl --silent --show-error --fail-with-body --connect-timeout 10 --max-time 60 \
  -H "X-API-Key: ${X_PARTNER_API_KEY}" \
  "${X_PARTNER_BASE_URL}/api/v1/checkout/orders/${X_PARTNER_ORDER_ID}"

curl --silent --show-error --fail-with-body --connect-timeout 10 --max-time 60 \
  -H "X-API-Key: ${X_PARTNER_API_KEY}" \
  "${X_PARTNER_BASE_URL}/api/v1/checkout/orders/${X_PARTNER_ORDER_ID}/activation"
```

Node.js 服务端封装见 [examples/x-partner-client.mjs](examples/x-partner-client.mjs)。它不会自动创建新业务订单号、不会提交赠送、不会自动退款，也不包含真实密钥。

## 8. 对账边界

客户款由我方支付宝收取，我方承担赠送履约；京东按订单冻结供货价核算价差。正常无优惠、无补差的例子：客户支付¥30.00，3个月供货¥22.00，京东价差¥8.00。实际对账必须使用已确认实收和退款记录，而不是仅按报价相减。

只有已付款、赠送成功且未退款的订单进入普通人民币平台结算。生成结算记录不等于已经转账。内部虚拟卡成本、美元流水、X商户点数不等于对京东的人民币供货价，也不对京东公开。成本未核实不能将供货款视为全部毛利；蓝V不套用 ChatGPT/Zovo 的美元成本基准。

## 9. 我方部署与联合验收清单

- 独立数据库、独立端口、专用蓝V API Key和仅含两个蓝V SKU的商品目录；不复制旧京东交易库或运行时支付设置。京东出口IP未确认前不得声称已配置客户级白名单。
- 公开基址配置为 `https://api.quefa.cn/bluev`。入口代理把 `/bluev/...` 转至我方 X 服务器 `https://x.aifu.me/partner/...`，X服务器再剥离 `/partner`，应用实际收到 `/api/v1/checkout/...` 等内部路由。京东不直接依赖 X 服务器地址。
- 公开二维码为 `https://api.quefa.cn/bluev/payment-qr/{order_id}.png?token=...`，支付宝通知为 `https://api.quefa.cn/bluev/callbacks/alipay`。两者不能经过京东 API Key 鉴权；图片按自身签名校验，通知按支付宝验签及主动查单校验。
- 两层代理均不把 `/bluev/admin`、`/bluev/internal`、`/bluev/dev` 或对应后台鉴权接口暴露给合作方；既有 api.quefa.cn 和 x.aifu.me 的非蓝V路由保持不变。
- 代理节点白名单与京东客户级出口白名单是两回事。代理必须重建可信来源头，不能直接相信客户自带 `X-Forwarded-For`；确认入口节点的实际出口与后端限制一致。
- 发布前确认实际创建二维码使用的 `notify_url` 为 `https://api.quefa.cn/bluev/callbacks/alipay`，不能只检查环境变量名称。图片地址同样必须使用公开域名和 `/bluev` 前缀。
- 初期必须显式关闭向京东的 Webhook 工作进程，不能用空 URL 代替关闭，避免落到历史默认地址。
- 联合验证：无Key/错误Key被拒；若启用客户级IP白名单则验证错误IP被拒；两SKU报价22/44；无Session下单；原单重试不重复；两层代理均能正确传递图片签名；我方收款；收到通知且只创建一个赠送任务；重启后仍只查原单；成功和未知状态均正确展示。
- 独立校验“支付宝已付款但通知延迟/丢失”的恢复机制；API轮询不能被当成已经完成支付宝查账的证明。
- 京东上线前确认页面和后端都没有旧 ChatGPT Session 步骤，并提供业务订单号到我方订单号的一对一追踪。
