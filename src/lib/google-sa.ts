import crypto from "node:crypto";
import { all, one, run, tx } from "./db";

/**
 * Google 서비스 계정 + 도메인 전체 위임.
 *
 * 사용자 OAuth 동의 화면을 쓰지 않는다. Workspace 관리자가 도메인에서 한 번
 * 허용하면, 서버가 회사 계정을 대신(impersonate)해 Gmail API 를 호출한다.
 *   · 계정마다 동의를 받을 필요가 없다
 *   · 리프레시 토큰을 저장·갱신할 일이 없다 (매번 JWT 로 발급)
 *   · sales@ 같은 공용 메일함을 사람 계정과 똑같이 다룬다
 *
 * 대가로 권한이 세다. 이 키는 지정 스코프 범위에서 도메인 전 계정의 메일을
 * 열 수 있다 — 키 관리가 곧 보안의 전부다.
 *
 * SDK 를 쓰지 않는다. JWT 서명 + REST 호출 두 단계뿐이라 의존성을 늘릴 이유가 없다.
 */

/**
 * 스코프는 딱 필요한 것만.
 *
 * gmail.modify 나 mail.google.com(전체 권한)은 넣지 않는다. 읽기·작성으로
 * 충분하고, 키가 새면 피해 범위가 달라진다. 수신 중복은 modify(읽음 표시)가
 * 아니라 provider_msg_id 로 막는다.
 */
export const SCOPE_READ = "https://www.googleapis.com/auth/gmail.readonly";
export const SCOPE_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";

/** 도메인 위임에 등록할 문자열. 한 글자라도 다르면 unauthorized_client 가 난다. */
export const DELEGATION_SCOPES = `${SCOPE_READ},${SCOPE_COMPOSE}`;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  client_id?: string;
}

/**
 * 키 JSON 을 읽는다.
 *
 * Vercel 에 넣을 때 private_key 의 \n 이 실제 개행으로 들어가면 서명이 깨진다.
 * 그 경우도 복원해 준다 — "왜 invalid_grant 가 나는지" 를 찾느라 시간을 쓰지 않게.
 */
export function serviceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_SA_KEY_JSON;
  if (!raw || !raw.trim()) return null;
  try {
    const sa = JSON.parse(raw) as ServiceAccount;
    if (!sa.client_email || !sa.private_key) return null;
    // 이스케이프가 풀려 실제 개행으로 들어온 경우를 되돌린다.
    if (!sa.private_key.includes("\n")) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    return sa;
  } catch {
    return null;
  }
}

export function isConfigured(): boolean {
  return serviceAccount() !== null;
}

/**
 * 화면에 보여줄 신원. private_key 는 절대 나가지 않는다.
 *
 * client_id 가 필요한 이유: 관리 콘솔의 도메인 위임 항목이 이 값으로 등록된다.
 * 키를 교체해도 client_id 는 그대로라 설정이 유지된다.
 */
export function identity(): { client_email: string; client_id: string | null } | null {
  const sa = serviceAccount();
  return sa ? { client_email: sa.client_email, client_id: sa.client_id ?? null } : null;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 액세스 토큰. 저장하지 않고 그때그때 발급한다 (1시간 유효).
 *
 * sub 에 넣는 주소가 곧 "대신할 계정" 이다. 아무 주소나 넣으면 그 계정이 되므로
 * 반드시 등록된 메일함 안에서만 부른다 — assertMailbox 를 거치게 되어 있다.
 */
async function accessToken(sub: string, scope: string): Promise<string> {
  const sa = serviceAccount();
  if (!sa) throw new Error("GOOGLE_SA_KEY_JSON 이 설정되지 않았습니다.");

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    sub,
    scope,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string; error?: string; error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(explain(body.error, body.error_description, sub, scope));
  }
  return body.access_token;
}

/** 자주 나오는 실패를 원인과 함께 돌려준다. 원문만 보면 무엇을 고칠지 알 수 없다. */
function explain(code: string | undefined, desc: string | undefined, sub: string, scope: string): string {
  const tail = desc ? ` (${desc})` : "";
  if (code === "unauthorized_client") {
    return `도메인 전체 위임이 아직 반영되지 않았거나 스코프 문자열이 다릅니다${tail}. ` +
      `관리 콘솔에 등록한 스코프가 정확히 "${scope}" 를 포함하는지 확인하세요. 설정 직후라면 수 분 기다려야 합니다.`;
  }
  if (code === "invalid_grant") {
    return `'${sub}' 계정을 대신할 수 없습니다${tail}. 그 주소가 이 Workspace 에 실제로 있는지, ` +
      `private_key 의 줄바꿈이 깨지지 않았는지 확인하세요.`;
  }
  return `토큰 발급 실패: ${code ?? "알 수 없음"}${tail}`;
}

/**
 * impersonate 대상 제한.
 *
 * sub 에 임의 입력값을 넣으면 도메인 안 아무 계정이나 열 수 있다. 등록된
 * 메일함 목록 밖은 거부한다.
 */
export async function assertMailbox(email: string): Promise<string> {
  const e = email.trim().toLowerCase();
  const row = await one<{ email: string }>(`SELECT email FROM mailbox WHERE email=$1`, [e]);
  if (!row) throw new Error(`'${e}' 는 등록된 메일함이 아닙니다. 설정에서 먼저 등록하세요.`);
  return row.email;
}

export interface Mailbox {
  email: string;
  label: string | null;
  enabled: boolean;
  is_default: boolean;
  last_sync_at: string | null;
  last_error: string | null;
}

