-- 本地已验证的增量方案。此文件不曾在生产执行。
-- 在发布窗口由人工批准后应用；应用启动也会幂等创建同一内部表。
-- 不改变订单号、金额、商品、供货价、现有表及对外结构。
CREATE TABLE IF NOT EXISTS checkout_intents (
  client_order_id TEXT PRIMARY KEY,
  order_json TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  updated_at TEXT NOT NULL
);
-- 不删除未完成的预留记录；它保存不确定付款请求的原始 out_trade_no。
