# AI京东 X Premium 接入（历史设计记录）

本文保留早期商品字段和履约设计背景，不作为当前合作方接入或部署完成的凭证。正式接入以 [x-partner-api.md](x-partner-api.md) 为准：公开基址为 `https://api.quefa.cn/bluev/api/v1/checkout`，使用独立蓝V API Key（不能复用 GPT Key），初期仅轮询，平台 Webhook 关闭。下文 `/api/v1/checkout/...` 为应用内部路径，外部请求必须使用上述公开基址。

## 商品与上线状态

| 商品编码 | 内容 | 平台供货价 | 履约商品编码 |
| --- | --- | --- | --- |
| x_premium_3m | X Premium 3个月 | 22.00 CNY | x-premium-3m |
| x_premium_6m | X Premium 6个月 | 44.00 CNY | x-premium-6m |

两商品默认未开售。0.00 的默认成本代表成本尚未核实，不代表免费履约。售价不得低于供货价；9999元上限只是停用时的兼容占位，不代表已授权销售范围，开售前需核实允许售价。

早期方案面对旧交易容器与财务容器版本不同的问题，因此不能直接整包替换。当前采用独立蓝V网关，不替换原 GPT 服务。源码和测试不等于生产部署或端到端验收，完成真实配置、部署验证及开售确认前不能开启销售。

## 京东网站需接入的字段

商品目录 `GET /api/v1/checkout/products` 新增：

```json
{
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
```

蓝V商品购买页面收集用户名，不收集 X 密码、Cookie、ChatGPT Session 或客户卡密。付款前显示账号和套餐让用户确认。下单由京东后端使用独立蓝V API Key，不能复用旧 GPT Key，密钥不得放到浏览器。客户级 IP 白名单待京东出口 IP 确认后约定，代理节点白名单不等于客户级白名单。

`POST /api/v1/checkout/orders` 示例（售价仅为示例）：

```json
{
  "product": "x_premium_3m",
  "quantity": 1,
  "sell_price": "30.00",
  "client_order_id": "JD-X-20261005-0001",
  "recipient": "@example_user"
}
```

服务端在生成付款前校验接单能力、余额、套餐及接收资格，将规范化用户名、数字账号ID、套餐及扣点快照冻结保存。展示返回的 `qr_image_url`；其带订单签名，不要删除查询参数。网络超时必须用同一个 `client_order_id` 重查/重试，不能换订单号继续收款。

## 收款与履约

1. 客户在京东网站购买，资金通过本平台支付宝收取。
2. 支付结果验签及原单核对完成后，自动创建唯一赠送任务。
3. 任务使用独立 X 商户提交一次赠送，之后只查询原订单。
4. 初期京东轮询付款与赠送任务接口：付款 `status=paid` 只表示到账；任务 `status=success` 且 `finished=true` 才表示履约成功。`order.paid` / `order.activated` 是历史 Webhook 事件名，当前平台通知关闭，不应等待通知；支付宝向我方发送的收款通知不受此开关影响。

结果查询沿用 `GET /api/v1/checkout/orders/:orderId/activation`。蓝V成功结果提供 `recipient`，不提供 `account_email`。正常排队显示 `queued/running`；未知结果保持未完成并显示 `requires_review`，不能提示重新购买、换账号重试或自动退款。一个蓝V付款订单即使失败也只绑定一个任务。

旧 `activate` 接口仅兼容查询同一账号已有任务，不是蓝V客户页面必经步骤；不得为此要求用户填写 Session。

## 运维约束

- 正式环境禁止 X 模拟模式，X API 地址必须 HTTPS，密钥仅保存在服务器。
- 使用独立蓝V商户；用户已授权初始3000点（3个月300点、6个月600点，以实际商品校验为准），供货人民币定价与扣点是不同概念。
- POST 前持久化提交标志和请求快照；响应丢失、404、401及进程重启都不能再次提交扣款。
- 结果与冻结账号、套餐、点数或订单号不符时保持核对；不能人工填写邮箱直接改成功。
- 赠送成功不等于保证蓝色认证徽章即时显示，徽章资格和审核由 X 决定。
- 京东网站前端需实现上述用户名输入和自动履约状态；本源码仓库不包含其网站页面，不能把接口测试称为网站端到端验收。
