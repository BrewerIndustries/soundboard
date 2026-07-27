import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { accentOf, type AccentKey, type Board, type Page, type Sound } from "./types";
import { seed } from "./seed";

const DB_PATH =
  process.env.SOUNDBOARD_DB_PATH ?? join(process.cwd(), "data", "soundboard.db");

// Next.js reloads modules on every change in dev; cache the connection so we
// don't open a new handle (and re-run migrations) on each request.
const globalForDb = globalThis as unknown as { _soundboardDb?: Database.Database };

function init(): Database.Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
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
  `);

  // Seed a starter "Hannah" board on a brand-new database so a fresh deploy looks
  // alive. Editable/deletable like anything else. (No audio bytes are seeded.)
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM boards`).get() as { n: number };
  if (n === 0) seed(db);

  return db;
}

export function getDb(): Database.Database {
  if (!globalForDb._soundboardDb) globalForDb._soundboardDb = init();
  return globalForDb._soundboardDb;
}

// --- helpers -----------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function trimmed(v: unknown): string {
  return str(v).trim();
}
function nextPosition(table: "boards" | "pages" | "sounds", scope?: { col: string; id: string }): number {
  const where = scope ? `WHERE ${scope.col} = @id` : "";
  const row = getDb()
    .prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM ${table} ${where}`)
    .get(scope ? { id: scope.id } : {}) as { pos: number };
  return row.pos;
}

// --- row shapes --------------------------------------------------------------

interface BoardRow {
  id: string; name: string; icon: string; accent: string;
  position: number; createdAt: string; updatedAt: string;
}
interface PageRow {
  id: string; board_id: string; name: string; position: number; createdAt: string;
}
interface SoundRow {
  id: string; page_id: string; label: string; accent: string; key: string;
  filename: string; mime: string; size: number; position: number; createdAt: string;
}

function toSound(r: SoundRow): Sound {
  return {
    id: r.id, pageId: r.page_id, label: r.label, accent: accentOf(r.accent),
    key: r.key, filename: r.filename, mime: r.mime, size: r.size,
    position: r.position, createdAt: r.createdAt,
  };
}

// --- read (full tree) --------------------------------------------------------

export function listBoards(): Board[] {
  const db = getDb();
  const boards = db.prepare(`SELECT * FROM boards ORDER BY position, createdAt`).all() as BoardRow[];
  const pages = db.prepare(`SELECT * FROM pages ORDER BY position, createdAt`).all() as PageRow[];
  const sounds = db.prepare(`SELECT * FROM sounds ORDER BY position, createdAt`).all() as SoundRow[];

  const soundsByPage = new Map<string, Sound[]>();
  for (const s of sounds) {
    const list = soundsByPage.get(s.page_id) ?? [];
    list.push(toSound(s));
    soundsByPage.set(s.page_id, list);
  }
  const pagesByBoard = new Map<string, Page[]>();
  for (const p of pages) {
    const page: Page = {
      id: p.id, boardId: p.board_id, name: p.name, position: p.position,
      createdAt: p.createdAt, sounds: soundsByPage.get(p.id) ?? [],
    };
    const list = pagesByBoard.get(p.board_id) ?? [];
    list.push(page);
    pagesByBoard.set(p.board_id, list);
  }
  return boards.map((b) => ({
    id: b.id, name: b.name, icon: b.icon, accent: accentOf(b.accent),
    position: b.position, createdAt: b.createdAt, updatedAt: b.updatedAt,
    pages: pagesByBoard.get(b.id) ?? [],
  }));
}

// --- boards ------------------------------------------------------------------

export interface BoardInput { name?: unknown; icon?: unknown; accent?: unknown; position?: unknown }

export function createBoard(input: BoardInput): Board | null {
  const name = trimmed(input.name);
  if (!name) return null;
  const now = new Date().toISOString();
  const row: BoardRow = {
    id: randomUUID(), name,
    icon: trimmed(input.icon) || "🎛️",
    accent: accentOf(input.accent),
    position: nextPosition("boards"),
    createdAt: now, updatedAt: now,
  };
  getDb()
    .prepare(`INSERT INTO boards (id,name,icon,accent,position,createdAt,updatedAt)
              VALUES (@id,@name,@icon,@accent,@position,@createdAt,@updatedAt)`)
    .run(row);
  return { ...row, accent: accentOf(row.accent) as AccentKey, pages: [] };
}

export function updateBoard(id: string, patch: BoardInput): boolean {
  const existing = getDb().prepare(`SELECT * FROM boards WHERE id = ?`).get(id) as BoardRow | undefined;
  if (!existing) return false;
  const next = {
    id,
    name: patch.name !== undefined ? trimmed(patch.name) || existing.name : existing.name,
    icon: patch.icon !== undefined ? trimmed(patch.icon) || "🎛️" : existing.icon,
    accent: patch.accent !== undefined ? accentOf(patch.accent) : existing.accent,
    position: patch.position !== undefined && Number.isFinite(Number(patch.position))
      ? Number(patch.position) : existing.position,
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .prepare(`UPDATE boards SET name=@name, icon=@icon, accent=@accent, position=@position, updatedAt=@updatedAt WHERE id=@id`)
    .run(next);
  return true;
}

// --- pages -------------------------------------------------------------------

export interface PageInput { boardId?: unknown; name?: unknown; position?: unknown }

export function createPage(input: PageInput): Page | null {
  const boardId = trimmed(input.boardId);
  const name = trimmed(input.name);
  if (!name || !boardId) return null;
  const board = getDb().prepare(`SELECT id FROM boards WHERE id = ?`).get(boardId);
  if (!board) return null;
  const now = new Date().toISOString();
  const row: PageRow = {
    id: randomUUID(), board_id: boardId, name,
    position: nextPosition("pages", { col: "board_id", id: boardId }),
    createdAt: now,
  };
  getDb()
    .prepare(`INSERT INTO pages (id,board_id,name,position,createdAt) VALUES (@id,@board_id,@name,@position,@createdAt)`)
    .run(row);
  return { id: row.id, boardId, name, position: row.position, createdAt: now, sounds: [] };
}

export function updatePage(id: string, patch: PageInput): boolean {
  const existing = getDb().prepare(`SELECT * FROM pages WHERE id = ?`).get(id) as PageRow | undefined;
  if (!existing) return false;
  const next = {
    id,
    name: patch.name !== undefined ? trimmed(patch.name) || existing.name : existing.name,
    position: patch.position !== undefined && Number.isFinite(Number(patch.position))
      ? Number(patch.position) : existing.position,
  };
  getDb().prepare(`UPDATE pages SET name=@name, position=@position WHERE id=@id`).run(next);
  return true;
}

// --- sounds ------------------------------------------------------------------

export interface SoundInput {
  pageId: string; label: string; accent?: unknown;
  key: string; filename: string; mime: string; size: number;
}

export function createSound(input: SoundInput): Sound | null {
  const pageId = trimmed(input.pageId);
  const label = trimmed(input.label);
  if (!pageId || !input.key) return null;
  const page = getDb().prepare(`SELECT id FROM pages WHERE id = ?`).get(pageId);
  if (!page) return null;
  const row: SoundRow = {
    id: randomUUID(), page_id: pageId, label: label || input.filename || "Sound",
    accent: accentOf(input.accent), key: input.key, filename: input.filename || "",
    mime: input.mime || "application/octet-stream", size: Math.max(0, Math.floor(input.size) || 0),
    position: nextPosition("sounds", { col: "page_id", id: pageId }),
    createdAt: new Date().toISOString(),
  };
  getDb()
    .prepare(`INSERT INTO sounds (id,page_id,label,accent,key,filename,mime,size,position,createdAt)
              VALUES (@id,@page_id,@label,@accent,@key,@filename,@mime,@size,@position,@createdAt)`)
    .run(row);
  return toSound(row);
}

export interface SoundPatch { label?: unknown; accent?: unknown; position?: unknown }

export function updateSound(id: string, patch: SoundPatch): boolean {
  const existing = getDb().prepare(`SELECT * FROM sounds WHERE id = ?`).get(id) as SoundRow | undefined;
  if (!existing) return false;
  const next = {
    id,
    label: patch.label !== undefined ? trimmed(patch.label) || existing.label : existing.label,
    accent: patch.accent !== undefined ? accentOf(patch.accent) : existing.accent,
    position: patch.position !== undefined && Number.isFinite(Number(patch.position))
      ? Number(patch.position) : existing.position,
  };
  getDb().prepare(`UPDATE sounds SET label=@label, accent=@accent, position=@position WHERE id=@id`).run(next);
  return true;
}

// --- deletes (return orphaned storage keys so callers can unlink the bytes) ---

function keysForBoard(id: string): string[] {
  return (getDb()
    .prepare(`SELECT s.key FROM sounds s JOIN pages p ON s.page_id = p.id WHERE p.board_id = ?`)
    .all(id) as { key: string }[]).map((r) => r.key);
}
function keysForPage(id: string): string[] {
  return (getDb().prepare(`SELECT key FROM sounds WHERE page_id = ?`).all(id) as { key: string }[]).map((r) => r.key);
}

export function deleteBoard(id: string): string[] | null {
  const keys = keysForBoard(id);
  const changes = getDb().prepare(`DELETE FROM boards WHERE id = ?`).run(id).changes;
  return changes ? keys : null;
}

export function deletePage(id: string): string[] | null {
  const keys = keysForPage(id);
  const changes = getDb().prepare(`DELETE FROM pages WHERE id = ?`).run(id).changes;
  return changes ? keys : null;
}

export function deleteSound(id: string): string | null {
  const row = getDb().prepare(`SELECT key FROM sounds WHERE id = ?`).get(id) as { key: string } | undefined;
  if (!row) return null;
  getDb().prepare(`DELETE FROM sounds WHERE id = ?`).run(id);
  return row.key;
}
