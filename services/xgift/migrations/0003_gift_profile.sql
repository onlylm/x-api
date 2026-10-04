CREATE TABLE gift_profile (
  id INTEGER PRIMARY KEY CHECK(id=1),
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
