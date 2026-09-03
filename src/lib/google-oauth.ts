import crypto from "node:crypto";
import { all, one, run } from "./db";
import { get as setting, oauthRedirect } from "./settings";

/**
 * Google OAuth (Gmail 발송·수신 권한).
 *
 * googleapis 라이브러리 없이 HTTP 로 직접 한다. 선택 의존성을 하나 줄이고,
 * 토큰이 어디에 저장되고 언제 갱신되는지 코드에서 그대로 보인다.
 *
 * refresh_token 은 이 계정으로 메일을 보낼 수 있는 열쇠다. DB 에만 두고 화면에는
 * 절대 내보내지 않는다 — 연결 여부와 계정 주소만 보여준다.
 */

/**
 * 필요한 권한.
 *   gmail.send      발송
 *   gmail.readonly  회신 읽기 (인박스 → 캠페인 매핑)
 *   gmail.modify    읽음 표시 · 라벨 (같은 회신을 두 번 처리하지 않게)
 *   openid/email    어느 계정으로 연결됐는지 확인
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "openid",
  "email",
];

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";

export async function clientId(): Promise<string> {
  return await setting("google.client_id");
}

async function clientSecret(): Promise<string> {
  return await setting("google.client_secret");
}

export async function isConfigured(): Promise<boolean> {
  return Boolean((await clientId()) && (await clientSecret()));
}

/**
 * 인증 시작 URL.
 *
 * access_type=offline + prompt=consent 를 둘 다 준다. 이미 승인한 계정을 다시
 * 연결할 때 refresh_token 이 안 오는 경우가 있어서, 명시적으로 다시 묻는다 —
 * refresh_token 이 없으면 액세스 토큰이 만료된 뒤 발송이 멈춘다.
 */
export async function authUrl(senderId: string): Promise<string> {
  const state = crypto.randomBytes(24).toString("base64url");
  await run(`DELETE FROM oauth_state WHERE created_at < now() - interval '30 minutes'`);
  await run(`INSERT INTO oauth_state (state, sender_id) VALUES ($1,$2)`, [state, senderId]);

  const p = new URLSearchParams({
    client_id: await clientId(),
    redirect_uri: await oauthRedirect(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH}?${p}`;
}

export interface ExchangeResult {
  ok: boolean;
  senderId?: string;
  email?: string;
  error?: string;
}

/** 콜백 처리. state 를 확인하고 토큰을 저장한다. */
export async function exchange(code: string, state: string): Promise<ExchangeResult> {
  const row = await one<{ sender_id: string }>(
    `DELETE FROM oauth_state WHERE state=$1 RETURNING sender_id`, [state]);
  if (!row) return { ok: false, error: "state 가 일치하지 않습니다. 인증을 처음부터 다시 시작하세요." };

  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: await clientId(),
      client_secret: await clientSecret(),
      redirect_uri: await oauthRedirect(),
      grant_type: "authorization_code",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string; refresh_token?: string; scope?: string;
    error?: string; error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    return { ok: false, senderId: row.sender_id, error: body.error_description ?? body.error ?? `토큰 교환 실패 (${res.status})` };
  }
  if (!body.refresh_token) {
    return {
      ok: false, senderId: row.sender_id,
      error: "refresh_token 이 오지 않았습니다. 구글 계정 보안 설정에서 이 앱의 접근을 해제하고 다시 연결하세요.",
    };
  }

  let email: string | null = null;
  const who = await fetch(USERINFO, { headers: { Authorization: `Bearer ${body.access_token}` } });
  if (who.ok) email = ((await who.json()) as { email?: string }).email ?? null;

  await run(
    `INSERT INTO oauth_credential (sender_id, provider, account_email, refresh_token, scopes)
     VALUES ($1,'google',$2,$3,$4)
     ON CONFLICT (sender_id) DO UPDATE SET
       account_email=EXCLUDED.account_email, refresh_token=EXCLUDED.refresh_token,
       scopes=EXCLUDED.scopes, obtained_at=now(), last_error=NULL`,
    [row.sender_id, email, body.refresh_token, (body.scope ?? "").split(" ").filter(Boolean)]);

  return { ok: true, senderId: row.sender_id, email: email ?? undefined };
}

/** 액세스 토큰. 매번 refresh_token 으로 새로 받는다 — 짧게 살고 저장하지 않는다. */
export async function accessToken(senderId: string): Promise<string | null> {
  const cred = await one<{ refresh_token: string }>(
    `SELECT refresh_token FROM oauth_credential WHERE sender_id=$1`, [senderId]);
  if (!cred) return null;

  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: await clientId(),
      client_secret: await clientSecret(),
      refresh_token: cred.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) {
    // 실패 사유를 남긴다. "왜 발송이 멈췄나" 를 화면에서 볼 수 있어야 한다.
    await run(`UPDATE oauth_credential SET last_error=$2 WHERE sender_id=$1`,
      [senderId, body.error_description ?? body.error ?? `갱신 실패 (${res.status})`]);
    return null;
  }
  await run(`UPDATE oauth_credential SET last_used_at=now(), last_error=NULL WHERE sender_id=$1`, [senderId]);
  return body.access_token;
}

export interface ConnectionRow {
  sender_id: string;
  identifier: string;
  display_name: string | null;
  channel: string;
  is_active: boolean;
  daily_cap: number;
  current_cap: number;
  sent_today: number;
  paused_until: string | null;
  account_email: string | null;
  scopes: string[] | null;
  obtained_at: string | null;
  last_used_at: string | null;
  last_error: string | null;
}

/** 발신 계정 + 연결 상태. refresh_token 은 반환하지 않는다. */
export async function connections(): Promise<ConnectionRow[]> {
  return await all<ConnectionRow>(
    `SELECT s.id AS sender_id, s.identifier, s.display_name, s.channel, s.is_active,
            s.daily_cap, s.current_cap, s.sent_today,
            to_char(s.paused_until,'MM-DD HH24:MI') AS paused_until,
            c.account_email, c.scopes,
            to_char(c.obtained_at,'YYYY-MM-DD HH24:MI') AS obtained_at,
            to_char(c.last_used_at,'MM-DD HH24:MI') AS last_used_at,
            c.last_error
       FROM sender s
       LEFT JOIN oauth_credential c ON c.sender_id = s.id
      ORDER BY (s.channel='email') DESC, s.identifier`);
}

/** 연결 해제. 토큰만 지운다 — 발신 계정과 발송 이력은 남긴다. */
export async function disconnect(senderId: string) {
  await run(`DELETE FROM oauth_credential WHERE sender_id=$1`, [senderId]);
}
