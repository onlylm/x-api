# X 合作方网关：首次隔离发布

本目录只准备了脚本，未执行生产发布。适用已确认的 X 服务器 Nginx + systemd 布局；不是旧 AI京东服务的替换或升级脚本。先审查 PLAN.md 与本目录代码，再执行。

## 产物与默认状态

- 最终源码：x-api/services/partner-gateway。tar 根目录必须直接包含 dist/、config/、package.json、package-lock.json，不包含顶层 `.`、源码、数据库、环境、密钥或 node_modules。
- 构建前必须通过当前源码测试。dist 必须包含动态 PARTNER_SALES_GATE_FILE 检查与 QUEFA_WORKER_GATE_FILE 启动门闩；字符串检查不是业务测试替代。
- 商品仅 x_premium_3m / x_premium_6m，供货价22.00/44.00，初始停用；internal_cost_cny=0仅表示内部成本待录入，不代表真实成本为0。
- max_sell_price=9999.00为停用时兼容占位，不表示已经授权这个销售范围；开售前核实并设定允许售价。
- 两个门闩文件默认不存在；平台 webhook 默认关闭，保留签名secret与待发送事件，不向默认或不明确地址推送订单资料。
- canonical URL 为 https://api.quefa.cn/bluev；X端验证地址为 https://x.aifu.me/partner。仅部署X端不会自动创建前者的Quefa转发。

## 文件

- deploy-gateway.py：prepare / install / verify，以及安装失败时的保守回滚。
- configure-env.mjs：仅在服务器内读取正式支付宝和独立商户配置，生成新服务环境，不输出密钥。
- nginx-partner.conf：公开路径白名单，重建可信来源IP，兜底404。
- x-partner-gateway.service：仅新服务的独立用户、目录和写权限。
- products.json：初始两个停用商品。
- test_deploy_gateway.py：不接生产的离线防护测试。

## 本地验证

以下命令在 `x-api/services/partner-gateway` 目录执行，使用随源码提交的 `deploy/` 文件：

```text
python -m unittest discover -s deploy -p test_deploy_gateway.py -v
python -m py_compile deploy/deploy-gateway.py
node --check deploy/configure-env.mjs
```

归档在最终构建目录执行，显式列出四项，避免打包环境和Windows依赖：

```sh
tar -czf /approved-output/partner-gateway.tar.gz dist config package.json package-lock.json
sha256sum /approved-output/partner-gateway.tar.gz
```

通过现有安全SSH上传脚本五件套和核准产物，建议服务器目录 `/opt/x-partner-gateway-release` 权限700。上传脚本文件权限600；systemd模板和nginx模板安装时会调整为644。不要在命令行携带密码或私钥内容。README/PLAN/测试文件不参与服务器bundle校验，可不上传。

## 只读预检要求

服务器使用 Node24 `/opt/node/bin/node`；原 xgift 和 nginx 均active；127.0.0.1:3110空闲；原 /healthz正常。

`/etc/nginx/sites-available/xgift` 必须是普通文件，只有一个原8791反代和一个默认location；脚本不猜测多server复杂布局。若偏离则中止并重新审查。

原环境 `/etc/xgift/service.env` 与独立商户 `/etc/xgift/integrations/aijd-x-api.env` 必须root拥有、无组/其他读权限。旧数据库路径必须 `/srv/xgift/data/xgift.sqlite`，支付宝配置为正式环境且四项必需字段完整。只输出存在性/布尔检查，不输出字段值。

新程序、数据、配置目录、unit和Nginx include必须不存在。prepare不是升级命令；任何既有状态都拒绝覆盖。检查磁盘、锁定文件及系统用户冲突。

## 分阶段执行（必须由发布者审查后手动发起）

以下路径和SHA由发布者使用实际上传结果替换。release-id为6至64位小写字母数字/连字符。

```sh
python3 /opt/x-partner-gateway-release/deploy-gateway.py prepare \
  --artifact /opt/x-partner-gateway-release/partner-gateway.tar.gz \
  --sha256 <已核实的64位SHA256> \
  --release-id <本次唯一发布编号>
```

可选 `--platform-webhook-url <确认后的公网HTTPS地址>` 只预填地址，不开启通知；未知时不传。此阶段创建独立目录、用户和环境、安装Linux生产依赖，备份旧Nginx到 `/opt/backups/x-partner-gateway-<release-id>`。不启动新服务、不修改Nginx。初始化仅在同一服务器内只读读取旧支付宝加密配置，并在进程内使用旧 MASTER_KEY 解密；不导出旧数据库或 MASTER_KEY，也不将旧 MASTER_KEY 写入新服务。所需支付宝配置仅写入服务器内权限受限的新服务环境文件，不输出到日志或下载到本机。

检查输出为prepared，核对无秘密的发布状态后再执行：

```sh
python3 /opt/x-partner-gateway-release/deploy-gateway.py install
python3 /opt/x-partner-gateway-release/deploy-gateway.py verify
```

