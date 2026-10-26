-- Same schema as the original better-sqlite3 app (src/lib/db.ts on dev/main).
CREATE TABLE IF NOT EXISTS boards (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  icon      TEXT NOT NULL DEFAULT '🎛️',
  accent    TEXT NOT NULL DEFAULT 'purple',
  position  INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pages (
  id        TEXT PRIMARY KEY,
  board_id  TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sounds (
  id        TEXT PRIMARY KEY,
  page_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  label     TEXT NOT NULL,
  accent    TEXT NOT NULL DEFAULT 'purple',
  key       TEXT NOT NULL,
  filename  TEXT NOT NULL DEFAULT '',
  mime      TEXT NOT NULL DEFAULT 'application/octet-stream',
  size      INTEGER NOT NULL DEFAULT 0,
  position  INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pages_board ON pages(board_id);
CREATE INDEX IF NOT EXISTS idx_sounds_page ON sounds(page_id);
