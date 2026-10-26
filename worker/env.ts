export interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  ASSETS: Fetcher;
  /** Cloudflare Email Sending. Optional: sends fail soft (link logged) when absent/failing. */
  EMAIL?: SendEmail;
  /** "dev" → amber non-prod banner; unset/"prod" → none. */
  JARVIS_ENV?: string;
  /** Created as a passwordless admin when the users table is empty. */
  BOOTSTRAP_ADMIN_EMAIL?: string;
  // secrets
  SESSION_SECRET: string;
  JARVIS_TOKEN: string;
}
