/**
 * 세션 인증.
 *
 * 이 콘솔에는 크리에이터의 이메일·전화번호·사업자번호가 들어 있다. 개인정보다.
 * 배포된 상태에서 아무나 열 수 있으면 안 된다.
 *
 * 비밀번호 하나 + 서명 쿠키로 간다. 사용자가 몇 명뿐인 내부 도구에 계정 체계를
 * 붙이는 건 과하고, 붙이는 동안 사이트가 열려 있는 게 더 위험하다.
 *
 * 중요: APP_PASSWORD 가 없으면 아무도 못 들어온다(fail closed). 환경 변수를
 * 빼먹었을 때 사이트가 열려 있는 것보다 닫혀 있는 게 낫다.
 *
 * Web Crypto 만 쓴다 — 미들웨어는 엣지 런타임에서 돌아서 node:crypto 가 없다.
 */

const COOKIE = "gong_session";
const TTL_MS = 12 * 60 * 60 * 1000; // 12시간. 하루 업무 시간보다 짧게.

export const SESSION_COOKIE = COOKIE;

function enc(s: string) {
  return new TextEncoder().encode(s);
}

function b64url(bytes: ArrayBuffer | Uint8Array) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc(data)));
}

/** 길이가 같아도 조기 반환하지 않는다 — 비교 시간으로 값을 알아낼 수 없게. */
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function secret(): string | null {
  return process.env.APP_PASSWORD || null;
}

export function authConfigured(): boolean {
  return Boolean(secret());
}

/** 비밀번호가 맞으면 쿠키에 담을 토큰을 만든다. */
export async function login(password: string): Promise<string | null> {
  const s = secret();
  if (!s) return null;
  if (!timingSafeEqual(password, s)) return null;
  const exp = String(Date.now() + TTL_MS);
  return `${exp}.${await hmac(s, exp)}`;
}

/** 쿠키 토큰 검증. 서명과 만료를 모두 본다. */
export async function verify(token: string | undefined | null): Promise<boolean> {
  const s = secret();
  if (!s || !token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return timingSafeEqual(sig, await hmac(s, exp));
}

/**
 * 로그인 없이 열려 있어야 하는 경로.
 *
 * /u/{token} 은 발송 메일의 수신거부 링크다. 막으면 수신거부가 동작하지 않아
 * 법정 의무를 위반한다 — 절대 막으면 안 된다.
 * /api/cron·/api/admin 은 CRON_SECRET 으로 따로 보호된다.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/u/") ||
    pathname.startsWith("/api/cron/") ||
    pathname.startsWith("/api/admin/") ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico"
  );
}
