/**
 * Cloudflare Email Sending via the `send_email` binding (env.EMAIL). Fails soft:
 * if the binding is missing or send() throws (domain not onboarded yet, limits…),
 * the link is logged with console.log and the caller gets `false` so it can hand
 * the link to an admin instead.
 */
import type { Env } from "./env";

const FROM = { email: "noreply@dabrewer.dev", name: "Soundboard" };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function sendLinkEmail(
  env: Env,
  opts: { to: string; subject: string; intro: string; cta: string; link: string; note: string },
): Promise<boolean> {
  const text = `${opts.intro}\n\n${opts.cta}: ${opts.link}\n\n${opts.note}\n`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f3ef;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1a1a18">
<div style="max-width:440px;margin:0 auto;background:#fff;border-radius:16px;padding:24px">
<div style="font-size:22px;margin-bottom:8px">🎛️ <b>Soundboard</b></div>
<p style="font-size:15px;line-height:1.5">${esc(opts.intro)}</p>
<p><a href="${esc(opts.link)}" style="display:inline-block;background:#534ab7;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:10px">${esc(opts.cta)}</a></p>
<p style="font-size:13px;color:#6b6b63;line-height:1.5">${esc(opts.note)}<br>If the button doesn't work, paste this link: <br><span style="word-break:break-all">${esc(opts.link)}</span></p>
</div></body></html>`;
  if (!env.EMAIL) {
    console.log(`[email:no-binding] to=${opts.to} subject="${opts.subject}" link=${opts.link}`);
    return false;
  }
  try {
    await env.EMAIL.send({ from: FROM, to: opts.to, subject: opts.subject, html, text });
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    console.log(`[email:failed ${code} ${(e as Error).message}] to=${opts.to} subject="${opts.subject}" link=${opts.link}`);
    return false;
  }
}
