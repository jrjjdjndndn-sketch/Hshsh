-- Links to keep alive
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL DEFAULT 5,
  method TEXT NOT NULL DEFAULT 'GET',
  timeout_ms INTEGER NOT NULL DEFAULT 15000,
  headers_json TEXT DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Check history log
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  response_time_ms INTEGER,
  error TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_checks_link_id ON checks(link_id);
CREATE INDEX IF NOT EXISTS idx_checks_checked_at ON checks(checked_at);
