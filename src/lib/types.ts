// ---- accent palette ---------------------------------------------------------
// Shared pastel palette (ported from its sibling, idea-log) used to colour boards
// and individual sound pads. Each key maps to a tile background, a bold "pressed"
// colour, and readable text.

export const ACCENT_KEYS = [
  "blue", "sky", "teal", "green", "purple", "amber", "coral", "red", "rose", "gray",
] as const;
export type AccentKey = (typeof ACCENT_KEYS)[number];

export interface Accent {
  tile: string; // pad / tile background
  fg: string; // pad text
  border: string; // pad border
  dot: string; // bold accent (active ring, board dot)
}

export const ACCENT: Record<AccentKey, Accent> = {
  blue: { tile: "#E6F1FB", fg: "#0C447C", border: "#B5D4F4", dot: "#185FA5" },
  sky: { tile: "#E0F4FF", fg: "#0A4A6E", border: "#9AD8F7", dot: "#0A7BC0" },
  teal: { tile: "#E1F5EE", fg: "#085041", border: "#9FE1CB", dot: "#0F6E56" },
  green: { tile: "#E1F5EE", fg: "#085041", border: "#9FE1CB", dot: "#1F8A5B" },
  purple: { tile: "#EEEDFE", fg: "#3C3489", border: "#CECBF6", dot: "#534AB7" },
  amber: { tile: "#FAEEDA", fg: "#633806", border: "#FAC775", dot: "#BA7517" },
  coral: { tile: "#FAECE7", fg: "#4A1B0C", border: "#F5C4B3", dot: "#C0470A" },
  red: { tile: "#FDEEF2", fg: "#6B1530", border: "#F5B8CB", dot: "#C0290A" },
  rose: { tile: "#FDEEF2", fg: "#6B1530", border: "#F5B8CB", dot: "#B5184A" },
  gray: { tile: "#EEEEE8", fg: "#2C2C2A", border: "#D3D1C7", dot: "#6B6B63" },
};

export const DEFAULT_ACCENT: AccentKey = "purple";

export function accentOf(key: unknown): AccentKey {
  return typeof key === "string" && (ACCENT_KEYS as readonly string[]).includes(key)
    ? (key as AccentKey)
    : DEFAULT_ACCENT;
}

// A rotating palette used to auto-colour new pads so a page looks lively without
// the user having to pick a colour for every sound.
export const PAD_PALETTE: AccentKey[] = [
  "purple", "blue", "teal", "amber", "coral", "sky", "rose", "green",
];

// ---- domain -----------------------------------------------------------------
// A soundboard is a tree: boards → pages → sounds. Audio bytes live on disk
// (see storage.ts); a sound row only holds the metadata + storage key.

export interface Sound {
  id: string;
  pageId: string;
  label: string;
  accent: AccentKey;
  key: string; // storage object key (filename on disk); served via /api/audio/<key>
  filename: string; // original upload name, for display + download
  mime: string; // e.g. "audio/mpeg"
  size: number; // bytes
  position: number;
  createdAt: string;
}

export interface Page {
  id: string;
  boardId: string;
  name: string;
  position: number;
  createdAt: string;
  sounds: Sound[];
}

export interface Board {
  id: string;
  name: string;
  icon: string; // emoji
  accent: AccentKey;
  position: number;
  createdAt: string;
  updatedAt: string;
  pages: Page[];
}

/** Human-readable file size, e.g. "1.4 MB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
