CREATE TABLE alipay_settings (
  id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
  revision TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE alipay_prices (
  product_code TEXT PRIMARY KEY REFERENCES products(code), amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)), updated_at INTEGER NOT NULL
);
CREATE TABLE alipay_checkouts (
  id TEXT PRIMARY KEY, access_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
  out_trade_no TEXT NOT NULL UNIQUE, trade_no TEXT UNIQUE,
  product_code TEXT NOT NULL REFERENCES products(code), product_name TEXT NOT NULL,
  months INTEGER NOT NULL, points INTEGER NOT NULL, currency TEXT NOT NULL, amount_minor INTEGER NOT NULL,
  stripe_product TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  recipient TEXT NOT NULL, recipient_id TEXT NOT NULL, provider_revision TEXT NOT NULL,
  outbound_revision TEXT NOT NULL, config_payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('creating','pending','paid','closed','failed','fulfilled','attention')),
  qr_deadline_enforced INTEGER NOT NULL DEFAULT 0 CHECK(qr_deadline_enforced IN(0,1)),
  paid_at INTEGER, qr_code TEXT, order_id TEXT UNIQUE REFERENCES orders(id), failure_code TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  next_check INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, work_token TEXT
);
-- The native executor is still in first-order acceptance mode. Reserve that slot before collecting money.
CREATE UNIQUE INDEX alipay_single_active_checkout ON alipay_checkouts((1))
  WHERE status IN('creating','pending');
CREATE TRIGGER immutable_alipay_purchase BEFORE UPDATE OF access_hash,request_hash,out_trade_no,product_code,
  product_name,months,points,currency,amount_minor,stripe_product,amount_cents,recipient,recipient_id,
  provider_revision,outbound_revision,config_payload,created_at,expires_at,qr_deadline_enforced ON alipay_checkouts
BEGIN SELECT RAISE(ABORT,'immutable_alipay_purchase'); END;
CREATE TRIGGER immutable_alipay_paid_trade BEFORE UPDATE OF trade_no,paid_at ON alipay_checkouts
WHEN OLD.paid_at IS NOT NULL AND (NEW.paid_at IS NOT OLD.paid_at OR NEW.trade_no IS NOT OLD.trade_no)
BEGIN SELECT RAISE(ABORT,'immutable_alipay_paid_trade'); END;
