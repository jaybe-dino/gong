/**
 * 템플릿 렌더러.
 *  - {{var}} 치환
 *  - {{RANDOM|A|B|C}} spintax — 수신자마다 문장이 달라진다 (동일 문구 반복은 탐지 신호)
 *  - (광고) 표기 / 전송자 정보 / 수신거부 자동 주입 — 템플릿에서 제거 불가
 *
 * "광/고", "AD" 같은 변칙 표기는 정보통신망법 §50④ 위반이라 렌더러가 거부한다.
 */

export const AD_PREFIX = "(광고)";
const BANNED_AD_VARIANTS = [/\(광\s*[/.]\s*고\)/, /\[AD\]/i, /\(AD\)/i, /\(광\s+고\)/, /광고\s*】/];

export function spin(text: string, rnd: () => number = Math.random): string {
  return String(text).replace(/\{\{RANDOM\|([^}]+)\}\}/g, (_m, group: string) => {
    const opts = group.split("|");
    return opts[Math.floor(rnd() * opts.length)];
  });
}

export function substitute(text: string, vars: Record<string, unknown> = {}): string {
  return String(text).replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null || v === "" ? "" : String(v);
  });
}

export function missingVars(text: string): string[] {
  const found = new Set<string>();
  String(text).replace(/\{\{(\w+)\}\}/g, (m, k: string) => {
    if (k !== "RANDOM") found.add(k);
    return m;
  });
  return [...found];
}

export function hasBannedAdLabel(text: string): boolean {
  return BANNED_AD_VARIANTS.some((re) => re.test(text));
}

export interface TemplateRow {
  subject?: string | null;
  body: string;
  is_ad_content?: boolean;
  channel?: string;
}

export interface PolicyRow {
  requires_ad_label?: boolean;
  requires_optout?: boolean;
}

export interface SenderInfo {
  orgName: string;
  address: string;
  phone: string;
  postalAddress: string;
  unsubUrl?: string;
  unsubMailto?: string;
  displayName?: string;
}

export interface Rendered {
  subject: string | null;
  body: string;
  headers: Record<string, string>;
  warnings: string[];
}

export function render(
  tpl: TemplateRow,
  vars: Record<string, unknown>,
  policy: PolicyRow | null,
  sender: SenderInfo,
  rnd: () => number = Math.random,
): Rendered {
  const warnings: string[] = [];

  const spunSubject = tpl.subject ? spin(tpl.subject, rnd) : null;
  const spunBody = spin(tpl.body, rnd);

  // 치환 전에 검사해야 한다. substitute 가 빈 문자열로 바꿔버린 뒤에는 흔적이 남지 않는다.
  const needed = new Set([...missingVars(spunBody), ...(spunSubject ? missingVars(spunSubject) : [])]);
  const left = [...needed].filter((k) => {
    const v = vars[k];
    return v === undefined || v === null || v === "";
  });
  if (left.length) warnings.push(`치환되지 않은 변수: ${left.join(", ")}`);

  let subject = spunSubject ? substitute(spunSubject, vars) : null;
  let body = substitute(spunBody, vars);

  if (hasBannedAdLabel(body) || (subject && hasBannedAdLabel(subject))) {
    throw new Error('광고 표기 변칙("광/고", "AD" 등)이 감지되었습니다. "(광고)" 만 허용됩니다.');
  }

  // 광고 표기 주입 — 제목이 있으면 제목 맨 앞, 없으면 본문 맨 앞
  if (tpl.is_ad_content && policy?.requires_ad_label) {
    if (subject) {
      if (!subject.startsWith(AD_PREFIX)) subject = `${AD_PREFIX} ${subject}`;
    } else if (!body.startsWith(AD_PREFIX)) {
      body = `${AD_PREFIX} ${body}`;
    }
  }

  // 전송자 정보 + 수신거부
  const footerLines: string[] = [];
  if (policy?.requires_optout) {
    footerLines.push("—");
    footerLines.push(`${sender.orgName} · ${sender.postalAddress} · ${sender.phone} · ${sender.address}`);
    footerLines.push(`수신을 원하지 않으시면 수신거부해 주세요: ${sender.unsubUrl ?? ""}`);
    footerLines.push("수신거부는 무료이며 2일 내 처리됩니다.");
  }
  if (footerLines.length) body = `${body}\n\n${footerLines.join("\n")}`;

  const headers: Record<string, string> = {};
  if (policy?.requires_optout && sender.unsubUrl) {
    // RFC 8058 원클릭 — Gmail/Yahoo 대량 발송자 요구사항
    headers["List-Unsubscribe"] = `<${sender.unsubUrl}>, <mailto:${sender.unsubMailto ?? sender.address}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  return { subject, body, headers, warnings };
}

export function fmtKDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  const s = typeof d === "string" ? d : new Date(d).toISOString().slice(0, 10);
  const [, m, day] = s.split("-");
  return `${Number(m)}월 ${Number(day)}일`;
}
