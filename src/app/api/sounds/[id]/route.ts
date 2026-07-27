import { NextRequest, NextResponse } from "next/server";
import { deleteSound, updateSound } from "@/lib/db";
import { isAuthorized } from "@/lib/auth";
import { deleteAudio } from "@/lib/storage";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/sounds/:id — relabel / recolour / reorder.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  let patch: Record<string, unknown>;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  return updateSound(id, patch)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "not found" }, { status: 404 });
}

// DELETE /api/sounds/:id — remove the pad and unlink its audio bytes.
export async function DELETE(req: NextRequest, ctx: Ctx) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const key = deleteSound(id);
  if (key === null) return NextResponse.json({ error: "not found" }, { status: 404 });
  await deleteAudio(key);
  return NextResponse.json({ ok: true });
}
