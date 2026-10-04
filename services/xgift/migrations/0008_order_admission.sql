CREATE TABLE order_admission (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
  daily_limit INTEGER NOT NULL DEFAULT 1 CHECK(daily_limit BETWEEN 1 AND 10000),
  revision TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Upgrades leave new native orders paused until the administrator confirms the
-- daily limit. Existing orders and paid checkout reservations remain intact.
INSERT INTO order_admission(id,enabled,daily_limit,revision,updated_at)
VALUES(1,0,1,'admcfg_initial',CAST(strftime('%s','now') AS INTEGER)*1000);
CREATE INDEX orders_admission_day ON orders(created_at,status);
CREATE INDEX alipay_admission_day ON alipay_checkouts(created_at,status);
