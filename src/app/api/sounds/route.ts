import { NextRequest, NextResponse } from "next/server";
import { createSound } from "@/lib/db";
import { isAuthorized } from "@/lib/auth";
import { deleteAudio, putAudio } from "@/lib/storage";

export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per clip

// POST /api/sounds — multipart upload. Fields: file, pageId, label?, accent?
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  const pageId = String(form.get("pageId") ?? "").trim();
  const label = String(form.get("label") ?? "").trim();
  const accent = form.get("accent");

  if (!(file instanceof File)) return NextResponse.json({ error: "missing file" }, { status: 400 });
  if (!pageId) return NextResponse.json({ error: "missing pageId" }, { status: 400 });
  const mime = file.type || "application/octet-stream";
  if (!mime.startsWith("audio/")) {
    return NextResponse.json({ error: "file must be an audio clip" }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "clip too large (max 25 MB)" }, { status: 413 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const key = await putAudio(bytes, mime);

  const sound = createSound({
    pageId,
    label: label || file.name.replace(/\.[^.]+$/, ""),
    accent,
    key,
    filename: file.name,
    mime,
    size: file.size,
  });
  if (!sound) {
    // Page vanished between the auth check and the insert — don't orphan bytes.
    await deleteAudio(key);
    return NextResponse.json({ error: "page not found" }, { status: 404 });
  }
  return NextResponse.json({ sound }, { status: 201 });
}
