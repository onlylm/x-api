CREATE TABLE vouchers (
 id TEXT PRIMARY KEY,
 batch_id TEXT NOT NULL,
 batch_label TEXT NOT NULL DEFAULT '',
 user_id TEXT NOT NULL REFERENCES users(id),
 product_code TEXT NOT NULL REFERENCES products(code),
 code_hash TEXT NOT NULL UNIQUE CHECK(length(code_hash)=64),
 last_four TEXT NOT NULL CHECK(length(last_four)=4),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','revoked','redeemed')),
 order_id TEXT UNIQUE REFERENCES orders(id),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 redeemed_at INTEGER,
 revoked_at INTEGER,
 revocation_note TEXT,
 CHECK(
  (status='active' AND order_id IS NULL AND redeemed_at IS NULL AND revoked_at IS NULL AND revocation_note IS NULL) OR
  (status='redeemed' AND order_id IS NOT NULL AND redeemed_at IS NOT NULL AND revoked_at IS NULL AND revocation_note IS NULL) OR
  (status='revoked' AND order_id IS NULL AND redeemed_at IS NULL AND revoked_at IS NOT NULL AND revocation_note IS NOT NULL AND length(revocation_note)>0)
 )
);
CREATE INDEX voucher_created ON vouchers(created_at DESC,id);
CREATE INDEX voucher_owner ON vouchers(user_id,created_at DESC);
CREATE INDEX voucher_batch ON vouchers(batch_id);

ALTER TABLE orders ADD COLUMN mode TEXT NOT NULL DEFAULT 'direct' CHECK(mode IN('direct','voucher'));
ALTER TABLE orders ADD COLUMN voucher_id TEXT REFERENCES vouchers(id);
CREATE UNIQUE INDEX order_voucher ON orders(voucher_id) WHERE voucher_id IS NOT NULL;

CREATE TRIGGER order_mode_immutable BEFORE UPDATE OF mode,voucher_id ON orders
WHEN NEW.mode IS NOT OLD.mode OR NEW.voucher_id IS NOT OLD.voucher_id
BEGIN SELECT RAISE(ABORT,'immutable_order_mode'); END;

CREATE TRIGGER voucher_initial_state BEFORE INSERT ON vouchers
WHEN NEW.status<>'active' OR NEW.order_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'invalid_voucher_initial_state'); END;

CREATE TRIGGER voucher_immutable BEFORE UPDATE ON vouchers BEGIN
 SELECT RAISE(ABORT,'immutable_voucher') WHERE
  NEW.id IS NOT OLD.id OR NEW.batch_id IS NOT OLD.batch_id OR NEW.batch_label IS NOT OLD.batch_label OR
  NEW.user_id IS NOT OLD.user_id OR NEW.product_code IS NOT OLD.product_code OR
  NEW.code_hash IS NOT OLD.code_hash OR NEW.last_four IS NOT OLD.last_four OR
  NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at;
 SELECT RAISE(ABORT,'terminal_voucher') WHERE OLD.status<>'active' AND (
  NEW.status IS NOT OLD.status OR NEW.order_id IS NOT OLD.order_id OR NEW.redeemed_at IS NOT OLD.redeemed_at OR
  NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revocation_note IS NOT OLD.revocation_note
 );
 SELECT RAISE(ABORT,'invalid_voucher_binding') WHERE NEW.status='redeemed' AND NOT EXISTS(
  SELECT 1 FROM orders o WHERE o.id=NEW.order_id AND o.mode='voucher' AND o.voucher_id=NEW.id
   AND o.user_id=NEW.user_id AND o.product_code=NEW.product_code
 );
END;
CREATE TRIGGER voucher_immutable_delete BEFORE DELETE ON vouchers
BEGIN SELECT RAISE(ABORT,'immutable_voucher'); END;

-- The existing order_reserve trigger and this binding share one INSERT transaction.
-- Insufficient points roll back redemption too, regardless of trigger execution order.
CREATE TRIGGER order_bind_voucher AFTER INSERT ON orders BEGIN
 SELECT RAISE(ABORT,'invalid_order_mode') WHERE
  (NEW.mode='direct' AND NEW.voucher_id IS NOT NULL) OR (NEW.mode='voucher' AND NEW.voucher_id IS NULL);
 SELECT RAISE(ABORT,'voucher_unavailable') WHERE NEW.mode='voucher' AND NOT EXISTS(
  SELECT 1 FROM vouchers v WHERE v.id=NEW.voucher_id AND v.user_id=NEW.user_id AND v.product_code=NEW.product_code
   AND v.status='active' AND v.order_id IS NULL AND v.expires_at>NEW.created_at
   AND v.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)
 );
 UPDATE vouchers SET status='redeemed',order_id=NEW.id,redeemed_at=NEW.created_at
  WHERE id=NEW.voucher_id AND NEW.mode='voucher';
END;
