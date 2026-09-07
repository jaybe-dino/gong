import { CATEGORY_KEYS } from "@/lib/score";

/**
 * 폼이 고를 수 있는 값. 서버 액션 파일에 둘 수 없다 — "use server" 는 async 함수만
 * 내보낼 수 있어서 상수를 두면 빌드가 깨진다.
 *
 * 카테고리를 자유 입력으로 두지 않는 이유: 적합도 100점 중 20점이 카테고리 일치에서
 * 나오는데(score.ADJACENT), 사전에 없는 값을 넣으면 그 20점이 전원 0 이 된다.
 * 화면에는 아무 표시도 없이 순위만 이상해진다.
 */
export const CATEGORIES = CATEGORY_KEYS;

export const STATUSES = new Set(["draft", "running", "closed"]);

export const STATUS_LABEL: Record<string, string> = {
  draft: "초안 — 발송하지 않음",
  running: "진행 중 — 발송 대상",
  closed: "종료",
};
