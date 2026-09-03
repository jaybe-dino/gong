/**
 * 채널 분류.
 *
 * 이 목록이 여섯 군데에 하드코딩돼 있었다. 인링크(inlink.to)를 새 채널로 추가했을 때
 * 정책과 어댑터는 고쳤지만 점수·필터·유효성 규칙은 안 고쳐서, 6,737명이 "연락 수단
 * 없음" 으로 분류되고 도달 가능성 15점을 통째로 잃었다. 가장 큰 채널이 화면에서
 * 사라진 것이다. 한 곳에서만 고치게 한다.
 */

/** 링크페이지 제안 폼. 사람이 열어서 제출한다 — 공식 제출 API 가 없다. */
export const LINK_FORM_CHANNELS = ["inpock_offer", "inlink_form", "linktree_form"] as const;

/** 콜드 아웃리치로 닿을 수 있는 채널. 카카오·문자·전화는 사전 동의가 필요해 빠진다. */
export const REACHABLE_CHANNELS = ["email", ...LINK_FORM_CHANNELS] as const;

/** 선호 순서. 자동 발송이 가능한 이메일이 먼저, 그다음 링크폼, 마지막이 DM 이다. */
export const CHANNEL_RANK = ["email", ...LINK_FORM_CHANNELS, "instagram_dm", "kakao", "phone", "sms"] as const;

/** SQL IN 절에 넣을 문자열. 값이 상수 배열이라 인젝션 여지가 없다. */
export function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(",");
}

/** SQL CASE 로 채널 우선순위를 매긴다. */
export function sqlRank(column: string, values: readonly string[] = CHANNEL_RANK): string {
  return `CASE ${column} ${values.map((v, i) => `WHEN '${v}' THEN ${i}`).join(" ")} ELSE 99 END`;
}