export async function mailboxes(): Promise<Mailbox[]> {
  return await all<Mailbox>(
    `SELECT email, label, enabled, is_default,
            to_char(last_sync_at,'MM-DD HH24:MI') AS last_sync_at, last_error
       FROM mailbox ORDER BY is_default DESC, email`);
}

export async function defaultMailbox(): Promise<string | null> {
  const r = await one<{ email: string }>(
    `SELECT email FROM mailbox WHERE is_default AND enabled LIMIT 1`);
  return r?.email ?? null;
}

/** 메일 발송. raw 는 base64url MIME. */
export async function sendRaw(from: string, raw: string): Promise<{ id: string; threadId: string }> {
  const sub = await assertMailbox(from);
  const token = await accessToken(sub, SCOPE_COMPOSE);
  const res = await fetch(`${GMAIL}/users/me/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    // 읽기 토큰으로 발송하면 403 이 난다. 위임 스코프에 compose 가 있는지 보게 한다.
    if (res.status === 403) {
      throw new Error(`발송 거부(403). 도메인 위임 스코프에 gmail.compose 가 있는지 확인하세요. ${t.slice(0, 200)}`);
    }
    throw new Error(`발송 실패 ${res.status}: ${t.slice(0, 200)}`);
  }
  return (await res.json()) as { id: string; threadId: string };
}

export interface RawMessage {
  id: string;
  threadId: string;
  payload?: unknown;
  internalDate?: string;
}

/** 최근 메일 목록 + 본문. 등록된 메일함만 연다. */
export async function listMessages(
  mailboxEmail: string,
  opts: { query?: string; limit?: number } = {},
): Promise<RawMessage[]> {
  const sub = await assertMailbox(mailboxEmail);
  const token = await accessToken(sub, SCOPE_READ);
  const q = opts.query ?? "newer_than:30d -in:spam -in:trash";
  const listRes = await fetch(
    `${GMAIL}/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${opts.limit ?? 25}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!listRes.ok) throw new Error(`목록 조회 실패 ${listRes.status}: ${(await listRes.text()).slice(0, 200)}`);
  const list = (await listRes.json()) as { messages?: { id: string }[] };

  const out: RawMessage[] = [];
  for (const m of list.messages ?? []) {
    const r = await fetch(`${GMAIL}/users/me/messages/${m.id}?format=full`, {
      headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) out.push((await r.json()) as RawMessage);
  }
  return out;
}

/** 연결 점검. 발송하지 않고 프로필만 읽는다. */
export async function probe(mailboxEmail: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const sub = await assertMailbox(mailboxEmail);
    const token = await accessToken(sub, SCOPE_READ);
    const res = await fetch(`${GMAIL}/users/me/profile`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { ok: false, detail: `프로필 조회 실패 ${res.status}: ${(await res.text()).slice(0, 160)}` };
    const p = (await res.json()) as { emailAddress: string; messagesTotal: number };
    await run(`UPDATE mailbox SET last_sync_at=now(), last_error=NULL WHERE email=$1`, [sub]);
    return { ok: true, detail: `${p.emailAddress} · 메일 ${p.messagesTotal.toLocaleString("ko-KR")}통` };
  } catch (e) {
    const msg = (e as Error).message;
    await run(`UPDATE mailbox SET last_error=$2 WHERE email=$1`, [mailboxEmail.toLowerCase(), msg]).catch(() => {});
    return { ok: false, detail: msg };
  }
}

/**
 * 메일함 등록.
 *
 * 발송 도메인 밖의 주소는 받지 않는다. 위임은 우리 Workspace 안에서만 통하고,
 * 밖의 주소를 넣으면 invalid_grant 로 실패하는 항목만 하나 늘어난다.
 */
export async function addMailbox(
  email: string, label: string | null, domain: string,
): Promise<{ ok: boolean; error?: string }> {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return { ok: false, error: "이메일 형식이 아닙니다." };
  const d = domain.trim().toLowerCase();
  if (d && !e.endsWith("@" + d)) {
    return { ok: false, error: `발송 도메인(@${d}) 안의 주소만 등록할 수 있습니다. 도메인 위임은 이 Workspace 밖에서는 통하지 않습니다.` };
  }
  // 첫 메일함은 기본 발신함이 된다 — 하나뿐인데 고르라고 물을 이유가 없다.
  const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM mailbox`);
  await run(
    `INSERT INTO mailbox (email, label, is_default) VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET label = EXCLUDED.label`,
    [e, label?.trim() || null, (n?.n ?? 0) === 0]);
  return { ok: true };
}

export async function removeMailbox(email: string): Promise<void> {
  await run(`DELETE FROM mailbox WHERE email=$1`, [email.trim().toLowerCase()]);
}

export async function setEnabled(email: string, enabled: boolean): Promise<void> {
  await run(`UPDATE mailbox SET enabled=$2 WHERE email=$1`, [email.trim().toLowerCase(), enabled]);
}

/**
 * 기본 발신함 변경.
 *
 * 부분 유니크 인덱스가 기본 발신함을 하나로 강제하므로, 먼저 내리고 나서 올린다
 * (한 트랜잭션 안에서 — 중간 상태로 남으면 발송할 곳이 사라진다).
 */
export async function setDefaultMailbox(email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  await tx(async (c) => {
    await c.query(`UPDATE mailbox SET is_default=false WHERE is_default AND email<>$1`, [e]);
    await c.query(`UPDATE mailbox SET is_default=true, enabled=true WHERE email=$1`, [e]);
  });
}
