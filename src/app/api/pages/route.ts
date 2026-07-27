import { NextRequest, NextResponse } from "next/server";
import { createPage } from "@/lib/db";
import { isAuthorized } from "@/lib/auth";

export const runtime = "nodejs";

// POST /api/pages — add a page to a board. { boardId, name }
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const page = createPage(payload);
  if (!page) return NextResponse.json({ error: "need a valid boardId and a non-empty name" }, { status: 400 });
  return NextResponse.json({ page }, { status: 201 });
}
