# 平台订单只读页：独立发布

本说明和 platform-orders-deploy.py 仅供审查后执行。本代理没有连接或修改生产。既有 gateway/xgift/Caddy 发布脚本不改、不复用。

## 固定边界

- 新服务：x-platform-orders，xpartner 用户，127.0.0.1:3111，入口 dist/platform-orders-reader.js。
- 程序与静态目录：/opt/x-platform-orders/releases/<40位提交SHA>/，独立 current 链接。
- 新环境：/etc/x-platform-orders/service.env，只含 NODE_ENV、HOST、PORT、PLATFORM_ORDERS_DB_PATH、X_ADMIN_SESSION_URL、X_ADMIN_HOST；没有任何密钥。
- 只读数据库：/srv/x-partner-gateway/data/merchant-gateway.sqlite；运行沙箱将其目录设为只读，同时隐藏 /etc/xgift、/srv/xgift、/etc/x-partner-gateway。
- 不创建数据库、不迁移、不初始化商品、不启动付款/履约worker、不修改旧env/products/门闩，不触碰旧SQLite。
- 只允许新增3111服务启动/停止，Nginx配置检测成功后reload；旧xgift、gateway、Caddy均不重启。

脚本记录旧 xgift、x-partner-gateway、nginx PID/启动时间/版本链接，及旧unit、env、商品配置、partner snippet、销售/履约门闩指纹。旧状态变动或健康异常立即停止，不通过重启旧服务补救。不比较业务数据库文件哈希，因为旧服务仍正常处理真实订单，数据库自然会变化。

## 新接口和登录校验约定

后端必须通过已独立验证的代码实现：

- GET /health → `{ "ok": true, "service": "x-platform-orders", "read_only": true }`。
- GET /api/admin/platform-orders，匿名和伪造管理员头401、真实普通商户403，真实管理员可读。
- 每次仅用固定loopback地址 http://127.0.0.1:8791/api/session + Host:x.aifu.me，转发合法的 __Host-xgift Cookie。HTTP200不代表登录：必须检查 data.authenticated===true 和 data.role==='admin'。
- 不把Cookie或鉴权响应写日志，不允许鉴权跳转，不缓存成功授权。鉴权失败/超时按关闭处理。
- 新服务仅使用 Node 内置模块；用 DatabaseSync(readOnly:true)，不调用 AppDatabase/buildApp/migrate/seed/worker，不用 immutable 忽略WAL。
- 只读网关现有orders/activations；不要调用 X /v1签名接口，因为签名认证本身会写旧库nonce/限流。

发布脚本只做匿名否定与health检查，真实管理员/普通商户/退出即时失效由代码单测及授权会话验收补充，不自动登录生成旧库会话。

## 产物

先保存并提交本轮代码，取得40位commit。Vite以 `/platform-admin-ui/<commit>/` 为base构建，保证所有script/style引用为该版本前缀。

单tar必须具有以下根布局：

```text
package.json                 # type:module；reader没有外部依赖
dist/platform-orders-reader.js
dist/<reader使用的其他本地JS模块>
ui/index.html
ui/assets/<本轮构建产物>
ui/<可选图标/字体文件>
```

不得包含顶层 `.`、环境、私钥、数据库、node_modules、符号链接、源码或隐藏文件。打包时明确排除 Vite 复制的 `ui/_headers`（由 Nginx 专用 snippet 提供安全头，不读取此文件）。允许文件类型限制在可执行JS/包JSON与静态HTML/JS/CSS/SVG/PNG/ICO/WOFF2/WebP。部署过程不执行npm安装。

旧 `/assets` 保留由8791提供，已打开旧页面继续加载旧hash资源；新静态资源使用独立带commit路径。只替换精确 `/` 与 `/index.html` 入口，不修改 `/redeem`、`/api`、`/v1`、`/partner` 原路由。两个 HTML 入口使用 `root <release>/ui; try_files /index.html =404;`，不能对根路径使用单文件 alias：独立 Nginx 实测会尝试读取 `index.htmlindex.html` 并返回 500。版本化资源仍使用目录 alias。HTML使用原CSP、X-Frame-Options、nosniff、Referrer-Policy和HSTS，Cache-Control:no-store；版本化资源immutable。

## 必须输入的五个参数

首次prepare前，只读核实两个当前SHA，不输出配置中的秘密：

1. artifact：上传后tar绝对路径。
2. sha256：审核通过的tar SHA256。
3. release-id：对应代码40位commit，必须与UI base一致。
4. nginx-sha256：/etc/nginx/sites-available/xgift当前原始字节SHA，保留CRLF。
5. partner-snippet-sha256：/etc/nginx/snippets/x-partner-gateway.conf当前SHA。

