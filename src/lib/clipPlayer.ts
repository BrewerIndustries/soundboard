// Pad playback: each pad is one controllable instance (play/pause, stop, fade in,
// fade out), routed through Web Audio — a per-pad gain node (fades) into a master
// gain (the volume slider). Web Audio also makes volume + fades work on iOS, which
// ignores HTMLMediaElement.volume. Mirrors music-kiosk's clip player, minus the
// Spotify pause/duck handling.

export type ClipStatus = "stopped" | "playing" | "paused" | "fading-in" | "fading-out";

export const audioUrl = (key: string) => `/api/audio/${encodeURIComponent(key)}`;

// ---- Audio graph -------------------------------------------------------------

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let masterVolume = 1;

function graph(): { ctx: AudioContext; master: GainNode } | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = masterVolume;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return { ctx, master: master! };
}

// A volume control for one element: a Web Audio gain node, or element.volume
// (stepped by a timer) when Web Audio isn't available.
type Fader = { set(v: number): void; ramp(to: number, ms: number): void };

const fallbackFaders = new Set<() => void>();

function fader(audio: HTMLAudioElement): Fader {
  const gr = graph();
  if (gr) {
    const g = gr.ctx.createGain();
    gr.ctx.createMediaElementSource(audio).connect(g).connect(gr.master);
    const c = gr.ctx;
    return {
      set: (v) => {
        g.gain.cancelScheduledValues(c.currentTime);
        g.gain.setValueAtTime(v, c.currentTime);
      },
      ramp: (to, ms) => {
        const now = c.currentTime;
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(to, now + Math.max(ms, 10) / 1000);
      },
    };
  }
  let level = 1;
  let timer: ReturnType<typeof setInterval> | null = null;
  const apply = () => (audio.volume = Math.max(0, Math.min(1, level * masterVolume)));
  fallbackFaders.add(apply);
  return {
    set: (v) => {
      if (timer) clearInterval(timer);
      level = v;
      apply();
    },
    ramp: (to, ms) => {
      if (timer) clearInterval(timer);
      const from = level;
      const start = Date.now();
      timer = setInterval(() => {
        const t = Math.min(1, (Date.now() - start) / Math.max(ms, 10));
        level = from + (to - from) * t;
        apply();
        if (t >= 1 && timer) clearInterval(timer);
      }, 30);
    },
  };
}

// Master volume, 0–100.
export function setMasterVolume(percent: number) {
  masterVolume = Math.max(0, Math.min(1, percent / 100));
  if (master && ctx) master.gain.setTargetAtTime(masterVolume, ctx.currentTime, 0.05);
  for (const apply of fallbackFaders) apply();
}

// ---- Pad instances -------------------------------------------------------------

type Handle = {
  audio: HTMLAudioElement;
  fader: Fader;
  status: Exclude<ClipStatus, "stopped">;
  timer: ReturnType<typeof setTimeout> | null;
};

const handles = new Map<string, Handle>();
const listeners = new Set<() => void>();
let version = 0;
let onError: ((msg: string) => void) | null = null;

function emit() {
  version++;
  for (const l of listeners) l();
}

// For useSyncExternalStore in the UI.
export function subscribeClips(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
export const clipsVersion = () => version;
export const clipStatus = (id: string): ClipStatus => handles.get(id)?.status ?? "stopped";
export const activeClipCount = () => handles.size;
export function onClipError(fn: (msg: string) => void) {
  onError = fn;
}

function setStatus(id: string, h: Handle, status: Handle["status"], afterMs?: number, then?: () => void) {
  if (h.timer) clearTimeout(h.timer);
  h.timer = null;
  h.status = status;
  if (afterMs !== undefined)
    h.timer = setTimeout(() => {
      if (handles.get(id) === h) then?.();
    }, afterMs);
  emit();
}

// play() rejects with AbortError when pause() lands before playback starts (e.g.
// a quick play → pause). That's not a failure — the clip is just paused.
const isAbort = (e: unknown) => (e as { name?: string })?.name === "AbortError";

function finish(id: string) {
  const h = handles.get(id);
  if (!h) return;
  handles.delete(id);
  if (h.timer) clearTimeout(h.timer);
  h.audio.pause();
  emit();
}

// Start a pad (or restart it from the top if it's live). Call from a tap.
export function startClip(id: string, key: string, fadeInMs = 0) {
  const existing = handles.get(id);
  if (existing) {
    existing.audio.currentTime = 0;
    resumeClip(id, fadeInMs);
    return;
  }
  const audio = new Audio(audioUrl(key));
  audio.preload = "auto";
  const f = fader(audio);
  f.set(fadeInMs > 0 ? 0 : 1);
  const h: Handle = { audio, fader: f, status: "playing", timer: null };
  handles.set(id, h);
  audio.addEventListener("ended", () => handles.get(id) === h && finish(id));
  audio.addEventListener("error", () => {
    if (handles.get(id) !== h) return;
    finish(id);
    onError?.("Could not play this clip.");
  });
  audio.play().catch((e) => {
    if (handles.get(id) !== h || isAbort(e)) return;
    finish(id);
    onError?.("Could not play this clip.");
  });
  if (fadeInMs > 0) {
    f.ramp(1, fadeInMs);
    setStatus(id, h, "fading-in", fadeInMs, () => setStatus(id, h, "playing"));
  } else emit();
}

export function pauseClip(id: string) {
  const h = handles.get(id);
  if (!h || h.status === "paused") return;
  h.audio.pause();
  setStatus(id, h, "paused");
}

export function resumeClip(id: string, fadeInMs = 0) {
  const h = handles.get(id);
  if (!h) return;
  if (fadeInMs > 0) {
    if (h.status === "paused") h.fader.set(0);
    h.fader.ramp(1, fadeInMs);
    setStatus(id, h, "fading-in", fadeInMs, () => setStatus(id, h, "playing"));
  } else {
    h.fader.set(1);
    setStatus(id, h, "playing");
  }
  h.audio.play().catch((e) => !isAbort(e) && finish(id));
}

export function togglePlay(id: string, key: string) {
  const st = clipStatus(id);
  if (st === "stopped") startClip(id, key);
  else if (st === "paused") resumeClip(id);
  else pauseClip(id);
}

export function stopClip(id: string) {
  finish(id);
}

// Fade in: start silent and rise; resume a paused pad with a fade; or pull a
// fading-out pad back up.
export function fadeInClip(id: string, key: string, ms: number) {
  if (!handles.has(id)) startClip(id, key, ms);
  else resumeClip(id, ms);
}

// Fade out, then stop.
export function fadeOutClip(id: string, ms: number) {
  const h = handles.get(id);
  if (!h) return;
  if (h.status === "paused") return finish(id);
  h.fader.ramp(0, ms);
  setStatus(id, h, "fading-out", ms, () => finish(id));
}

export function stopAllClips() {
  for (const id of [...handles.keys()]) finish(id);
}
