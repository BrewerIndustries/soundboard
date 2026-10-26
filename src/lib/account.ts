// Signed-in user as returned by GET /api/auth/me (shape shared with music-kiosk).
export interface Me {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  created_at: number;
  disabled: boolean;
  pending: boolean;
}

/** Session expired / signed out → the Worker-served login screen, then back here. */
export function toLogin() {
  location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
}
