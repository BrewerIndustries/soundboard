/**
 * D1 port of the original better-sqlite3 data layer. Same tables, same JSON
 * shapes. Deletes return the orphaned R2 keys so the caller can remove the bytes;
 * child rows are deleted explicitly (in one batch) rather than relying on FK cascade.
 */
import { accentOf, type Board, type Page, type Sound } from "../src/lib/types";

interface BoardRow {
  id: string; name: string; icon: string; accent: string;
  position: number; createdAt: string; updatedAt: string;
}
interface PageRow { id: string; board_id: string; name: string; position: number; createdAt: string }
interface SoundRow {
  id: string; page_id: string; label: string; accent: string; key: string;
  filename: string; mime: string; size: number; position: number; createdAt: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const trimmed = (v: unknown) => str(v).trim();
const posOf = (v: unknown, fallback: number) =>
  v !== undefined && Number.isFinite(Number(v)) ? Number(v) : fallback;

function toSound(r: SoundRow): Sound {
  return {
    id: r.id, pageId: r.page_id, label: r.label, accent: accentOf(r.accent),
    key: r.key, filename: r.filename, mime: r.mime, size: r.size,
    position: r.position, createdAt: r.createdAt,
  };
}

async function nextPosition(db: D1Database, table: "boards" | "pages" | "sounds", scope?: { col: string; id: string }) {
  const where = scope ? `WHERE ${scope.col} = ?` : "";
  const stmt = db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM ${table} ${where}`);
  const row = await (scope ? stmt.bind(scope.id) : stmt).first<{ pos: number }>();
  return row?.pos ?? 0;
}

// --- read (full tree) --------------------------------------------------------

export async function listBoards(db: D1Database): Promise<Board[]> {
  const [b, p, s] = await db.batch([
    db.prepare(`SELECT * FROM boards ORDER BY position, createdAt`),
    db.prepare(`SELECT * FROM pages ORDER BY position, createdAt`),
    db.prepare(`SELECT * FROM sounds ORDER BY position, createdAt`),
  ]);
  const boards = b.results as unknown as BoardRow[];
  const pages = p.results as unknown as PageRow[];
  const sounds = s.results as unknown as SoundRow[];

  const soundsByPage = new Map<string, Sound[]>();
  for (const r of sounds) {
    const list = soundsByPage.get(r.page_id) ?? [];
    list.push(toSound(r));
    soundsByPage.set(r.page_id, list);
  }
  const pagesByBoard = new Map<string, Page[]>();
  for (const r of pages) {
    const page: Page = {
      id: r.id, boardId: r.board_id, name: r.name, position: r.position,
      createdAt: r.createdAt, sounds: soundsByPage.get(r.id) ?? [],
    };
    const list = pagesByBoard.get(r.board_id) ?? [];
    list.push(page);
    pagesByBoard.set(r.board_id, list);
  }
  return boards.map((r) => ({
    id: r.id, name: r.name, icon: r.icon, accent: accentOf(r.accent),
    position: r.position, createdAt: r.createdAt, updatedAt: r.updatedAt,
    pages: pagesByBoard.get(r.id) ?? [],
  }));
}

// --- boards ------------------------------------------------------------------

export interface BoardInput { name?: unknown; icon?: unknown; accent?: unknown; position?: unknown }

export async function createBoard(db: D1Database, input: BoardInput): Promise<Board | null> {
  const name = trimmed(input.name);
  if (!name) return null;
  const now = new Date().toISOString();
  const row: BoardRow = {
    id: crypto.randomUUID(), name, icon: trimmed(input.icon) || "🎛️",
    accent: accentOf(input.accent), position: await nextPosition(db, "boards"),
    createdAt: now, updatedAt: now,
  };
  await db
    .prepare(`INSERT INTO boards (id,name,icon,accent,position,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`)
    .bind(row.id, row.name, row.icon, row.accent, row.position, row.createdAt, row.updatedAt)
    .run();
  return { ...row, accent: accentOf(row.accent), pages: [] };
}

export async function updateBoard(db: D1Database, id: string, patch: BoardInput): Promise<boolean> {
  const e = await db.prepare(`SELECT * FROM boards WHERE id = ?`).bind(id).first<BoardRow>();
  if (!e) return false;
  await db
    .prepare(`UPDATE boards SET name=?, icon=?, accent=?, position=?, updatedAt=? WHERE id=?`)
    .bind(
      patch.name !== undefined ? trimmed(patch.name) || e.name : e.name,
      patch.icon !== undefined ? trimmed(patch.icon) || "🎛️" : e.icon,
      patch.accent !== undefined ? accentOf(patch.accent) : e.accent,
      posOf(patch.position, e.position),
      new Date().toISOString(),
      id,
    )
    .run();
  return true;
}

// --- pages -------------------------------------------------------------------

export interface PageInput { boardId?: unknown; name?: unknown; position?: unknown }

export async function createPage(db: D1Database, input: PageInput): Promise<Page | null> {
  const boardId = trimmed(input.boardId);
  const name = trimmed(input.name);
  if (!name || !boardId) return null;
  if (!(await db.prepare(`SELECT id FROM boards WHERE id = ?`).bind(boardId).first())) return null;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const position = await nextPosition(db, "pages", { col: "board_id", id: boardId });
  await db
    .prepare(`INSERT INTO pages (id,board_id,name,position,createdAt) VALUES (?,?,?,?,?)`)
    .bind(id, boardId, name, position, now)
    .run();
  return { id, boardId, name, position, createdAt: now, sounds: [] };
}

export async function updatePage(db: D1Database, id: string, patch: PageInput): Promise<boolean> {
  const e = await db.prepare(`SELECT * FROM pages WHERE id = ?`).bind(id).first<PageRow>();
  if (!e) return false;
  await db
    .prepare(`UPDATE pages SET name=?, position=? WHERE id=?`)
    .bind(patch.name !== undefined ? trimmed(patch.name) || e.name : e.name, posOf(patch.position, e.position), id)
    .run();
  return true;
}

// --- sounds ------------------------------------------------------------------

export interface SoundInput {
  pageId: string; label: string; accent?: unknown;
  key: string; filename: string; mime: string; size: number;
}

export async function createSound(db: D1Database, input: SoundInput): Promise<Sound | null> {
  const pageId = trimmed(input.pageId);
  if (!pageId || !input.key) return null;
  if (!(await db.prepare(`SELECT id FROM pages WHERE id = ?`).bind(pageId).first())) return null;
  const row: SoundRow = {
    id: crypto.randomUUID(), page_id: pageId, label: trimmed(input.label) || input.filename || "Sound",
    accent: accentOf(input.accent), key: input.key, filename: input.filename || "",
    mime: input.mime || "application/octet-stream", size: Math.max(0, Math.floor(input.size) || 0),
    position: await nextPosition(db, "sounds", { col: "page_id", id: pageId }),
    createdAt: new Date().toISOString(),
  };
  await db
    .prepare(`INSERT INTO sounds (id,page_id,label,accent,key,filename,mime,size,position,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(row.id, row.page_id, row.label, row.accent, row.key, row.filename, row.mime, row.size, row.position, row.createdAt)
    .run();
  return toSound(row);
}

export interface SoundPatch { label?: unknown; accent?: unknown; position?: unknown }

export async function updateSound(db: D1Database, id: string, patch: SoundPatch): Promise<boolean> {
  const e = await db.prepare(`SELECT * FROM sounds WHERE id = ?`).bind(id).first<SoundRow>();
  if (!e) return false;
  await db
    .prepare(`UPDATE sounds SET label=?, accent=?, position=? WHERE id=?`)
    .bind(
      patch.label !== undefined ? trimmed(patch.label) || e.label : e.label,
      patch.accent !== undefined ? accentOf(patch.accent) : e.accent,
      posOf(patch.position, e.position),
      id,
    )
    .run();
  return true;
}

// --- deletes (return orphaned storage keys) ------------------------------------

const keysOf = (r: D1Result) => (r.results as { key: string }[]).map((x) => x.key);

export async function deleteBoard(db: D1Database, id: string): Promise<string[] | null> {
  const [keys, , , del] = await db.batch([
    db.prepare(`SELECT s.key FROM sounds s JOIN pages p ON s.page_id = p.id WHERE p.board_id = ?`).bind(id),
    db.prepare(`DELETE FROM sounds WHERE page_id IN (SELECT id FROM pages WHERE board_id = ?)`).bind(id),
    db.prepare(`DELETE FROM pages WHERE board_id = ?`).bind(id),
    db.prepare(`DELETE FROM boards WHERE id = ?`).bind(id),
  ]);
  return del.meta.changes ? keysOf(keys) : null;
}

export async function deletePage(db: D1Database, id: string): Promise<string[] | null> {
  const [keys, , del] = await db.batch([
    db.prepare(`SELECT key FROM sounds WHERE page_id = ?`).bind(id),
    db.prepare(`DELETE FROM sounds WHERE page_id = ?`).bind(id),
    db.prepare(`DELETE FROM pages WHERE id = ?`).bind(id),
  ]);
  return del.meta.changes ? keysOf(keys) : null;
}

export async function deleteSound(db: D1Database, id: string): Promise<string | null> {
  const [keys, del] = await db.batch([
    db.prepare(`SELECT key FROM sounds WHERE id = ?`).bind(id),
    db.prepare(`DELETE FROM sounds WHERE id = ?`).bind(id),
  ]);
  return del.meta.changes ? (keysOf(keys)[0] ?? null) : null;
}
