# GPTibo X API

独立的 X Premium 赠送服务与 React + Kumo + Vite 8 管理后台，支持 Ubuntu / Node.js / SQLite，以及可选 Cloudflare Worker / D1。

## 快速开始

使用支持原生 TypeScript 的 Node.js 22.18+（生产当前使用 22.23.3）。

```sh
npm ci
npm run check
npm test
npm run test:gateway
npm run build
```

`npm ci` 同时安装服务器代理依赖。后端启动前按 [配置模板](services/xgift/server/service.env.example) 设置环境变量，再运行 `npm start`。前端热更新运行 `npm run xgift:frontend`。默认不启用真实支付；不能使用占位密钥启动生产服务。

## 部署与接口

完整部署、资金限制、签名协议和接口说明见 [服务文档](services/xgift/README.md)。可选 Worker 配置的数据库 ID 和域名路由需要自行填写。签名实现见 [shared/xgift-signature.ts](shared/xgift-signature.ts)。

保留 `services/xgift` 和 `shared` 布局以兼容现有 systemd 及发布目录。仓库只包含独立 X API；GPTibo 商城的支付回调、商品页面和适配器仍在商城仓库。服务文档提到的 `worker/xgift/client.ts` 等路径属于商城，不在本仓库。主站适配器集成测试同样保留在商城；这里包含独立服务、卡台、原生执行和服务器测试。

## 版本来源与安全

从 CoolkHz/ymx 提交 9c4de69 的已提交源码导出；独立服务运行代码对应 VPS 版本 b502739 / x-api-v0.4.0-vps。这是新仓库的初始快照，不改写或伪造原仓库历史，也未改变线上部署。

不包含生产 Cookie、代理密码、SSH 密钥、卡台密钥、主密钥、数据库、用户资料或运行日志。部署应继续使用服务器现有环境配置和数据库；不得重置加密主密钥或用空库覆盖生产账务。当前仍保留首单验收限制，扩大额度需单独调整并验证。