```sh
python3 /approved-release/platform-orders-deploy.py prepare \
  --artifact /approved-release/platform-orders.tar.gz \
  --sha256 <tar的SHA256> \
  --release-id <40位commit> \
  --nginx-sha256 <已核实原站点SHA256> \
  --partner-snippet-sha256 <已核实partner-snippet SHA256>
python3 /approved-release/platform-orders-deploy.py install
python3 /approved-release/platform-orders-deploy.py verify
```

prepare仅检查、备份配置、解包隔离产物和生成无秘密的新环境，不启动、不reload。install再次核验基线，仅启动新服务；健康及匿名拒绝通过后才写入专用snippet和一个include，nginx -t成功再reload。verify核对旧服务状态、HTML/资源hash、安全头、GET401、POST405、原会话接口及健康；没有真实付款/赠送调用。

Nginx 平滑 reload 返回不代表新 worker 已立即接管。新路由验收最多尝试 8 次、总就绪窗口 20 秒，每次 HTTP 请求最多 2 秒，HTML 明确发送 `Accept: text/html` 和 `Cache-Control: no-cache`。每轮重新验证代码、环境、Nginx 文件指纹及原服务身份；配置或安全校验异常不重试。超时仍不一致则按原流程回滚，不扩大静态路由或旧代理路由。

## 回滚

```sh
python3 /approved-release/platform-orders-deploy.py rollback
```

只在原文件与本次候选之间、旧实例与配置全部仍相同的情况下恢复原Nginx文件（移除本次include），检测成功后reload，再停止/禁用新3111服务。保留新增代码、静态产物、环境和备份；不恢复任何数据库。发现并发修改则拒绝覆盖，保留现场报告。旧 /partner snippet原样保留。

## 成功回滚后的安全重试

仅 `deploy-state.json` 的状态为 `rolled_back` 时允许恢复；`prepared`、`installing`、`installed`、`rollback_required` 都拒绝。不能重新 prepare、删除目录、重新解包或覆盖环境。

```sh
python3 /approved-release/platform-orders-deploy.py resume \
  --previous-script-sha256 <上一次已审部署脚本SHA256> \
  --previous-snippet-sha256 <本次已回滚且尚未include的旧snippet的SHA256>
```

两个参数必须为 64 位 SHA256，并且分别严格等于旧 state 记录的 `script_sha256`、`snippet_sha256`。脚本先核对 release 全文件清单、环境、全部备份、current 链接、已保留 unit/snippet、原始站点和旧服务基线；确认新 reader 实际加载的 unit 路径正确、没有 drop-in 覆盖，且为 inactive/dead、MainPID=0、disabled、无需 daemon-reload。检查新端口空闲及原健康，再次核对现场未变化，才允许修复并更新 state 的脚本指纹，保留前次指纹和停止身份。

唯一允许的 snippet 迁移是：内容必须逐字等于本脚本生成的旧版本，仅将两个精确 HTML 入口的单文件 alias 替换为 root + try_files；assets/API 和安全头逐字不变。保留原 `new-snippet.conf`，将新版写入 `new-snippet-<新版SHA256>.conf`，同名文件存在但内容不符即拒绝，原 `nginx.original` 和 `nginx.candidate` 永不覆盖。站点仍处于原始配置、旧基线和新 reader 停止身份再次核验后，先记录 `snippet_migrating` 中间状态，再原子替换尚未被 include 的 snippet。成功后更新新版备份指针和 hash，再按通常恢复流程启动。中途写入失败或进程中断会保留明确现场，拒绝自动 resume；必须先人工核对，不得改 status 强行绕过。

恢复不覆盖 unit/current/环境，不改 release/产物，不运行 daemon-reload；只启动已核实的新 reader、恢复本次候选 Nginx include，配置检测成功后 reload 并有限等待。仍然失败则回滚原站点、停止新服务；不恢复数据库，也不重启旧服务。任一保留文件缺失或出现已知两处修复之外的修改都拒绝自动补齐。若恢复在写入新脚本指纹后、启动前中断且仍为 rolled_back，需先核对现场，再以 state 当前记录且重新审核过的两个指纹调用 resume。

首次 prepare 中断不支持覆盖重跑，先核对现场；本脚本不是通用升级工具。开页用户回滚后可刷新恢复旧 UI；旧 hash assets 始终不动。新 API 返回的履约状态是网关已保存快照，显示更新时间，不承诺实时向 X 查单。

## 本地验收

`python -m unittest discover -s services/partner-gateway/deploy -p test_platform_orders_deploy.py -v`

`python -m py_compile services/partner-gateway/deploy/platform-orders-deploy.py`

离线测试不能替代实际Nginx版本的 `nginx -t` 或新只读服务的角色授权单测。上线前仍需主代理核实当前入口、产物及旧服务基线。
