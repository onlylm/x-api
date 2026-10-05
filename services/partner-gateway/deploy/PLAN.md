# 隔离蓝V网关发布设计

2026-10-05已完成隔离待联调发布；实际执行结果及尚未开售边界见 [发布记录](RELEASE-20261005.md)。下文保留部署设计，不是实时状态。

目标：合作方继续使用 api.quefa.cn，在我们 X 服务器收款并履约；不改 AI京东旧交易程序、不重启原 xgift。

## 已确认拓扑

客户网站 → https://api.quefa.cn/bluev → Quefa Caddy 新增独立前缀映射 → https://x.aifu.me/partner → X Nginx 白名单反代 → 127.0.0.1:3110。

- X 服务器实际使用 Nginx，配置 /etc/nginx/sites-available/xgift；原默认上游 127.0.0.1:8791 保留。
- X 原服务 /opt/xgift/current、/srv/xgift、xgift.service 完全保留。
- 新服务 x-partner-gateway.service / xpartner；程序 /opt/x-partner-gateway，数据 /srv/x-partner-gateway，环境 /etc/x-partner-gateway。
- Node24 /opt/node/bin/node，独立 SQLite，无旧 GPT 商品或 GPT 上游凭据。
- canonical PUBLIC_BASE_URL=https://api.quefa.cn/bluev；支付宝新通知地址追加 /callbacks/alipay。
- X Nginx 只插入一个专用 include，只执行 nginx 配置检查和 reload。原 xgift 与 nginx 主进程 PID/开始时间前后必须不变。
- Quefa Caddy 映射由本目录独立的 `deploy-caddy-route.py` 执行；X端脚本不接触 Quefa 服务器。

## 默认关闭边界

两个商品供货价 22 / 44 元，enabled=false。销售门闩 sales.enabled 与 worker 门闩 workers.enabled 均不存在。平台 webhook 默认关闭；其密钥与其他新服务密钥独立生成。

只有 checkout API、二维码、支付宝回调和健康接口可经 X Nginx访问；admin/dev/internal/其他路径全部404。checkout 仍要求API Key及来源IP；允许来源为 loopback 和 Quefa 154.198.43.105。Nginx重建 X-Forwarded-For 为真实连接来源，避免外来伪造。

PARTNER_SALES_GATE_FILE 必须由应用对新订单动态检查，关闭后不影响原订单查单与支付宝回调。QUEFA_WORKER_GATE_FILE 只控制 worker 首次启动，删除文件不会暂停已启动 worker；停止履约需单独评估，不能把它当运行中暂停开关。

## 密钥来源与隔离

服务器内只读旧 X 的 alipay_settings，短暂在同机进程内用旧 MASTER_KEY 解密，只将正式支付宝应用ID、PID和支付密钥规范化后复制到新服务。私钥统一 PKCS8 PEM、公钥统一 SPKI PEM。MASTER_KEY 不写入新服务、不复制到备份、不下载。

独立商户来源 /etc/xgift/integrations/aijd-x-api.env。新 API Key、ADMIN_TOKEN、Session key、HMAC key、平台回调 secret 均独立随机生成；新环境 root:root 600，由 systemd 读取后以 xpartner 运行。

## 执行阶段

1. prepare：只检查旧服务与配置基线，保存服务器内 Nginx备份，核验产物SHA和安全归档，准备隔离目录/用户/依赖/环境，不启动新旧服务，不改Nginx。
2. install：再次核验不可变基线，仅启动新服务；确认独立空库和停用商品后加入专用Nginx include，nginx -t后reload，验证白名单、鉴权、原服务身份。
3. verify：只读校验发布状态与健康，配合无效通知做验签否定测试；商品和门闩仍关闭。Quefa前缀映射完成后运行 verify --canonical。
4. 开售：不在本脚本范围；先确认售价格式、合作方接入、平台通知或轮询方案、独立商户余额及原单查询，再单独授权启用商品与门闩。

## 回滚和失败

安装失败会在确认无订单、无开售门闩、Nginx无并发变更时自动停止/禁用新服务并恢复原Nginx配置。保留新数据库、环境和版本供核对，不回滚任何数据库、不改原xgift。

已有订单、门闩开启或配置并发变化时拒绝自动回滚，标记需人工核对；不能移除在途支付宝回调。prepare中途失败保留状态和文件，不支持盲目重复覆盖，先检查失败原因和保留现场。

## 交付

操作与本地验证参阅 README.md，执行记录参阅 RELEASE-20261005.md。发布不等于完成真实付款验收，未确认开售前不得对消费者开放购买。
