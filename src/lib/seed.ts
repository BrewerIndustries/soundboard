import type Database from "better-sqlite3";
import { randomUUID } from "crypto";

/**
 * Seed a brand-new database with the starter board from the original idea:
 * board "Hannah" with a "Sounds" page. No audio bytes are seeded — the first
 * pad ("jam quieter") is added by uploading a clip. This just makes a fresh
 * deploy look alive instead of an empty screen.
 */
export function seed(db: Database.Database): void {
  const now = new Date().toISOString();
  const boardId = randomUUID();
  const pageId = randomUUID();
  db.prepare(
    `INSERT INTO boards (id,name,icon,accent,position,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(boardId, "Hannah", "🎤", "purple", 0, now, now);
  db.prepare(
    `INSERT INTO pages (id,board_id,name,position,createdAt) VALUES (?,?,?,?,?)`,
  ).run(pageId, boardId, "Sounds", 0, now);
}
