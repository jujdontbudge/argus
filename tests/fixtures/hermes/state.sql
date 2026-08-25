PRAGMA journal_mode = WAL;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT,
  model TEXT,
  parent_session_id TEXT,
  started_at REAL,
  ended_at REAL,
  end_reason TEXT,
  message_count INTEGER,
  title TEXT,
  cwd TEXT,
  archived INTEGER DEFAULT 0
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  role TEXT,
  content TEXT,
  timestamp REAL,
  active INTEGER DEFAULT 1
);

