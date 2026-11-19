-- Invite-only accounts (identical shape in music-kiosk). Times are epoch milliseconds.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,          -- lowercased + trimmed
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',      -- hex PBKDF2-SHA256; '' = no password yet
  salt          TEXT NOT NULL DEFAULT '',      -- hex, 16 bytes
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,                 -- hex HMAC-SHA256(raw cookie token, SESSION_SECRET)
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS auth_tokens (
  id         TEXT PRIMARY KEY,                 -- hex HMAC-SHA256(raw link token, SESSION_SECRET)
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('invite','reset')),
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
-- Sliding-window rate limit hits (login / forgot, per IP and per email).
CREATE TABLE IF NOT EXISTS rate_hits (
  key TEXT NOT NULL,
  at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_hits_key_at ON rate_hits(key, at);
