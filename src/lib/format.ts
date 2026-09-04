export const fmt = (n: number | string | null | undefined) =>
  n == null ? "—" : Number(n).toLocaleString("ko-KR");

/** 108,000 → "10.8만". 표에서 자리수를 고르게 유지한다. */
export const fol = (n: number | string | null | undefined) => {
  if (n == null) return "—";
  const v = Number(n);
  return v >= 10000 ? `${Math.round(v / 1000) / 10}만` : fmt(v);
};

export const won = (n: number | string | null | undefined) => (n == null ? "—" : `${fmt(n)}원`);
export const pct = (n: number, digits = 1) => `${n.toFixed(digits)}%`;

/** 채널 표기 */
export const CHANNEL_LABEL: Record<string, string> = {
  email: "이메일",
  instagram_dm: "인스타 DM",
  inpock_offer: "인포크 제안",
  linktree_form: "링크트리 폼",
  kakao: "카카오 알림톡",
  sms: "SMS",
  phone: "전화",
};

export const AUTOMATION_LABEL: Record<string, string> = {
  auto: "자동",
  manual_task: "작업 큐",
  disabled: "비활성",
};

export const SOURCE_LABEL: Record<string, string> = { momcal: "맘", pangpang: "팡", ingong: "인" };
export const SOURCE_FULL: Record<string, string> = { momcal: "맘캘린더", pangpang: "공구팡팡", ingong: "인공" };

/** 파이프라인 스테이지 배지 색 */
export const STAGE_TONE: Record<string, string> = {
  prospect: "k-mute", qualified: "k-mute", contacted: "k-acc", replied: "k-warn",
  negotiating: "k-warn", agreed: "k-ok", sampling: "k-ok", live: "k-ok",
  settling: "k-acc", complete: "k-ok", dropped: "k-stop",
};

export const SUPPRESSION_KIND: Record<string, string> = {
  email: "이메일", email_domain: "도메인", phone: "전화", ig_handle: "IG 핸들", creator_id: "크리에이터",
};

export const SUPPRESSION_REASON: Record<string, string> = {
  unsubscribe: "수신거부", dnc_request: "연락 금지 요청", hard_bounce: "하드 바운스",
  complaint: "스팸 신고", manual: "수동 등록", legal: "법적 요청",
};

export const SOURCE_TYPE_LABEL: Record<string, string> = {
  bio_public: "공개 bio", link_page_public: "공개 링크페이지", inbound_apply: "인바운드 신청",
  business_card: "명함", referral: "소개",
};

/**
 * 조사 선택. 앞말의 받침 유무로 은/는 · 을/를 · 이/가 를 고른다.
 *
 * 문구를 조립하면 "사업장 주소은 비울 수 없습니다" 같은 문장이 나온다. 화면에
 * 그대로 나가는 말이라 이 정도는 맞춰 준다.
 *
 * 이메일·도메인처럼 라틴 문자로 끝나는 말은 마지막 글자를 읽은 소리로 판정한다
 * (m → "엠", 받침 있음).
 */
/** 라틴 문자 중 한글로 읽었을 때 받침이 남는 것 — 엘·엠·엔·알. */
const LATIN_CODA = new Set(["l", "m", "n", "r"]);
/** 숫자 중 받침이 있는 것 — 영·일·삼·육·칠·팔. */
const DIGIT_CODA = new Set(["0", "1", "3", "6", "7", "8"]);

export function hasCoda(word: string): boolean {
  const ch = word.trim().replace(/[)\]}>"'\s.]+$/, "").slice(-1).toLowerCase();
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  // 한글 음절: (코드 - 0xAC00) % 28 이 0 이 아니면 받침이 있다.
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (DIGIT_CODA.has(ch)) return true;
  return LATIN_CODA.has(ch);
}

/**
 * 쌍은 언제나 "받침 있을 때 · 없을 때" 순서로 쓴다.
 *
 * 와/과 는 다른 조사와 순서가 뒤집혀 있다 (받침이 있으면 '과'). 호출부마다
 * 기억하게 두면 한 번은 틀린다 — 순서를 규칙으로 못 박고 이름도 그렇게 쓴다.
 */
export function josa(word: string, pair: "은는" | "을를" | "이가" | "과와"): string {
  return word + (hasCoda(word) ? pair[0] : pair[1]);
}
