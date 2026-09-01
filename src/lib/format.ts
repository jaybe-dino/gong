export const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("ko-KR"));

/** 10,800 → "1.1만". 표에서 자리수를 고르게 유지한다. */
export const fol = (n: number | null | undefined) =>
  n == null ? "—" : n >= 10000 ? `${Math.round(n / 1000) / 10}만` : fmt(n);

export const won = (n: number | null | undefined) => (n == null ? "—" : `${fmt(n)}원`);

export const pct = (n: number, digits = 1) => `${n.toFixed(digits)}%`;

export const STAGE_LABEL: Record<string, string> = {
  contacted: "컨택 발송",
  replied: "회신",
  negotiating: "협의",
  confirmed: "확정",
  running: "진행중",
  dropped: "이탈",
};

export const STAGE_TONE: Record<string, string> = {
  contacted: "k-acc",
  replied: "k-warn",
  negotiating: "k-warn",
  confirmed: "k-ok",
  running: "k-ok",
  dropped: "k-stop",
};

export const STAGE_ORDER = ["contacted", "replied", "negotiating", "confirmed", "running", "dropped"] as const;

export const CHANNEL_LABEL: Record<string, string> = {
  email: "이메일",
  ig_dm: "인스타 DM",
  inpock: "인포크 제안",
  linktree: "링크트리 폼",
  kakao: "카카오 알림톡",
  sms: "SMS",
  reply_check: "회신 확인",
};

export const SOURCE_LABEL: Record<string, string> = { momcal: "맘", pang: "팡", ingong: "인" };
export const SOURCE_FULL: Record<string, string> = { momcal: "맘캘린더", pang: "공구팡팡", ingong: "인공" };
