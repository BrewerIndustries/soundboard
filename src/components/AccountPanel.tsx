import { useCallback, useEffect, useState } from "react";
import { toLogin, type Me } from "@/lib/account";

const MIN_PASSWORD = 10;

async function call(url: string, method = "GET", body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (res.status === 401) toLogin();
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

/** Account modal: who you are, change password, sign out, and (admins) user management. */
export default function AccountPanel({ me, onClose }: { me: Me | null; onClose: () => void }) {
  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    toLogin();
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold">Account</h2>
            {me && (
              <p className="truncate text-sm text-[var(--muted)]">
                {me.name ? `${me.name} · ` : ""}
                {me.email} · {me.role}
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-[var(--muted)] hover:bg-black/5">
            ✕
          </button>
        </div>

        {me && <ChangePassword />}
        {me?.role === "admin" && <Users me={me} />}

        <div className="mt-5 flex justify-end">
          <button
            onClick={signOut}
            className="rounded-lg px-3 py-2 text-sm font-semibold text-[#6B1530] ring-1 ring-[#F5B8CB] hover:bg-[#FDEEF2]"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[#534ab7]";
const btnCls = "rounded-lg bg-[#534ab7] px-3 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40";

function Note({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={`mt-2 text-sm ${msg.ok ? "text-[#0F6E56]" : "text-[#B5184A]"}`}>{msg.text}</p>;
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (next.length < MIN_PASSWORD) return setMsg({ ok: false, text: `At least ${MIN_PASSWORD} characters.` });
    setBusy(true);
    const r = await call("/api/auth/password", "POST", { current, password: next });
    setBusy(false);
    if (r.ok) {
      setCurrent("");
      setNext("");
    }
    setMsg(r.ok ? { ok: true, text: "Password changed. Other devices were signed out." } : { ok: false, text: r.data.error ?? "Failed" });
  };
  return (
    <details className="rounded-xl bg-[var(--bg)] p-3">
      <summary className="cursor-pointer text-sm font-semibold">Change password</summary>
      <div className="mt-3 grid gap-2">
        <input type="password" autoComplete="current-password" placeholder="Current password" value={current}
          onChange={(e) => setCurrent(e.target.value)} className={inputCls} />
        <input type="password" autoComplete="new-password" placeholder={`New password (${MIN_PASSWORD}+ characters)`} value={next}
          onChange={(e) => setNext(e.target.value)} className={inputCls} />
        <div className="flex justify-end">
          <button onClick={submit} disabled={busy || !current || !next} className={btnCls}>Change password</button>
        </div>
      </div>
      <Note msg={msg} />
    </details>
  );
}

type UserRow = Me;

function Users({ me }: { me: Me }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");

  const load = useCallback(async () => {
    const r = await call("/api/auth/users");
    if (r.ok) setUsers(r.data.users ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Email sending can be unavailable — the API then hands back the link to share by hand.
  const afterInvite = (to: string, data: { emailed?: boolean; link?: string }) => {
    if (data.emailed) {
      setLink(null);
      setMsg({ ok: true, text: `Invite emailed to ${to}.` });
    } else {
      setLink(data.link ? { email: to, url: data.link } : null);
      setMsg({ ok: true, text: `Email isn't available — copy the invite link below and send it to ${to}.` });
    }
  };

  const act = async (url: string, method: string, body?: unknown, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return null;
    const r = await call(url, method, body);
    if (!r.ok) setMsg({ ok: false, text: r.data.error ?? "Failed" });
    await load();
    return r.ok ? r.data : null;
  };

  const invite = async () => {
    setMsg(null);
    const data = await act("/api/auth/users", "POST", { email, name, role });
    if (data) {
      afterInvite(email.trim().toLowerCase(), data);
      setEmail("");
      setName("");
      setRole("member");
    }
  };

  return (
    <div className="mt-4">
      <h3 className="mb-2 text-sm font-bold">Users</h3>
      <ul className="divide-y divide-[var(--line)] rounded-xl ring-1 ring-[var(--line)]">
        {users.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">
                {u.name || u.email}
                {u.id === me.id && <span className="font-normal text-[var(--muted)]"> (you)</span>}
              </div>
              <div className="truncate text-xs text-[var(--muted)]">
                {u.email}
                {u.pending && " · invite pending"}
                {u.disabled && " · disabled"}
              </div>
            </div>
            <select
              value={u.role}
              onChange={(e) => act(`/api/auth/users/${u.id}`, "PATCH", { role: e.target.value })}
              className="rounded-lg border border-[var(--line)] px-1.5 py-1 text-xs"
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
            {u.pending && !u.disabled && (
              <SmallBtn
                onClick={async () => {
                  const data = await act(`/api/auth/users/${u.id}/resend`, "POST");
                  if (data) afterInvite(u.email, data);
                }}
              >
                Resend
              </SmallBtn>
            )}
            <SmallBtn onClick={() => act(`/api/auth/users/${u.id}`, "PATCH", { disabled: !u.disabled })}>
              {u.disabled ? "Enable" : "Disable"}
            </SmallBtn>
            <SmallBtn
              danger
              onClick={() => act(`/api/auth/users/${u.id}`, "DELETE", undefined, `Delete ${u.email}? This can't be undone.`)}
            >
              Delete
            </SmallBtn>
          </li>
        ))}
      </ul>

      <div className="mt-3 grid gap-2 rounded-xl bg-[var(--bg)] p-3 sm:grid-cols-[1fr_1fr_auto_auto]">
        <input type="email" placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        <select value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}
          className="rounded-lg border border-[var(--line)] px-2 py-2 text-sm">
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button onClick={invite} disabled={!email.trim()} className={btnCls}>Invite</button>
      </div>

      <Note msg={msg} />
      {link && <CopyLink email={link.email} url={link.url} />}
    </div>
  );
}

function CopyLink({ email, url }: { email: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      window.prompt(`Invite link for ${email}`, url);
    }
  };
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg bg-[#EEEDFE] p-2">
      <input readOnly value={url} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
      <button onClick={copy} className={btnCls}>{copied ? "Copied" : "Copy link"}</button>
    </div>
  );
}

function SmallBtn({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-2 py-1 text-xs font-semibold ring-1 ${
        danger ? "text-[#6B1530] ring-[#F5B8CB] hover:bg-[#FDEEF2]" : "text-[var(--ink)] ring-black/10 hover:bg-black/5"
      }`}
    >
      {children}
    </button>
  );
}
