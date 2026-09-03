import dns from "node:dns/promises";

/**
 * 발송 도메인 DNS 점검.
 *
 * SPF·DKIM·DMARC 가 없으면 네이버·다음·Gmail 이 대부분 스팸으로 분류한다. 대상자
 * 대다수가 naver.com·hanmail.net 이라 이건 선택이 아니다.
 *
 * 사람이 dig 를 쳐서 확인하게 하면 안 한다. 화면에서 바로 보여준다.
 * 판정은 "있다/없다" 와 값의 형식까지만 한다 — 실제 서명 검증은 메일을 한 통
 * 보내봐야 알 수 있고, 그건 발송 테스트가 한다.
 */

export interface DnsRecordCheck {
  key: string;
  label: string;
  host: string;
  /** 조회 실패는 ok=false 가 아니라 unknown 이다 — 없다고 단정하면 안 된다. */
  status: "ok" | "missing" | "warn" | "unknown";
  host_error: string | null;
  found: string | null;
  expected: string;
  note: string;
}

export interface DnsReport {
  domain: string;
  checks: DnsRecordCheck[];
  ok: boolean;
  /** 하나라도 조회에 실패했으면 결과를 신뢰할 수 없다. */
  unknown: boolean;
  checkedAt: string;
}

/** google 은 Workspace 의 기본 DKIM 셀렉터다. 다른 셀렉터를 쓰면 값이 다르다. */
const DKIM_SELECTOR = "google";

/**
 * TXT 조회. 조회 실패와 "레코드 없음" 을 구분한다.
 *
 * 둘을 같이 빈 배열로 돌려주면 DNS 타임아웃이 "SPF 가 없습니다" 로 보인다.
 * 그러면 있는 레코드를 없다고 알려주고, 사용자는 없는 문제를 쫓는다.
 * (실제로 google.com 조회가 ETIMEOUT 이 나면서 "SPF 없음" 으로 표시됐다.)
 */
