import { all, one, run } from "./db";

/**
 * 앱 설정.
 *
 * 우선순위: DB 값 > 환경 변수 > 기본값.
 *
 * 법정 표기(사업장 주소·전화)는 오타 하나로 발송이 막히는 값이다. 환경 변수로만
 * 두면 고칠 때마다 재배포해야 한다. DB 를 먼저 보되, 환경 변수만 설정된 기존
 * 배포도 그대로 돌게 한다.
 */

export interface SettingSpec {
  key: string;
  label: string;
  env: string;
  fallback: string;
  hint?: string;
  required?: boolean;
  /** 값이 이 형식이 아니면 저장을 거부한다. */
  pattern?: RegExp;
  patternHint?: string;
}

export const SPECS: SettingSpec[] = [
  {
    key: "mail.domain", label: "발송 도메인", env: "MAIL_DOMAIN", fallback: "diboutique.com",
    hint: "SPF·DKIM·DMARC 를 이 도메인에 걸어야 합니다. 회사 메인 도메인과 분리하세요.",
    required: true, pattern: /^[a-z0-9.-]+\.[a-z]{2,}$/i, patternHint: "도메인만 (예: diboutique.com)",
  },
  {
    key: "mail.address", label: "발신 주소", env: "MAIL_BASE_ADDRESS", fallback: "main@diboutique.com",
    hint: "발송·수신을 이 주소 하나로 처리합니다. 회신은 main+cm_{토큰}@ 플러스 주소로 자동 매핑됩니다.",
    required: true, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, patternHint: "이메일 형식",
  },
  {
    key: "mail.org", label: "발신 조직명", env: "MAIL_ORG_NAME", fallback: "Dinostudio (주)",
    hint: "메일 푸터에 들어갑니다.", required: true,
  },
  {
    key: "mail.postal", label: "사업장 주소", env: "MAIL_POSTAL", fallback: "",
    hint: "정보통신망법상 광고 메일에 필수입니다. 비어 있으면 게이트가 발송을 막습니다.",
    required: true,
  },
  {
    key: "mail.phone", label: "연락처", env: "MAIL_PHONE", fallback: "",
    hint: "위와 같은 이유로 필수입니다.", required: true,
  },
  {
    key: "app.base_url", label: "앱 주소", env: "APP_BASE_URL", fallback: "https://gong-three.vercel.app",
    hint: "수신거부 링크와 OAuth 콜백에 씁니다. 발신 도메인과 같으면 도달률에 유리합니다.",
    required: true, pattern: /^https?:\/\/[^\s/]+$/, patternHint: "https://호스트 (끝에 / 없이)",
  },
  {
    key: "google.client_id", label: "Google 클라이언트 ID", env: "GOOGLE_CLIENT_ID", fallback: "",
    hint: "Google Cloud Console → 사용자 인증 정보 → OAuth 클라이언트 ID (웹 애플리케이션).",
  },
  {
    key: "google.client_secret", label: "Google 클라이언트 시크릿", env: "GOOGLE_CLIENT_SECRET", fallback: "",
    hint: "위와 같은 화면에서 발급됩니다. 저장 후에는 화면에 다시 보이지 않습니다.",
  },
  {
    key: "slack.webhook", label: "슬랙 웹훅 (선택)", env: "SLACK_WEBHOOK_URL", fallback: "",
    hint: "내부 알림용. 발송 도메인과 분리된 채널로 보내세요.",
  },
];

/** 화면에 값을 되돌려주지 않는 키. 시크릿은 저장 후 확인만 된다. */
export const SECRET_KEYS = new Set(["google.client_secret"]);

const SPEC_BY_KEY = new Map(SPECS.map((s) => [s.key, s]));

let cache: Map<string, string> | null = null;

async function load(): Promise<Map<string, string>> {
  if (cache) return cache;
  const rows = await all<{ key: string; value: string | null }>(`SELECT key, value FROM app_setting`);
  cache = new Map(rows.filter((r) => r.value != null && r.value !== "").map((r) => [r.key, r.value as string]));
  return cache;
}

/** 캐시를 버린다. 저장 직후에 부른다. */
export function invalidate() {
  cache = null;
}

