/**
 * 소스별 표기 파서.
 * 09pangpang: "팔로워10.8만", "약 1시간 전", "9/12", "89,000원"
 * insta-gong: "30일 35건", "평균 11일 간격", "마지막 공구 19일 전", "리빙 61%, 인테리어 22%"
 */

const pad = (n: number | string) => String(n).padStart(2, "0");

export interface Followers {
  value: number;
  /** 반올림 오차 폭(±). "10.8만" 은 ±500 이다. */
  precision: number;
}

export function parseFollowers(raw: unknown): Followers | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).replace(/[,\s]/g, "").replace(/^팔로워/, "");
  let m = s.match(/^([\d.]+)억$/);
  if (m) return { value: Math.round(parseFloat(m[1]) * 1e8), precision: 5e6 };
  m = s.match(/^([\d.]+)만$/);
  if (m) {
    const decimals = (m[1].split(".")[1] ?? "").length;
    const unit = 10000 / Math.pow(10, decimals);
    return { value: Math.round(parseFloat(m[1]) * 10000), precision: Math.round(unit / 2) };
  }
  m = s.match(/^([\d.]+)천$/);
  if (m) return { value: Math.round(parseFloat(m[1]) * 1000), precision: 50 };
  m = s.match(/^([\d.]+)[kK]$/);
  if (m) return { value: Math.round(parseFloat(m[1]) * 1000), precision: 50 };
  m = s.match(/^(\d+)$/);
  if (m) return { value: parseInt(m[1], 10), precision: 0 };
  return null;
}

export function parseRelativeTime(raw: unknown, now = new Date()): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/방금|지금/.test(s)) return new Date(now);
  const m = s.match(/(\d+)\s*(분|시간|일|주|개월|년)\s*전/);
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const n = parseInt(m[1], 10);
  const ms: Record<string, number> = { 분: 6e4, 시간: 36e5, 일: 864e5, 주: 6048e5, 개월: 2592e6, 년: 31536e6 };
  return new Date(now.getTime() - n * ms[m[2]]);
}

/** "9/1 (화) 오픈", "2026-09-01", "09-01" → YYYY-MM-DD */
export function parseDate(raw: unknown, refYear: number | string = new Date().getFullYear()): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^상시|^always/i.test(s)) return null;
  let m = s.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/(\d{1,2})[/.-](\d{1,2})/);
  if (m) return `${refYear}-${pad(m[1])}-${pad(m[2])}`;
  return null;
}

/** "2026-09-01 ~ 09-07" → ["2026-09-01","2026-09-07"]. 상시는 [null,null]. */
export function parsePeriod(raw: unknown, refYear?: number | string): [string | null, string | null] {
  if (!raw) return [null, null];
  const s = String(raw).trim();
  if (/상시/.test(s)) return [null, null];
  const parts = s.split(/~|-{2,}|to/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return [parseDate(parts[0], refYear), null];
  const from = parseDate(parts[0], refYear);
  const year = from ? from.slice(0, 4) : refYear;
  let to = parseDate(parts[1], year);
  if (to && parts[1].length <= 5 && from) to = `${year}-${to.slice(5)}`;
  return [from, to];
}

export function parsePrice(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = String(raw).replace(/[^\d]/g, "");
  return n ? parseInt(n, 10) : null;
}

/** "평균 11일 간격" → 11 */
export function parseFirstInt(raw: unknown): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/**
 * 건수 파서. "30일 35건" 에서 35 를 뽑아야 한다 — 30 은 기간이지 건수가 아니다.
 * 단위(건/개/회)가 붙은 숫자를 우선하고, 없으면 마지막 숫자를 쓴다.
 */
export function parseCount(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const s = String(raw);
  const withUnit = s.match(/(\d+(?:\.\d+)?)\s*(?:건|개|회)/);
  if (withUnit) return Number(withUnit[1]);
  const all = s.match(/\d+(?:\.\d+)?/g);
  return all ? Number(all[all.length - 1]) : null;
}

export function parseHashtags(raw: unknown): string[] {
  if (!raw) return [];
  return String(raw).split(/[#,;\s]+/).map((t) => t.trim()).filter(Boolean);
}

/** "리빙 61%, 인테리어 22%" 또는 JSON → { 리빙: 61, 인테리어: 22 } */
export function parseCategoryShare(raw: unknown): Record<string, number> {
  if (!raw) return {};
  const s = String(raw).trim();
  if (s.startsWith("{")) {
    try {
      return JSON.parse(s) as Record<string, number>;
    } catch {
      /* 아래 형식으로 재시도 */
    }
  }
  const out: Record<string, number> = {};
  for (const part of s.split(/[,;|]/)) {
    const m = part.trim().match(/^(.+?)\s*([\d.]+)\s*%$/);
    if (m) out[m[1].trim()] = Number(m[2]);
  }
  return out;
}

/** 브랜드/제품명 정규화 — 문자열 매칭과 중복 제거의 기준 */
export function normName(raw: unknown): string {
  if (!raw) return "";
  return String(raw)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

/** 부재중 자동응답 본문에서 복귀일 추출 → 재스케줄용 */
export function parseReturnDate(body: string | null | undefined, now = new Date()): string | null {
  if (!body) return null;
  let m = body.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})\s*(?:부터|이후|에)?\s*(?:복귀|출근)/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = body.match(/(\d{1,2})[/.월]\s*(\d{1,2})\s*일?\s*(?:부터|이후|에)?\s*(?:복귀|출근)/);
  if (m) return `${now.getFullYear()}-${pad(m[1])}-${pad(m[2])}`;
  m = body.match(/(?:back|return)(?:ing)?\s+on\s+(\w+\s+\d{1,2})/i);
  if (m) {
    const d = new Date(`${m[1]} ${now.getFullYear()}`);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

/** 부재중 자동응답인가. 답장으로 세면 회신율이 부풀고 시퀀스가 잘못 멈춘다. */
const OOO_PATTERNS = [
  /자동\s*(회신|응답)/, /부재\s*중/, /휴가\s*중/, /out of office/i,
  /auto[- ]?reply/i, /automatic reply/i, /away from (my )?desk/i, /수신확인/,
];
export function isAutoReply(subject: string | null | undefined, body: string | null | undefined): boolean {
  const t = `${subject ?? ""}\n${body ?? ""}`;
  return OOO_PATTERNS.some((re) => re.test(t));
}
