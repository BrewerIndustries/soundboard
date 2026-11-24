import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  activeClipCount,
  clipStatus,
  clipsVersion,
  fadeInClip,
  fadeOutClip,
  onClipError,
  setMasterVolume,
  startClip,
  stopAllClips,
  stopClip,
  subscribeClips,
  togglePlay,
  type ClipStatus,
} from "@/lib/clipPlayer";
import {
  ACCENT,
  ACCENT_KEYS,
  PAD_PALETTE,
  formatBytes,
  type AccentKey,
  type Board,
  type Page,
  type Sound,
} from "@/lib/types";
import { toLogin, type Me } from "@/lib/account";
import AccountPanel from "@/components/AccountPanel";

const PREFS_KEY = "soundboard-playback";

// Per-device playback prefs (volume + fade durations), kept in localStorage.
type Prefs = { volume: number; fadeInMs: number; fadeOutMs: number };
const DEFAULT_PREFS: Prefs = { volume: 100, fadeInMs: 2000, fadeOutMs: 3000 };

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_PREFS;
  }
}

export default function SoundBoard({ env, me }: { env: string | null; me: Me | null }) {
  const [boards, setBoards] = useState<Board[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<null | { kind: "board" } | { kind: "page" } | { kind: "sound"; pageId: string }>(null);

  const [showPlayback, setShowPlayback] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);

  // Re-render whenever any pad changes state (playing, paused, fading…).
  useSyncExternalStore(subscribeClips, clipsVersion, () => 0);

  useEffect(() => {
    setPrefs(loadPrefs());
    onClipError((msg) => setError(msg));
  }, []);

  useEffect(() => {
    setMasterVolume(prefs.volume);
  }, [prefs.volume]);

  const updatePrefs = (p: Partial<Prefs>) =>
    setPrefs((prev) => {
      const next = { ...prev, ...p };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked (private mode) — prefs just won't persist */
      }
      return next;
    });

  const load = useCallback(async () => {
    const res = await fetch("/api/boards", { cache: "no-store" });
    if (res.status === 401) return toLogin();
    const data = await res.json();
    const next: Board[] = data.boards ?? [];
    setBoards(next);
    setLoaded(true);
    // Reconcile the current selection against the refreshed tree.
    setBoardId((prev) => {
      const board = next.find((b) => b.id === prev) ?? next[0] ?? null;
      return board?.id ?? null;
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const board = boards.find((b) => b.id === boardId) ?? null;

  // Keep the selected page valid whenever the board changes.
  useEffect(() => {
    if (!board) {
      setPageId(null);
      return;
    }
    setPageId((prev) => {
      const page = board.pages.find((p) => p.id === prev) ?? board.pages[0] ?? null;
      return page?.id ?? null;
    });
  }, [board]);

  const page: Page | null = board?.pages.find((p) => p.id === pageId) ?? null;

  // --- auth-aware writes -----------------------------------------------------

  const write = useCallback(
    async (url: string, method: string, body?: BodyInit, json = true): Promise<boolean> => {
      setError(null);
      try {
        // Auth rides on the HttpOnly session cookie (same origin).
        const res = await fetch(url, { method, headers: json ? { "content-type": "application/json" } : {}, body });
        if (res.status === 401) {
          toLogin();
          return false;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? `Request failed (${res.status})`);
          return false;
        }
        await load();
        return true;
      } catch {
        setError("Network error — is the server up?");
        return false;
      }
    },
    [load],
  );

  // --- playback --------------------------------------------------------------

  // Tapping a pad plays it from the top (restarting it if it's already live);
  // the button row under it is play/pause, stop, fade in, fade out.
  const play = (sound: Sound) => startClip(sound.id, sound.key);


  // --- mutations -------------------------------------------------------------

  const renameBoard = async (b: Board) => {
    const name = window.prompt("Rename board", b.name)?.trim();
    if (name && name !== b.name) await write(`/api/boards/${b.id}`, "PATCH", JSON.stringify({ name }));
  };
  const deleteBoard = async (b: Board) => {
    if (window.confirm(`Delete board “${b.name}” and all its pages + sounds?`))
      await write(`/api/boards/${b.id}`, "DELETE");
  };
  const renamePage = async (p: Page) => {
    const name = window.prompt("Rename page", p.name)?.trim();
    if (name && name !== p.name) await write(`/api/pages/${p.id}`, "PATCH", JSON.stringify({ name }));
  };
  const deletePage = async (p: Page) => {
    if (window.confirm(`Delete page “${p.name}” and its sounds?`)) await write(`/api/pages/${p.id}`, "DELETE");
  };
  const relabelSound = async (s: Sound) => {
    const label = window.prompt("Rename sound", s.label)?.trim();
    if (label && label !== s.label) await write(`/api/sounds/${s.id}`, "PATCH", JSON.stringify({ label }));
  };
  const deleteSound = async (s: Sound) => {
    if (window.confirm(`Delete sound “${s.label}”?`)) await write(`/api/sounds/${s.id}`, "DELETE");
  };

  // --- reordering (edit mode) -------------------------------------------------
  // Drag a pad by its ⠿ handle. Pointer events rather than HTML5 drag-and-drop,
  // which doesn't fire on touch screens.

  type Drag = { id: string; order: string[]; moved: boolean };
  // The ref is the live gesture (pointer events can outrun a re-render); the
  // state mirrors it so the grid shows the pad moving.
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };

  const saveOrder = async (p: Page, ids: string[]) => {
    const rank = new Map(ids.map((id, i) => [id, i]));
    // Show the new order straight away; the write reloads the tree afterwards.
    setBoards((bs) =>
      bs.map((b) => ({
        ...b,
        pages: b.pages.map((pg) =>
          pg.id !== p.id
            ? pg
            : { ...pg, sounds: [...pg.sounds].sort((x, y) => (rank.get(x.id) ?? 0) - (rank.get(y.id) ?? 0)) },
        ),
      })),
    );
    if (!(await write(`/api/pages/${p.id}/order`, "PUT", JSON.stringify({ ids })))) await load();
  };

  // Moves and the release are heard on window, not via pointer capture: reordering
  // the grid moves DOM nodes, which silently drops capture mid-drag.
  const dragStart = (e: React.PointerEvent, p: Page, id: string) => {
    e.preventDefault();
    const base = p.sounds.map((x) => x.id);
    setDrag({ id, order: base, moved: false });

    const move = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const over = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest<HTMLElement>("[data-sound-id]")?.dataset.soundId;
      if (!over || over === drag.id) return;
      const order = drag.order.filter((x) => x !== drag.id);
      order.splice(drag.order.indexOf(over), 0, drag.id);
      setDrag({ ...drag, order, moved: true });
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const drag = dragRef.current;
      setDrag(null);
      if (ev.type === "pointerup" && drag?.moved && drag.order.join() !== base.join()) void saveOrder(p, drag.order);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  // Ask the extractor container what a video is (title / length) before importing.
  const lookupYouTube = useCallback(async (url: string) => {
    setError(null);
    try {
      const res = await fetch("/api/youtube/info", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (res.status === 401) {
        toLogin();
        return null;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not read that video");
        return null;
      }
      return data as { title?: string; duration?: number; uploader?: string };
    } catch {
      setError("Network error — is the server up?");
      return null;
    }
  }, []);

  return (
    <div className="min-h-screen">
      {env && <div className="env-banner">{env} environment — not production</div>}

      <div className="mx-auto max-w-5xl px-4 pb-24 pt-6">
        {/* header */}
        <header className="mb-5 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-white text-2xl shadow-sm ring-1 ring-black/5">
            🎛️
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-bold tracking-tight">Soundboard</h1>
            <p className="text-sm text-[var(--muted)]">
              Boards → pages → tap a pad to play.
            </p>
          </div>
          {activeClipCount() > 0 && (
            <button
              onClick={stopAllClips}
              className="rounded-full bg-white px-3 py-1.5 text-sm font-semibold text-[var(--ink)] ring-1 ring-black/10 hover:bg-black/5"
            >
              ■ Stop all
            </button>
          )}
          <button
            onClick={() => setShowPlayback((v) => !v)}
            title="Volume & fades"
            className={`rounded-full px-3 py-1.5 text-sm font-semibold ring-1 transition ${
              showPlayback ? "bg-[#534ab7] text-white ring-[#534ab7]" : "bg-white text-[var(--muted)] ring-black/10 hover:bg-black/5"
            }`}
          >
            🔊
          </button>
          <button
            onClick={() => setEdit((e) => !e)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-semibold ring-1 transition ${
              edit
                ? "bg-[#534ab7] text-white ring-[#534ab7]"
                : "bg-white text-[var(--ink)] ring-black/10 hover:bg-black/5"
            }`}
          >
            {edit ? "Done" : "Edit"}
          </button>
          <button
            onClick={() => setShowAccount(true)}
            title={me ? `Account — ${me.email}` : "Account"}
            className="rounded-full bg-white px-3 py-1.5 text-sm font-semibold text-[var(--muted)] ring-1 ring-black/10 hover:bg-black/5"
          >
            👤
          </button>
        </header>

        {/* volume + fade durations */}
        {showPlayback && (
          <div className="mb-4 grid gap-3 rounded-xl bg-white p-3 shadow-sm ring-1 ring-black/5 sm:grid-cols-3">
            <PrefSlider
              label="Volume"
              value={prefs.volume}
              display={`${prefs.volume}%`}
              min={0}
              max={100}
              step={1}
              onChange={(v) => updatePrefs({ volume: v })}
            />
            <PrefSlider
              label="Fade in"
              value={prefs.fadeInMs / 1000}
              display={`${(prefs.fadeInMs / 1000).toFixed(1)} s`}
              min={0.5}
              max={15}
              step={0.5}
              onChange={(v) => updatePrefs({ fadeInMs: Math.round(v * 1000) })}
            />
            <PrefSlider
              label="Fade out"
              value={prefs.fadeOutMs / 1000}
              display={`${(prefs.fadeOutMs / 1000).toFixed(1)} s`}
              min={0.5}
              max={15}
              step={0.5}
              onChange={(v) => updatePrefs({ fadeOutMs: Math.round(v * 1000) })}
            />
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg bg-[#FDEEF2] px-3 py-2 text-sm font-medium text-[#6B1530] ring-1 ring-[#F5B8CB]">
            {error}
          </div>
        )}

        {/* board rail */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {boards.map((b) => {
            const a = ACCENT[b.accent];
            const active = b.id === boardId;
            return (
              <button
                key={b.id}
                onClick={() => setBoardId(b.id)}
                onDoubleClick={() => edit && renameBoard(b)}
                className="flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-semibold ring-1 transition"
                style={{
                  background: active ? a.dot : a.tile,
                  color: active ? "#fff" : a.fg,
                  borderColor: a.border,
                  boxShadow: active ? `0 1px 8px ${a.border}` : undefined,
                }}
              >
                <span>{b.icon}</span>
                <span>{b.name}</span>
                {edit && (
                  <span
                    role="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteBoard(b);
                    }}
                    className="ml-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/15 text-[10px] leading-none text-white hover:bg-black/40"
                  >
                    ✕
                  </span>
                )}
              </button>
            );
          })}
          <button
            onClick={() => setModal({ kind: "board" })}
            className="rounded-full border border-dashed border-[var(--line)] px-3.5 py-2 text-sm font-semibold text-[var(--muted)] hover:border-[#534ab7] hover:text-[#534ab7]"
          >
            ＋ Board
          </button>
        </div>

        {/* page tabs */}
        {board && (
          <div className="mb-5 flex flex-wrap items-center gap-2 border-b border-[var(--line)] pb-3">
            {board.pages.map((p) => {
              const active = p.id === pageId;
              return (
                <button
                  key={p.id}
                  onClick={() => setPageId(p.id)}
                  onDoubleClick={() => edit && renamePage(p)}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                    active ? "bg-white text-[var(--ink)] shadow-sm ring-1 ring-black/10" : "text-[var(--muted)] hover:bg-white/60"
                  }`}
                >
                  {p.name}
                  <span className="text-xs font-normal text-[var(--muted)]">{p.sounds.length}</span>
                  {edit && (
                    <span
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deletePage(p);
                      }}
                      className="ml-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/10 text-[10px] leading-none hover:bg-black/30 hover:text-white"
                    >
                      ✕
                    </span>
                  )}
                </button>
              );
            })}
            <button
              onClick={() => setModal({ kind: "page" })}
              className="rounded-lg px-2.5 py-1.5 text-sm font-semibold text-[var(--muted)] hover:text-[#534ab7]"
            >
              ＋ Page
            </button>
          </div>
        )}

        {/* pad grid */}
        {!loaded ? (
          <p className="py-16 text-center text-sm text-[var(--muted)]">Loading…</p>
        ) : !board ? (
          <Empty
            title="No boards yet"
            hint="Create your first board to start adding sounds."
            action={<PrimaryBtn onClick={() => setModal({ kind: "board" })}>＋ New board</PrimaryBtn>}
          />
        ) : !page ? (
          <Empty
            title="No pages on this board"
            hint="Add a page to hold your sound pads."
            action={<PrimaryBtn onClick={() => setModal({ kind: "page" })}>＋ New page</PrimaryBtn>}
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
            {(drag
              ? drag.order.map((id) => page.sounds.find((x) => x.id === id)).filter((x): x is Sound => !!x)
              : page.sounds
            ).map((s) => {
              const a = ACCENT[s.accent];
              const dragging = drag?.id === s.id;
              const status = clipStatus(s.id);
              const live = status !== "stopped";
              const audible = status === "playing" || status === "fading-in" || status === "fading-out";
              return (
                <div
                  key={s.id}
                  data-sound-id={s.id}
                  className={`pad-card ${live ? "playing" : ""} relative flex flex-col overflow-hidden rounded-2xl ring-1 transition-[opacity,transform] ${
                    dragging ? "z-10 scale-105 opacity-70 shadow-lg" : ""
                  }`}
                  style={{ background: a.tile, color: a.fg, borderColor: a.border, ["--ring" as string]: a.dot }}
                >
                  <button
                    onClick={() => play(s)}
                    title={live ? "Restart" : "Play"}
                    className="pad flex h-24 w-full flex-col items-center justify-center gap-1 px-3 text-center"
                  >
                    <span className="pad-eq text-xl" style={{ color: a.dot }}>
                      {audible ? "▮▮▮" : status === "paused" ? "❚❚" : "▶"}
                    </span>
                    <span className="line-clamp-2 text-sm font-semibold leading-tight">{s.label}</span>
                    <span className="text-[11px] opacity-60">{STATUS_LABEL[status] ?? formatBytes(s.size)}</span>
                  </button>
                  <div className="grid grid-cols-5 gap-1 px-1.5 pb-1.5">
                    <PadBtn
                      label={audible ? "Pause" : "Play"}
                      color={a.dot}
                      onClick={() => togglePlay(s.id, s.key)}
                    >
                      {audible ? "⏸" : "▶"}
                    </PadBtn>
                    <PadBtn label="Stop" color={a.dot} disabled={!live} onClick={() => stopClip(s.id)}>
                      ■
                    </PadBtn>
                    <PadBtn label="Fade in" color={a.dot} onClick={() => fadeInClip(s.id, s.key, prefs.fadeInMs)}>
                      <FadeIcon dir="in" />
                    </PadBtn>
                    <PadBtn
                      label="Fade out"
                      color={a.dot}
                      disabled={!live}
                      onClick={() => fadeOutClip(s.id, prefs.fadeOutMs)}
                    >
                      <FadeIcon dir="out" />
                    </PadBtn>
                    <a
                      href={`/api/audio/${s.key}?download=1`}
                      download
                      title="Download"
                      aria-label={`Download ${s.label}`}
                      className="flex h-8 items-center justify-center rounded-lg bg-white/60 text-sm transition hover:bg-white"
                      style={{ color: a.dot }}
                    >
                      ⬇
                    </a>
                  </div>
                  {edit && (
                    <>
                      <div className="absolute left-1.5 top-1.5">
                        <button
                          type="button"
                          title="Drag to reorder"
                          aria-label={`Drag ${s.label} to reorder`}
                          onPointerDown={(e) => dragStart(e, page, s.id)}
                          className="grid h-6 w-6 cursor-grab touch-none place-items-center rounded-full bg-white/85 text-xs shadow ring-1 ring-black/10 hover:bg-white active:cursor-grabbing"
                        >
                          ⠿
                        </button>
                      </div>
                      <div className="absolute right-1.5 top-1.5 flex gap-1">
                        <IconBtn title="Rename" onClick={() => relabelSound(s)}>✎</IconBtn>
                        <IconBtn title="Delete" onClick={() => deleteSound(s)}>✕</IconBtn>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
            <button
              onClick={() => setModal({ kind: "sound", pageId: page.id })}
              className="grid min-h-[8.5rem] place-items-center rounded-2xl border-2 border-dashed border-[var(--line)] text-sm font-semibold text-[var(--muted)] transition hover:border-[#534ab7] hover:text-[#534ab7]"
            >
              ＋ Add sound
            </button>
          </div>
        )}
      </div>

      {showAccount && <AccountPanel me={me} onClose={() => setShowAccount(false)} />}
      {modal?.kind === "board" && (
        <BoardModal onClose={() => setModal(null)} onSubmit={(body) => write("/api/boards", "POST", JSON.stringify(body))} />
      )}
      {modal?.kind === "page" && board && (
        <PageModal
          onClose={() => setModal(null)}
          onSubmit={(name) => write("/api/pages", "POST", JSON.stringify({ boardId: board.id, name }))}
        />
      )}
      {modal?.kind === "sound" && (
        <SoundModal
          onClose={() => setModal(null)}
          onUpload={(fd) => write("/api/sounds", "POST", fd, false)}
          onLookup={lookupYouTube}
          onYouTube={(body) => write("/api/youtube", "POST", JSON.stringify(body))}
          pageId={modal.pageId}
        />
      )}
    </div>
  );
}

/* ---------- small building blocks ---------- */

const STATUS_LABEL: Partial<Record<ClipStatus, string>> = {
  playing: "Playing",
  paused: "Paused",
  "fading-in": "Fading in…",
  "fading-out": "Fading out…",
};

function PadBtn({
  children,
  label,
  color,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  color: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-8 items-center justify-center rounded-lg bg-white/60 text-sm transition hover:bg-white disabled:opacity-35 disabled:hover:bg-white/60"
      style={{ color }}
    >
      {children}
    </button>
  );
}

// A volume ramp: rising for fade in, falling for fade out.
function FadeIcon({ dir }: { dir: "in" | "out" }) {
  return (
    <svg viewBox="0 0 20 14" className="h-3.5 w-5" aria-hidden="true">
      <path d={dir === "in" ? "M1 13 L19 13 L19 1 Z" : "M1 13 L19 13 L1 1 Z"} fill="currentColor" />
    </svg>
  );
}

function PrefSlider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="text-sm">
      <span className="flex justify-between font-medium">
        {label}
        <span className="tabular-nums text-[var(--muted)]">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-[#534ab7]"
      />
    </label>
  );
}

function PrimaryBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-xl bg-[#534ab7] px-4 py-2 text-sm font-semibold text-white hover:brightness-110">
      {children}
    </button>
  );
}

function IconBtn({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="grid h-6 w-6 place-items-center rounded-full bg-white/85 text-xs shadow ring-1 ring-black/10 hover:bg-white"
    >
      {children}
    </button>
  );
}

function Empty({ title, hint, action }: { title: string; hint: string; action: React.ReactNode }) {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-[var(--line)] bg-white/50 py-16 text-center">
      <p className="text-base font-semibold">{title}</p>
      <p className="mb-4 mt-1 max-w-xs text-sm text-[var(--muted)]">{hint}</p>
      {action}
    </div>
  );
}

function AccentPicker({ value, onChange }: { value: AccentKey; onChange: (a: AccentKey) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ACCENT_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          className={`h-7 w-7 rounded-full ring-2 transition ${value === k ? "ring-black/40" : "ring-transparent"}`}
          style={{ background: ACCENT[k].dot }}
          title={k}
        />
      ))}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-bold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function BoardModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (b: { name: string; icon: string; accent: AccentKey }) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🎤");
  const [accent, setAccent] = useState<AccentKey>("purple");
  const submit = async () => {
    if (!name.trim()) return;
    if (await onSubmit({ name: name.trim(), icon: icon.trim() || "🎛️", accent })) onClose();
  };
  return (
    <Modal title="New board" onClose={onClose}>
      <label className="mb-1 block text-sm font-medium">Name</label>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()}
        className="mb-3 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[#534ab7]" placeholder="Hannah" />
      <label className="mb-1 block text-sm font-medium">Emoji</label>
      <input value={icon} onChange={(e) => setIcon(e.target.value)}
        className="mb-3 w-20 rounded-lg border border-[var(--line)] px-3 py-2 text-center text-lg outline-none focus:border-[#534ab7]" />
      <label className="mb-1 block text-sm font-medium">Colour</label>
      <div className="mb-5"><AccentPicker value={accent} onChange={setAccent} /></div>
      <ModalActions onCancel={onClose} onSubmit={submit} submitLabel="Create board" />
    </Modal>
  );
}

function PageModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const submit = async () => {
    if (!name.trim()) return;
    if (await onSubmit(name.trim())) onClose();
  };
  return (
    <Modal title="New page" onClose={onClose}>
      <label className="mb-1 block text-sm font-medium">Name</label>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()}
        className="mb-5 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[#534ab7]" placeholder="Sounds" />
      <ModalActions onCancel={onClose} onSubmit={submit} submitLabel="Add page" />
    </Modal>
  );
}

type YtLookup = { title?: string; duration?: number; uploader?: string };

/** "1:23" / "1:02:03" / "83" → seconds, or null when it isn't a time. */
function parseTime(value: string): number | null {
  const s = value.trim();
  if (!s) return null;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(s)) return null;
  return s.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

function SoundModal({
  onClose,
  onUpload,
  onLookup,
  onYouTube,
  pageId,
}: {
  onClose: () => void;
  onUpload: (fd: FormData) => Promise<boolean>;
  onLookup: (url: string) => Promise<YtLookup | null>;
  onYouTube: (body: Record<string, unknown>) => Promise<boolean>;
  pageId: string;
}) {
  const [tab, setTab] = useState<"file" | "youtube">("file");
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [accent, setAccent] = useState<AccentKey>(PAD_PALETTE[0]);
  const [busy, setBusy] = useState(false);

  const [ytUrl, setYtUrl] = useState("");
  const [ytStart, setYtStart] = useState("");
  const [ytEnd, setYtEnd] = useState("");
  const [info, setInfo] = useState<YtLookup | null>(null);
  const [checking, setChecking] = useState(false);

  const pickFile = (f: File | null) => {
    setFile(f);
    if (f && !label) setLabel(f.name.replace(/\.[^.]+$/, ""));
  };
  const uploadSubmit = async () => {
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("pageId", pageId);
    fd.set("label", label.trim());
    fd.set("accent", accent);
    const ok = await onUpload(fd);
    setBusy(false);
    if (ok) onClose();
  };

  // Empty start/end mean "from the beginning" / "to the end" — 0 in both cases.
  const startS = ytStart.trim() ? parseTime(ytStart) : 0;
  const endS = ytEnd.trim() ? parseTime(ytEnd) : 0;
  const timesOk = startS !== null && endS !== null && (endS === 0 || endS > startS);
  const ytReady = Boolean(ytUrl.trim()) && timesOk;

  const check = async () => {
    if (!ytUrl.trim()) return;
    setChecking(true);
    const found = await onLookup(ytUrl.trim());
    setChecking(false);
    if (found) {
      setInfo(found);
      if (!label && found.title) setLabel(found.title);
    }
  };

  const ytSubmit = async () => {
    if (!ytReady) return;
    setBusy(true);
    const ok = await onYouTube({
      url: ytUrl.trim(),
      pageId,
      start: startS ?? 0,
      end: endS ?? 0,
      label: label.trim(),
      accent,
    });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal title="Add sound" onClose={onClose}>
      <div className="mb-4 flex gap-1 rounded-xl bg-black/5 p-1 text-sm font-semibold">
        {(["file", "youtube"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`flex-1 rounded-lg px-3 py-1.5 transition ${
              tab === k ? "bg-white shadow-sm" : "text-[var(--muted)] hover:text-[var(--ink)]"
            }`}
          >
            {k === "file" ? "Upload a file" : "From YouTube"}
          </button>
        ))}
      </div>

      {tab === "file" ? (
        <>
          <label className="mb-1 block text-sm font-medium">Audio file</label>
          <input type="file" accept="audio/*" onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            className="mb-3 w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-[#EEEDFE] file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-[#534ab7]" />
        </>
      ) : (
        <>
          <label className="mb-1 block text-sm font-medium">YouTube link</label>
          <div className="mb-2 flex gap-2">
            <input value={ytUrl} onChange={(e) => setYtUrl(e.target.value)}
              onBlur={() => { if (ytUrl.trim() && !info) void check(); }}
              placeholder="https://youtube.com/watch?v=…"
              className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[#534ab7]" />
            <button onClick={check} disabled={!ytUrl.trim() || checking}
              className="shrink-0 rounded-lg bg-[#EEEDFE] px-3 text-sm font-semibold text-[#534ab7] transition hover:brightness-105 disabled:opacity-40">
              {checking ? "Checking…" : "Check"}
            </button>
          </div>
          {info && (
            <p className="mb-3 text-xs text-[var(--muted)]">
              {info.title || "Video found"}{info.duration ? ` · ${clock(info.duration)}` : ""}
            </p>
          )}
          <div className="mb-1 grid grid-cols-2 gap-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium">Start</span>
              <input value={ytStart} onChange={(e) => setYtStart(e.target.value)} placeholder="0:00"
                className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[#534ab7]" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">End</span>
              <input value={ytEnd} onChange={(e) => setYtEnd(e.target.value)} placeholder="end of video"
                className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[#534ab7]" />
            </label>
          </div>
          <p className="mb-3 text-xs text-[var(--muted)]">
            {timesOk
              ? "Trim to the exact moment you want — max 10 minutes."
              : "Times look like 0:12 or 1:02:03, and the end has to come after the start."}
          </p>
        </>
      )}

      <label className="mb-1 block text-sm font-medium">Label</label>
      <input value={label} onChange={(e) => setLabel(e.target.value)}
        className="mb-3 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[#534ab7]"
        placeholder={tab === "file" ? "jam quieter" : "auto-filled from the video title"} />
      <label className="mb-1 block text-sm font-medium">Pad colour</label>
      <div className="mb-5"><AccentPicker value={accent} onChange={setAccent} /></div>

      {tab === "file" ? (
        <ModalActions onCancel={onClose} onSubmit={uploadSubmit}
          submitLabel={busy ? "Uploading…" : "Add sound"} disabled={!file || busy} />
      ) : (
        <ModalActions onCancel={onClose} onSubmit={ytSubmit}
          submitLabel={busy ? "Pulling clip…" : "Pull clip"} disabled={!ytReady || busy} />
      )}
    </Modal>
  );
}

function ModalActions({ onCancel, onSubmit, submitLabel, disabled }: { onCancel: () => void; onSubmit: () => void; submitLabel: string; disabled?: boolean }) {
  return (
    <div className="flex justify-end gap-2">
      <button onClick={onCancel} className="rounded-lg px-3 py-2 text-sm font-semibold text-[var(--muted)] hover:bg-black/5">
        Cancel
      </button>
      <button onClick={onSubmit} disabled={disabled}
        className="rounded-lg bg-[#534ab7] px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40">
        {submitLabel}
      </button>
    </div>
  );
}