export async function get(key: string): Promise<string> {
  const spec = SPEC_BY_KEY.get(key);
  const db = (await load()).get(key);
  if (db) return db;
  const env = spec ? process.env[spec.env] : undefined;
  return env || spec?.fallback || "";
}

/** 여러 개를 한 번에. 화면이 쓴다. */
export async function getAll(): Promise<Record<string, string>> {
  const m = await load();
  const out: Record<string, string> = {};
  for (const s of SPECS) out[s.key] = m.get(s.key) || process.env[s.env] || s.fallback || "";
  return out;
}

/** 값이 DB 에서 왔는지 환경 변수에서 왔는지. 화면이 출처를 보여줘야 혼란이 없다. */
export async function sources(): Promise<Record<string, "db" | "env" | "default" | "empty">> {
  const m = await load();
  const out: Record<string, "db" | "env" | "default" | "empty"> = {};
  for (const s of SPECS) {
    out[s.key] = m.get(s.key) ? "db" : process.env[s.env] ? "env" : s.fallback ? "default" : "empty";
  }
  return out;
}

export interface SaveError { key: string; message: string }

/** 형식 검사 후 저장. 하나라도 틀리면 전부 저장하지 않는다. */
export async function save(
  values: Record<string, string>,
  userId: string,
): Promise<SaveError[]> {
  const errors: SaveError[] = [];
  const clean: [string, string][] = [];

  for (const [key, raw] of Object.entries(values)) {
    const spec = SPEC_BY_KEY.get(key);
    if (!spec) continue;
    const v = raw.trim();
    if (!v) {
      // 빈 값은 삭제로 본다. 필수 항목은 환경 변수·기본값이 있어야 지울 수 있다.
      if (spec.required && !process.env[spec.env] && !spec.fallback) {
        errors.push({ key, message: `${spec.label}은 비울 수 없습니다.` });
        continue;
      }
      clean.push([key, ""]);
      continue;
    }
    if (spec.pattern && !spec.pattern.test(v)) {
      errors.push({ key, message: `${spec.label}: ${spec.patternHint ?? "형식이 맞지 않습니다."}` });
      continue;
    }
    clean.push([key, v]);
  }

  if (errors.length) return errors;

  for (const [key, v] of clean) {
    if (v === "") await run(`DELETE FROM app_setting WHERE key=$1`, [key]);
    else await run(
      `INSERT INTO app_setting (key, value, updated_by) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [key, v, userId]);
  }
  invalidate();
  return [];
}

/** 발송에 필요한 값이 다 있는지. 없으면 게이트가 막아야 한다. */
export async function mailReadiness(): Promise<{ ok: boolean; missing: string[] }> {
  const v = await getAll();
  const missing = SPECS.filter((s) => s.required && !v[s.key]).map((s) => s.label);
  return { ok: missing.length === 0, missing };
}

/** 수신거부 링크 기준 주소. */
export async function unsubBase(): Promise<string> {
  const explicit = process.env.UNSUB_BASE_URL;
  if (explicit) return explicit;
  return `${(await get("app.base_url")).replace(/\/$/, "")}/u`;
}

/** OAuth 콜백 주소. Google Cloud Console 에 이 값을 그대로 등록해야 한다. */
export async function oauthRedirect(): Promise<string> {
  return `${(await get("app.base_url")).replace(/\/$/, "")}/api/oauth/google/callback`;
}

export async function testLog(
  kind: string, ok: boolean, detail: unknown, senderId?: string | null, target?: string | null,
) {
  await run(
    `INSERT INTO mail_test (sender_id, kind, target, ok, detail) VALUES ($1,$2,$3,$4,$5)`,
    [senderId ?? null, kind, target ?? null, ok, JSON.stringify(detail ?? {})]);
}

export async function recentTests(limit = 8) {
  return await all<{ kind: string; target: string | null; ok: boolean; detail: Record<string, unknown>; at: string }>(
    `SELECT kind, target, ok, detail, to_char(created_at,'MM-DD HH24:MI') AS at
       FROM mail_test ORDER BY created_at DESC LIMIT $1`, [limit]);
}

export async function senderCount(): Promise<number> {
  return (await one<{ n: number }>(`SELECT count(*)::int AS n FROM sender WHERE is_active`))?.n ?? 0;
}
