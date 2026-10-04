PRAGMA foreign_keys=ON;
CREATE TABLE users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL, salt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)), created_at INTEGER NOT NULL
);
CREATE TABLE wallets (
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 available INTEGER NOT NULL DEFAULT 0 CHECK(typeof(available)='integer' AND available>=0 AND available<=1000000000000),
 frozen INTEGER NOT NULL DEFAULT 0 CHECK(typeof(frozen)='integer' AND frozen>=0 AND frozen<=1000000000000)
);
CREATE TRIGGER user_wallet AFTER INSERT ON users BEGIN INSERT INTO wallets(user_id) VALUES(NEW.id); END;
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), role TEXT NOT NULL CHECK(role IN('admin','user')), version TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE login_limits (id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE TABLE api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), label TEXT NOT NULL, secret TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN(0,1)), created_at INTEGER NOT NULL);
CREATE TABLE nonces (key_id TEXT NOT NULL REFERENCES api_keys(id), nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(key_id,nonce));
CREATE TABLE products (
 code TEXT PRIMARY KEY, name TEXT NOT NULL, months INTEGER NOT NULL CHECK(months IN(3,6)),
 stripe_product TEXT NOT NULL, currency TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
 points INTEGER NOT NULL CHECK(typeof(points)='integer' AND points>0 AND points<=1000000000), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1))
);
INSERT INTO products VALUES ('x-premium-3m','X Premium · 3 个月',3,'prod_TJXJtpzqCpI36N','bdt',30000,300,0), ('x-premium-6m','X Premium · 6 个月',6,'prod_TJXKKNJwZJIhCM','bdt',60000,600,0);
CREATE TABLE user_prices (user_id TEXT NOT NULL REFERENCES users(id), product_code TEXT NOT NULL REFERENCES products(code), points INTEGER NOT NULL CHECK(typeof(points)='integer' AND points>0 AND points<=1000000000), PRIMARY KEY(user_id,product_code));
CREATE TABLE secrets (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('proxy','account')), name TEXT NOT NULL, payload TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)), updated_at INTEGER NOT NULL);
CREATE TABLE orders (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), merchant_order_no TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL, product_code TEXT NOT NULL REFERENCES products(code), recipient TEXT NOT NULL,
 points INTEGER NOT NULL CHECK(typeof(points)='integer' AND points>0 AND points<=1000000000),
 currency TEXT NOT NULL, amount_minor INTEGER NOT NULL, stripe_product TEXT NOT NULL, months INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','unknown','succeeded','failed')),
 executor_ref TEXT, execution_config TEXT, failure_code TEXT, receipt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 lease_until INTEGER NOT NULL DEFAULT 0, next_check INTEGER NOT NULL DEFAULT 0, work_token TEXT,
 UNIQUE(user_id,merchant_order_no), UNIQUE(user_id,idempotency_key)
);
CREATE INDEX order_pending ON orders(status,next_check,lease_until);
CREATE INDEX order_user ON orders(user_id,created_at);
CREATE UNIQUE INDEX recipient_active ON orders(recipient) WHERE status IN('queued','running','unknown');
CREATE TABLE account_slots (order_id TEXT PRIMARY KEY REFERENCES orders(id), account_id TEXT NOT NULL REFERENCES secrets(id), day TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0 CHECK(released IN(0,1)));
CREATE UNIQUE INDEX account_busy ON account_slots(account_id) WHERE released=0;
CREATE TABLE webhook_configs (user_id TEXT PRIMARY KEY REFERENCES users(id), url TEXT NOT NULL, secret TEXT NOT NULL);
CREATE TABLE webhook_deliveries (order_id TEXT PRIMARY KEY REFERENCES orders(id), user_id TEXT NOT NULL REFERENCES users(id), event_id TEXT NOT NULL UNIQUE, url TEXT NOT NULL, secret TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sent','dead')));
CREATE TABLE ledger (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), order_id TEXT REFERENCES orders(id),
 kind TEXT NOT NULL CHECK(kind IN('credit','reserve','consume','release')),
 available_delta INTEGER NOT NULL, frozen_delta INTEGER NOT NULL, note TEXT NOT NULL, actor TEXT NOT NULL,
 reference TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id,kind,reference), UNIQUE(order_id,kind)
);
CREATE TRIGGER ledger_validate BEFORE INSERT ON ledger BEGIN
 SELECT RAISE(ABORT,'invalid_ledger') WHERE NOT (
  (NEW.kind='credit' AND NEW.order_id IS NULL AND NEW.available_delta>0 AND NEW.frozen_delta=0) OR
  (NEW.kind='reserve' AND NEW.available_delta<0 AND NEW.frozen_delta=-NEW.available_delta AND EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND user_id=NEW.user_id AND status='queued' AND points=NEW.frozen_delta)) OR
  (NEW.kind='consume' AND NEW.available_delta=0 AND NEW.frozen_delta<0 AND EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND user_id=NEW.user_id AND status='succeeded' AND points=-NEW.frozen_delta)) OR
  (NEW.kind='release' AND NEW.available_delta>0 AND NEW.frozen_delta=-NEW.available_delta AND EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND user_id=NEW.user_id AND status='failed' AND points=NEW.available_delta))
 );
 SELECT RAISE(ABORT,'insufficient_points') WHERE NOT EXISTS(SELECT 1 FROM wallets WHERE user_id=NEW.user_id AND available+NEW.available_delta>=0 AND frozen+NEW.frozen_delta>=0);
