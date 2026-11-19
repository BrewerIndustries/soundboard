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
  /** YouTube extractor container (see worker/yt.ts). */
  YT: DurableObjectNamespace;
  // secrets
  SESSION_SECRET: string;
  JARVIS_TOKEN: string;
  /** Optional: proxy for yt-dlp, for when YouTube blocks Cloudflare egress IPs. */
  YTDLP_PROXY?: string;
  /** Optional: cookies.txt contents for a throwaway YouTube account. */
  YTDLP_COOKIES?: string;
}
