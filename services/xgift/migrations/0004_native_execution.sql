ALTER TABLE orders ADD COLUMN recipient_id TEXT;
CREATE TRIGGER immutable_recipient_id BEFORE UPDATE OF recipient_id ON orders
WHEN NEW.recipient_id IS NOT OLD.recipient_id BEGIN SELECT RAISE(ABORT,'immutable_recipient_id'); END;
CREATE TABLE native_jobs (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  stage TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE native_funding (
  reference TEXT PRIMARY KEY, day TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0)
);
CREATE TRIGGER native_funding_cap BEFORE INSERT ON native_funding
WHEN NEW.amount_cents+(SELECT COALESCE(SUM(amount_cents),0) FROM native_funding WHERE day=NEW.day AND reference<>NEW.reference)>2000
BEGIN SELECT RAISE(ABORT,'daily_funding_cap'); END;