END;
CREATE TRIGGER ledger_apply AFTER INSERT ON ledger BEGIN
 UPDATE wallets SET available=available+NEW.available_delta,frozen=frozen+NEW.frozen_delta WHERE user_id=NEW.user_id;
END;
CREATE TRIGGER ledger_immutable_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'immutable_ledger'); END;
CREATE TRIGGER ledger_immutable_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'immutable_ledger'); END;
CREATE TRIGGER order_reserve AFTER INSERT ON orders BEGIN
 SELECT RAISE(ABORT,'invalid_initial_state') WHERE NEW.status<>'queued';
 INSERT INTO ledger VALUES(NEW.id||':reserve',NEW.user_id,NEW.id,'reserve',-NEW.points,NEW.points,'订单冻结点数','system',NEW.id,NEW.created_at);
END;
CREATE TRIGGER order_immutable BEFORE UPDATE ON orders BEGIN
 SELECT RAISE(ABORT,'immutable_order') WHERE NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.merchant_order_no<>OLD.merchant_order_no OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.request_hash<>OLD.request_hash OR NEW.product_code<>OLD.product_code OR NEW.recipient<>OLD.recipient OR NEW.points<>OLD.points OR NEW.currency<>OLD.currency OR NEW.amount_minor<>OLD.amount_minor OR NEW.stripe_product<>OLD.stripe_product OR NEW.months<>OLD.months OR NEW.created_at<>OLD.created_at;
 SELECT RAISE(ABORT,'terminal_order') WHERE OLD.status IN('succeeded','failed') AND NEW.status<>OLD.status;
 SELECT RAISE(ABORT,'invalid_transition') WHERE OLD.status<>NEW.status AND NOT (
  (OLD.status='queued' AND NEW.status IN('running','failed')) OR
  (OLD.status='running' AND NEW.status IN('unknown','succeeded','failed')) OR
  (OLD.status='unknown' AND NEW.status IN('running','succeeded','failed'))
 );
END;
CREATE TRIGGER order_settle AFTER UPDATE OF status ON orders WHEN OLD.status<>NEW.status AND NEW.status IN('succeeded','failed') BEGIN
 INSERT INTO ledger VALUES(NEW.id||':settle',NEW.user_id,NEW.id,CASE NEW.status WHEN 'succeeded' THEN 'consume' ELSE 'release' END,CASE NEW.status WHEN 'failed' THEN NEW.points ELSE 0 END,-NEW.points,CASE NEW.status WHEN 'succeeded' THEN '充值完成' ELSE '充值失败退回点数' END,'system',NEW.id,NEW.updated_at);
 UPDATE account_slots SET released=1 WHERE order_id=NEW.id;
 INSERT INTO webhook_deliveries(order_id,user_id,event_id,url,secret,next_at) SELECT NEW.id,NEW.user_id,NEW.id||':completed',url,secret,NEW.updated_at FROM webhook_configs WHERE user_id=NEW.user_id;
END;
CREATE TABLE audit (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL);
