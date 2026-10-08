# X 管理后台首页同步

生产 `x.aifu.me` 的精确 `/` 与 `/index.html` 路由由
`/etc/nginx/snippets/x-platform-orders.conf` 提供独立静态 HTML。
仅更新 `/opt/xgift/current` 并不能更新管理后台首页。

X 服务代码、前端构建和数据库迁移按原发布流程完成后，还必须核对公开域名的 HTML
与脚本指纹。若首页仍指向旧平台 UI，使用 `sync-admin-ui.py` 将两个 HTML root
同步到**已经运行且核实过**的 X release 的 `services/xgift/dist`。
该构建须使用默认 `/assets/` 路径；资产仍由原 X 服务路由提供。

```sh
sha256sum /etc/nginx/snippets/x-platform-orders.conf
python3 /reviewed-path/sync-admin-ui.py \
  --release <当前X服务40位提交SHA> \
  --snippet-sha256 <刚核实的snippet SHA256>
```

脚本只替换两个精确 HTML root，保留平台只读 API、旧版本不可变静态资源、安全头
及其他路由；不重启应用，不迁移或写数据库，不更改收付款开关、主卡或配置。
先校验当前版本、构建资源与服务身份，备份原 snippet，再 `nginx -t` 和平滑 reload。
公开 HTML、JS、CSS 的字节需与构建一致，平台 API 仍需拒绝匿名与 POST；
任何失败在配置没有并发修改时恢复本次原 snippet，不回滚业务数据库。

脚本输出备份路径，原内容可恢复。不要直接重新运行平台只读服务的首次安装脚本，
不要覆盖原静态版本目录，不要把失败的公开验收解释为用户缓存。

本地回归：`python -m unittest discover -s services/xgift/deploy -p test_sync_admin_ui.py -v`。
静态发布验收不能替代登录后的手动功能测试，不会自动创建赠送单或扣款。
