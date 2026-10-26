import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import SoundBoard from "@/components/SoundBoard";
import { toLogin, type Me } from "@/lib/account";
import "./globals.css";

// Who's signed in + the env label (e.g. "DEV", from the Worker's JARVIS_ENV var,
// so one build works for every environment). A 401 → the login screen.
async function boot() {
  let env: string | null = null;
  let me: Me | null = null;
  try {
    const res = await fetch("/api/auth/me", { cache: "no-store" });
    if (res.status === 401) return toLogin();
    const data = await res.json();
    env = data.env ?? null;
    me = data.user ?? null;
  } catch {
    /* offline — render anyway; fetches will surface errors */
  }
  if (env) document.title = `[${env}] Soundboard`;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <SoundBoard env={env} me={me} />
    </StrictMode>,
  );
}

boot();