async function txt(host: string): Promise<{ values: string[]; error: string | null }> {
  try {
    // resolveTxt 는 조각난 문자열 배열을 준다. 붙여야 원래 값이 된다.
    return { values: (await dns.resolveTxt(host)).map((parts) => parts.join("")), error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "UNKNOWN";
    // NXDOMAIN·NODATA 는 "없다" 는 답이다. 그 밖(타임아웃·SERVFAIL)은 모른다는 뜻이다.
    if (code === "ENOTFOUND" || code === "ENODATA") return { values: [], error: null };
    return { values: [], error: code };
  }
}

export async function checkDomain(domain: string): Promise<DnsReport> {
  const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const checks: DnsRecordCheck[] = [];

  // MX — 수신이 되는지. 회신을 받아 분류하려면 필수다.
  let mx: string[] = [];
  let mxErr: string | null = null;
  try {
    mx = (await dns.resolveMx(d)).sort((a, b) => a.priority - b.priority).map((r) => `${r.priority} ${r.exchange}`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (code !== "ENOTFOUND" && code !== "ENODATA") mxErr = code;
  }
  const google = mx.some((r) => /google\.com|googlemail\.com/.test(r));
  checks.push({
    key: "mx", label: "MX (수신)", host: d, host_error: mxErr,
    status: mxErr ? "unknown" : mx.length === 0 ? "missing" : google ? "ok" : "warn",
    found: mx.slice(0, 3).join(" · ") || null,
    expected: "Google Workspace MX",
    note: mxErr ? `조회 실패 (${mxErr}) — 없다는 뜻이 아닙니다. 잠시 후 다시 확인하세요.`
      : mx.length === 0 ? "MX 가 없습니다. 메일을 받을 수 없어 회신 자동 분류가 동작하지 않습니다."
      : google ? "Google 로 향합니다." : "Google 이 아닌 곳을 가리킵니다. 의도한 설정인지 확인하세요.",
  });

  // SPF — 우리 도메인 이름으로 보낼 수 있는 서버 목록
  const spfRes = await txt(d);
  const spfs = spfRes.values.filter((v) => /^v=spf1/i.test(v));
  const spf = spfs[0] ?? null;
  const spfGoogle = Boolean(spf && /include:_spf\.google\.com/i.test(spf));
  checks.push({
    key: "spf", label: "SPF", host: d, host_error: spfRes.error,
    status: spfRes.error ? "unknown"
      : spfs.length === 0 ? "missing"
      : spfs.length > 1 ? "warn"
      : spfGoogle ? "ok" : "warn",
    found: spf,
    expected: "v=spf1 include:_spf.google.com ~all",
    note: spfRes.error ? `조회 실패 (${spfRes.error}) — 없다는 뜻이 아닙니다.`
      : spfs.length === 0 ? "없습니다. 이게 없으면 대부분 스팸으로 갑니다."
      : spfs.length > 1 ? "SPF 레코드가 2개 이상입니다 — 규격 위반이라 전부 무효 처리됩니다. 하나로 합치세요."
      : spfGoogle ? "정상입니다." : "include:_spf.google.com 이 없습니다. Gmail 로 보내면 SPF 가 실패합니다.",
  });

  // DKIM — 본문 서명. Workspace 관리콘솔에서 키를 생성해야 값이 생긴다.
  const dkimHost = `${DKIM_SELECTOR}._domainkey.${d}`;
  const dkimRes = await txt(dkimHost);
  const dkim = dkimRes.values.find((v) => /^v=DKIM1/i.test(v)) ?? null;
  const dkimFull = Boolean(dkim && /p=[A-Za-z0-9+/]{100,}/.test(dkim));
  checks.push({
    key: "dkim", label: "DKIM", host: dkimHost, host_error: dkimRes.error,
    status: dkimRes.error ? "unknown" : !dkim ? "missing" : dkimFull ? "ok" : "warn",
    found: dkim ? `${dkim.slice(0, 48)}…` : null,
    expected: "v=DKIM1; k=rsa; p=…",
    note: dkimRes.error ? `조회 실패 (${dkimRes.error}) — 없다는 뜻이 아닙니다.`
      : !dkim
      ? "없습니다. Workspace 관리콘솔 → 앱 → Gmail → 이메일 인증에서 키를 생성하고 '인증 시작' 을 눌러야 합니다."
      : dkimFull ? "정상입니다." : "공개키(p=)가 비어 있습니다. 키 생성이 끝나지 않았습니다.",
  });

  // DMARC — SPF/DKIM 실패 시 수신 서버가 어떻게 할지
  const dmarcHost = `_dmarc.${d}`;
  const dmarcRes = await txt(dmarcHost);
  const dmarc = dmarcRes.values.find((v) => /^v=DMARC1/i.test(v)) ?? null;
  const strict = Boolean(dmarc && /p=\s*reject/i.test(dmarc));
  checks.push({
    key: "dmarc", label: "DMARC", host: dmarcHost, host_error: dmarcRes.error,
    status: dmarcRes.error ? "unknown" : !dmarc ? "missing" : strict ? "warn" : "ok",
    found: dmarc,
    expected: "v=DMARC1; p=none; rua=mailto:dmarc@" + d,
    note: dmarcRes.error ? `조회 실패 (${dmarcRes.error}) — 없다는 뜻이 아닙니다.`
      : !dmarc
      ? "없습니다. 처음에는 p=none 으로 두고 리포트만 받으세요 — 바로 p=reject 로 걸면 정상 메일도 반송됩니다."
      : strict ? "p=reject 입니다. SPF·DKIM 이 완전히 맞기 전에는 정상 메일도 반송됩니다."
      : "정상입니다.",
  });

  return {
    domain: d,
    checks,
    // 조회 실패가 있으면 "다 됐다" 고 말하지 않는다. 모르는 것은 모른다고 둔다.
    ok: checks.every((c) => c.status === "ok"),
    unknown: checks.some((c) => c.status === "unknown"),
    checkedAt: new Date().toISOString(),
  };
}
