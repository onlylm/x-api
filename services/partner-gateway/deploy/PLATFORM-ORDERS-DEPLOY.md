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

不得包含顶层 `.`、环境、私钥、数据库、node_modules、符号链接、源码或隐藏文件。允许文件类型限制在可执行JS/包JSON与静态HTML/JS/CSS/SVG/PNG/ICO/WOFF2/WebP。部署过程不执行npm安装。

旧 `/assets` 保留由8791提供，已打开旧页面继续加载旧hash资源；新静态资源使用独立带commit路径。只替换精确 `/` 与 `/index.html` 入口，不修改 `/redeem`、`/api`、`/v1`、`/partner` 原路由。HTML使用原CSP、X-Frame-Options、nosniff、Referrer-Policy和HSTS，Cache-Control:no-store；版本化资源immutable。

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

## 回滚

```sh
python3 /approved-release/platform-orders-deploy.py rollback
```

只在原文件与本次候选之间、旧实例与配置全部仍相同的情况下恢复原Nginx文件（移除本次include），检测成功后reload，再停止/禁用新3111服务。保留新增代码、静态产物、环境和备份；不恢复任何数据库。发现并发修改则拒绝覆盖，保留现场报告。旧 /partner snippet原样保留。

首次prepare中断不支持覆盖重跑，先核对现场；本脚本不是通用升级工具。开页用户回滚后可刷新恢复旧UI；旧hash assets始终不动。新API返回的履约状态是网关已保存快照，显示更新时间，不承诺实时向X查单。

## 本地验收

`python -m unittest discover -s services/partner-gateway/deploy -p test_platform_orders_deploy.py -v`

`python -m py_compile services/partner-gateway/deploy/platform-orders-deploy.py`

离线测试不能替代实际Nginx版本的 `nginx -t` 或新只读服务的角色授权单测。上线前仍需主代理核实当前入口、产物及旧服务基线。
