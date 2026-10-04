CREATE TABLE payment_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
  revision TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
