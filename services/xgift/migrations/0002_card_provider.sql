CREATE TABLE card_provider (
  id INTEGER PRIMARY KEY CHECK(id=1),
  environment TEXT NOT NULL CHECK(environment IN('sandbox','production')),
  payload TEXT NOT NULL,
  writes_enabled INTEGER NOT NULL DEFAULT 0 CHECK(writes_enabled IN(0,1)),
  revision TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE card_operations (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('open','recharge')),
  card_id INTEGER,
  product_code TEXT,
  amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
  environment TEXT NOT NULL,
  provider_revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('submitting','succeeded','failed','unknown')),
  failure_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX card_operation_mutex ON card_operations(environment,card_id)
  WHERE card_id IS NOT NULL AND status IN('submitting','unknown');
CREATE UNIQUE INDEX card_open_mutex ON card_operations(environment)
  WHERE kind='open' AND status IN('submitting','unknown');
