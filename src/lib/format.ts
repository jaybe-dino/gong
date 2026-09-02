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
