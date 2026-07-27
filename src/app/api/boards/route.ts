import { NextRequest, NextResponse } from "next/server";
import { createBoard, listBoards } from "@/lib/db";
import { isAuthorized, tokenIsConfigured } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/boards — the full tree (boards → pages → sounds). Reads are open.
export function GET() {
  return NextResponse.json({ boards: listBoards(), tokenRequired: tokenIsConfigured() });
}

// POST /api/boards — create a board. { name, icon?, accent? }
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const board = createBoard(payload);
  if (!board) return NextResponse.json({ error: "a board needs a non-empty name" }, { status: 400 });
  return NextResponse.json({ board }, { status: 201 });
}
