import type { Metadata } from "next";
import SoundBoard from "@/components/SoundBoard";

export const dynamic = "force-dynamic";

/**
 * Resolve the deployment environment label from JARVIS_ENV (set per-env in the
 * server's .env). Production/MAIN leaves it unset → no banner. Mirrors idea-log:
 *  1. Hard prod guard — the prod deploy runs on :4720 (its systemd unit sets
 *     PORT=4720). On that port the banner is suppressed unconditionally.
 *  2. Default-safe — absence of JARVIS_ENV (the prod default) → no banner.
 *  3. Explicit prod values (main/prod/production) → no banner.
 */
function resolveEnv(): string | null {
  if (process.env.PORT === "4720") return null; // (1) never on the prod port
  const raw = (process.env.JARVIS_ENV ?? "").trim().toLowerCase();
  if (!raw || raw === "main" || raw === "prod" || raw === "production") return null; // (2)(3)
  return raw.toUpperCase();
}

export function generateMetadata(): Metadata {
  const env = resolveEnv();
  return { title: env ? `[${env}] Soundboard` : "Soundboard" };
}

export default function Home() {
  return <SoundBoard env={resolveEnv()} />;
}