install重新核对代码、bundle、配置、旧进程与Nginx哈希，启动新服务并验证独立空库，再新增Nginx专用include，配置测试通过后只reload Nginx。全程不restart/reload原xgift。verify包括健康、401鉴权、非法二维码404、无效支付宝通知400、私有路径/目录穿越404以及旧服务身份和健康。

Quefa服务器新增独立 `/bluev` → X `/partner` 转发后，再执行：

```sh
python3 /opt/x-partner-gateway-release/deploy-gateway.py verify --canonical
```

Quefa映射必须单独备份、核对并发变更、Caddy validate/reload，保留所有既有GPT路由。应保留请求方法、查询字符串和正文，设置上游Host=x.aifu.me，不允许通过映射访问后台；X Nginx仍做最终路径白名单。不要直接拷贝未经线上Caddy结构验证的片段。

## 开售不在本脚本中

verify只针对首次停用/空库验收；以后有订单或商品开启将按设计拒绝该首次发布验证，不能误当故障并恢复旧库。

另行核实合作方服务器API Key接入、返回链接/二维码前缀、用户X用户名提交、回调验签或订单轮询、独立商户余额和22/44供货规则。密钥只通过授权服务器间配置传递，不在聊天或本机文件展示。

确认后独立启用商品和销售门闩。worker门闩只能启动worker；删除它不会暂停已经运行的worker。只关闭销售门闩应保持旧订单查询与支付宝回调可用。真实测试单需明确授权，不以健康检查名义创建付款、退款或赠送。

## 失败及恢复

- prepare部分失败：保留服务器备份与准备现场，不支持覆盖重跑；先排查state和非敏感错误码，确认无生产写入，再制定恢复。
- install失败且无订单/门闩：脚本停止并禁用新服务，在Nginx仍等于旧配置或本次候选的前提下恢复原配置并reload，保留独立库、密钥和代码。
- 发现新订单、开售门闩、Nginx并发修改：自动回滚中止，标记rollback_requires_review；禁止恢复整个数据库或删除在途回调路由。
- 任何原xgift PID、开始时间、current链接或健康变化均中止并报告，不能通过重启原服务来掩盖。

当前脚本没有独立开售命令、常规升级命令或人工回滚命令；不要直接修改状态文件绕过门闩。

## Quefa Caddy 独立映射脚本

`deploy-caddy-route.py` 只在 Quefa 154.198.43.105 上使用，不能在X服务器运行。它只在 api.quefa.cn 现有唯一 `route` 块最前增加 `/bluev/*` handle，位于原 legacy_admin、finance_admin 和兜底handle之前，避免被原route的兜底吞掉；显式固定剥离前缀、补 `/partner`、HTTPS反代的执行顺序，保留查询字符串及正文，不覆盖API Key。

2026-10-05 已由主代理只读核实：原Caddyfile SHA256 为 `0c5ea85dd203862946dc8036b76947430468104fe37f623a7a974c6a405acb2b`，单一 api.quefa.cn 站点含headers、唯一route及文件日志；单文件只读bind挂载已确认。执行时仍重新校验，不能把记录视为永久基线。

执行前必须由发布者读取并确认当前 Caddyfile SHA，确认配置为单文件 bind `/opt/merchant-gateway/Caddyfile` → Caddy容器 `/etc/caddy/Caddyfile`。容器名限定 merchant-gateway-caddy-1；已有 merchant-gateway 容器身份、compose哈希、文件哈希、运行中Caddy JSON哈希均锁定。若线上结构不同，先修改本地脚本、补测试后重新审查，不绕过校验。

该脚本专为单文件bind保留inode：持有文件锁、校验原SHA后原位写入并fsync，然后确认容器可见文件一致；不用rename导致容器继续看到旧文件。候选必须先在现有容器内 `caddy adapt --validate`，应用只用 `caddy reload`，绝不重启、重建交易容器。

```sh
python3 /approved-release/deploy-caddy-route.py prepare \
  --release-id <唯一编号> \
  --caddy-sha256 <已人工核实的当前CaddyfileSHA256>
python3 /approved-release/deploy-caddy-route.py apply
python3 /approved-release/deploy-caddy-route.py verify
```

prepare先要求X直接网关健康及私有路径否定测试通过，只创建服务器内配置备份，不reload。apply重新校验基线，应用后验证原 `/health`、新 `/bluev/health`、401鉴权和无效通知拒绝；失败只在文件/运行中配置都仍为原版或本次候选时恢复原Caddy配置。若有并发改动，拒绝回写。备份不含数据库，新旧数据库都不接触。

首次接入期间必须保持X侧商品/销售门闩关闭，才可允许失败时移除新转发。开售后不可再把此首次映射脚本当作日常回滚工具，需保证在途回调通道持续可达。

本地离线测试（在 `x-api/services/partner-gateway` 目录执行）：`python -m unittest discover -s deploy -p test_deploy_caddy_route.py -v`。最终还需用真实容器版本validate；离线测试不等于已完成线上验证。

设计依据：[Caddy rewrite 官方文档](https://caddyserver.com/docs/caddyfile/directives/rewrite)、[handle 官方文档](https://caddyserver.com/docs/caddyfile/directives/handle)、[reload / validate 官方命令](https://caddyserver.com/docs/command-line)。
