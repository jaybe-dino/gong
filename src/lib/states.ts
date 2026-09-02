/**
 * 상태 3축.
 *  - engineState : 발송 기계의 상태. 워커만 읽고 쓴다. 부호로 의미를 인코딩한다.
 *  - stage       : 사람이 읽는 비즈니스 파이프라인 (DB pipeline_stage 테이블).
 *  - interest    : 회신의 의미.
 *
 * 한 컬럼에 "발송됨" 과 "협의 중" 과 "수신거부" 를 같이 넣으면 반드시 망가진다.
 * 부호 규칙 덕분에 살아 있는 발송 대상이 인덱스 하나로 나온다.
 *   SELECT ... WHERE engine_state > 0
 */

export const ENGINE = {
  QUEUED: 1,
  SENDING: 2,
  IN_SEQUENCE: 3,
  PAUSED: 4,
  PAUSED_OOO: 5, // 부재중 자동응답. 복귀일에 재개.
  REPLIED: -1, // 실패가 아니라 시퀀스의 성공 종료
  NO_REPLY: -2,
  BOUNCED: -3,
  OPTED_OUT: -4,
  SUPPRESSED: -5, // 게이트가 막음
  DROPPED: -6,
} as const;

export const ENGINE_LABEL: Record<number, string> = {
  1: "대기", 2: "발송 중", 3: "시퀀스 진행", 4: "정지", 5: "부재중 대기",
  [-1]: "회신 종료", [-2]: "무응답 종료", [-3]: "바운스",
  [-4]: "수신거부", [-5]: "게이트 차단", [-6]: "이탈",
};

export const isLive = (s: number) => s > 0;
export const isTerminal = (s: number) => s < 0;

/** 허용 전이. 종결(-)에서 진행(+)으로 가는 자동 전이는 존재하지 않는다. */
export const ENGINE_TRANSITIONS: Record<number, number[]> = {
  1: [2, 4, -5, -6],
  2: [3, -3, -5, -4],
  3: [3, 4, 5, -1, -2, -3, -4, -6],
  4: [3, -6],
  5: [3, -6],
};

export function canTransition(from: number, to: number, opts: { manual?: boolean } = {}): boolean {
  if (opts.manual) return true; // 사람은 어디로든 옮길 수 있다 (audit_log 필수)
  if (isTerminal(from)) return false; // 자동화는 종결에서 되돌아가지 않는다
  return (ENGINE_TRANSITIONS[from] ?? []).includes(to);
}

/** 회신 의미. */
export const INTEREST = {
  UNCLASSIFIED: 0,
  INTERESTED: 1,
  ASKING_TERMS: 2,
  SCHEDULED: 3,
  DONE: 4,
  LATER: -1, // 6개월 후 재큐잉. 이탈이 아니다.
  NOT_INTERESTED: -2,
  WRONG_CONTACT: -3,
  DO_NOT_CONTACT: -4,
  OOO: -5,
} as const;

export const INTEREST_LABEL: Record<number, string> = {
  0: "미분류", 1: "관심 있음", 2: "조건 문의", 3: "일정 확정", 4: "진행 완료",
  [-1]: "지금은 아님", [-2]: "관심 없음", [-3]: "담당자 아님", [-4]: "연락 금지", [-5]: "부재중",
};

/** 화면 드롭다운에 쓰는 순서 */
export const INTEREST_CHOICES: { value: number; label: string }[] = [
  { value: 1, label: "1 관심 있음" },
  { value: 2, label: "2 조건 문의" },
  { value: 3, label: "3 일정 확정" },
  { value: 4, label: "4 진행 완료" },
  { value: -1, label: "-1 지금은 아님 (6개월 후 재큐잉)" },
  { value: -2, label: "-2 관심 없음" },
  { value: -3, label: "-3 담당자 아님 / 소속사" },
  { value: -4, label: "-4 연락 금지 (영구 차단)" },
  { value: -5, label: "-5 부재중 자동응답" },
];

export interface InterestEffects {
  stage?: string;
  engineState?: number;
  dropReason?: string;
  issueToken?: boolean;
  requeueAfterDays?: number;
  needsNewContact?: boolean;
  parseReturnDate?: boolean;
  suppress?: { reason: string; channels: string[]; permanent: boolean };
}

/** 회신 분류가 일으키는 부수효과. 라우터/워커가 그대로 실행한다. */
export function interestEffects(interest: number): InterestEffects {
  switch (interest) {
    case INTEREST.SCHEDULED:
      return { stage: "agreed", issueToken: true };
    case INTEREST.DONE:
      return { stage: "complete" };
    case INTEREST.LATER:
      return { requeueAfterDays: 180 };
    case INTEREST.NOT_INTERESTED:
      return { stage: "dropped", engineState: ENGINE.DROPPED, dropReason: "관심 없음" };
    case INTEREST.WRONG_CONTACT:
      return { needsNewContact: true };
    case INTEREST.DO_NOT_CONTACT:
      return {
        stage: "dropped",
        engineState: ENGINE.OPTED_OUT,
        dropReason: "연락 금지 요청",
        suppress: { reason: "dnc_request", channels: [], permanent: true },
      };
    case INTEREST.OOO:
      return { engineState: ENGINE.PAUSED_OOO, parseReturnDate: true };
    case INTEREST.INTERESTED:
    case INTEREST.ASKING_TERMS:
      return { stage: "negotiating" };
    default:
      return {};
  }
}

/** 회신 의미별 배지 색 */
export function interestTone(interest: number | null | undefined): string {
  if (interest == null || interest === 0) return "k-mute";
  if (interest === 3 || interest === 4) return "k-ok";
  if (interest > 0) return "k-acc";
  if (interest === -1) return "k-warn";
  if (interest === -3) return "k-vio";
  if (interest === -5) return "k-mute";
  return "k-stop";
}
