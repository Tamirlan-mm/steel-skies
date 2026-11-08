-- Steel Skies diagnostics. One row per log entry; sessions carry the device.
CREATE TABLE IF NOT EXISTS sessions (
  session TEXT PRIMARY KEY,
  player TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  origin TEXT,
  ua TEXT,
  gpu TEXT,
  screen TEXT,
  cores INTEGER,
  mem_gb REAL,
  build TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT UNIQUE,            -- client-side id: re-sent batches are not duplicated
  received TEXT NOT NULL,
  t TEXT NOT NULL,            -- client time
  player TEXT NOT NULL,
  session TEXT NOT NULL,
  kind TEXT NOT NULL,         -- error | warn | hitch | perf | event | info
  msg TEXT,
  mode TEXT,
  vehicle TEXT,
  graphics TEXT,
  data TEXT                   -- JSON
);

CREATE INDEX IF NOT EXISTS entries_kind_t ON entries(kind, t);
CREATE INDEX IF NOT EXISTS entries_session ON entries(session);
CREATE INDEX IF NOT EXISTS entries_msg ON entries(kind, msg);
