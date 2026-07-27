import { NextRequest, NextResponse } from "next/server";
import { deleteBoard, updateBoard } from "@/lib/db";
import { isAuthorized } from "@/lib/auth";
import { deleteAudio } from "@/lib/storage";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/boards/:id — rename / recolour / reorder.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  let patch: Record<string, unknown>;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  return updateBoard(id, patch)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "not found" }, { status: 404 });
}

// DELETE /api/boards/:id — cascades pages + sounds; unlinks their audio bytes.
export async function DELETE(req: NextRequest, ctx: Ctx) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const keys = deleteBoard(id);
  if (keys === null) return NextResponse.json({ error: "not found" }, { status: 404 });
  await Promise.all(keys.map(deleteAudio));
  return NextResponse.json({ ok: true, removedSounds: keys.length });
}
