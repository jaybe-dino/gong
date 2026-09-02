/**
 * 크리에이터 중복 판정.
 *
 * 결정론 매칭 우선순위
 *   1. (platform, platform_user_id) — 있으면 무조건 이것
 *   2. 정규화된 handle 완전 일치
 *   3. 구분자 제거 비교 키 일치 (@sooyeon.living vs @sooyeon_living)
 *   4. 퍼지 점수
 *
 * 점수 정책: ≥0.95 자동 병합 / 0.80~0.95 검토 큐 / 미만 신규
 */

import { comparisonKey, normalizeHandle } from "./handle";
import { normName } from "./parse";

export const AUTO_MERGE = 0.95;
export const REVIEW_MIN = 0.8;

/** 레벤슈타인 유사도 0~1 */
export function similarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return 1 - prev[n] / Math.max(m, n);
}

export interface Incoming {
  handle?: string | null;
  platformUserId?: string | null;
  displayName?: string | null;
  followers?: number | null;
  source?: string;
}

export interface Candidate {
  id: string;
  handle: string;
  platform_user_id?: string | null;
  display_name?: string | null;
  followers?: number | null;
}

export interface MatchResult {
  score: number;
  evidence: string;
  deterministic: boolean;
  handleChanged?: boolean;
}

export function scoreMatch(incoming: Incoming, cand: Candidate): MatchResult {
  const ev: string[] = [];

  // 1. 소스 PK 동일 — 핸들이 달라도 같은 사람. 핸들 변경 신호.
  if (
    incoming.platformUserId &&
    cand.platform_user_id &&
    String(incoming.platformUserId) === String(cand.platform_user_id)
  ) {
    const changed = normalizeHandle(incoming.handle) !== normalizeHandle(cand.handle);
    ev.push(changed ? "소스 PK 동일 · 핸들 변경 추정" : "소스 PK 동일");
    return { score: 1, evidence: ev.join(" · "), deterministic: true, handleChanged: changed };
  }

  const hi = normalizeHandle(incoming.handle);
  const hc = normalizeHandle(cand.handle);

  // 2. 핸들 완전 일치
  if (hi && hc && hi === hc) {
    // 핸들이 같아도 표시명이 크게 다르면 사람이 봐야 한다 (동명이인 · 계정 양도)
    const ni = normName(incoming.displayName);
    const nc = normName(cand.display_name);
    if (ni && nc && ni !== nc && similarity(ni, nc) <= 0.7) {
      return { score: 0.94, evidence: "핸들 완전 일치 · 표시명 불일치 · 동명이인 가능", deterministic: false };
    }
    return { score: 1, evidence: "핸들 완전 일치", deterministic: true };
  }

  let score = 0;

  // 3. 구분자만 다름
  if (hi && hc && comparisonKey(hi) === comparisonKey(hc)) {
    score = 0.9;
    ev.push("구두점 차이만");
  } else if (hi && hc) {
    const s = similarity(hi, hc);
    if (s < 0.6) return { score: 0, evidence: "핸들 불일치", deterministic: false };
    score = 0.55 + s * 0.3;
    ev.push(`핸들 유사 ${s.toFixed(2)}`);
  } else {
    return { score: 0, evidence: "핸들 없음", deterministic: false };
  }

  // 표시명 보정
  const ni = normName(incoming.displayName);
  const nc = normName(cand.display_name);
  if (ni && nc) {
    if (ni === nc) {
      score += 0.06;
      ev.push("표시명 동일");
    } else if (similarity(ni, nc) > 0.7) {
      score += 0.03;
      ev.push("표시명 유사");
    } else {
      score -= 0.08;
      ev.push("표시명 불일치 · 동명이인 가능");
    }
  }

  // 팔로워 보정 — 차이가 크면 다른 사람일 확률이 높다
  const fi = incoming.followers;
  const fc = cand.followers;
  if (fi && fc) {
    const diff = Math.abs(fi - fc) / Math.max(fi, fc);
    if (diff <= 0.05) {
      score += 0.05;
      ev.push(`팔로워 오차 ${(diff * 100).toFixed(0)}%`);
    } else if (diff >= 0.35) {
      score -= 0.1;
      ev.push(`팔로워 차 ${(diff * 100).toFixed(0)}%`);
    }
  }

  score = Math.max(0, Math.min(1, score));
  return { score: Number(score.toFixed(2)), evidence: ev.join(" · "), deterministic: false };
}

export type Verdict = "merge" | "review" | "new";

export function decide(score: number, deterministic = false): Verdict {
  if (deterministic || score >= AUTO_MERGE) return "merge";
  if (score >= REVIEW_MIN) return "review";
  return "new";
}

/**
 * 필드 서바이버십 — 같은 필드를 여러 소스가 줄 때 누구를 믿을지.
 *   팔로워/팔로잉/게시물     → pangpang (유일하게 3종 다 제공)
 *   30·90일 딜 수, 평균 간격 → ingong (직접 계산 없이 제공)
 *   브랜드/큐레이션          → momcal (유일한 정규화 브랜드 엔티티)
 */
export const FIELD_PRIORITY: Record<string, string[]> = {
  followers: ["pangpang", "ingong", "momcal", "manual"],
  following: ["pangpang", "manual"],
  posts_count: ["pangpang", "manual"],
  last_active_at: ["pangpang", "ingong", "manual"],
  deals_30d: ["ingong", "manual"],
  deals_90d: ["ingong", "manual"],
  avg_interval_days: ["ingong", "manual"],
  days_since_last: ["ingong", "manual"],
  category_share: ["ingong", "pangpang", "manual"],
  is_curated: ["momcal", "manual"],
  price_krw: ["pangpang", "manual"],
  open_at: ["pangpang", "momcal", "ingong"],
  brand: ["momcal", "pangpang", "ingong"],
};

export interface FieldCandidate<T> {
  source: string;
  value: T | null | undefined;
  observedAt?: string | Date | null;
}

export function survive<T>(field: string, candidates: FieldCandidate<T>[]): T | null {
  const order = FIELD_PRIORITY[field] ?? ["manual"];
  const usable = candidates.filter((c) => c.value !== null && c.value !== undefined && (c.value as unknown) !== "");
  if (!usable.length) return null;
  usable.sort((a, b) => {
    const ra = order.indexOf(a.source);
    const rb = order.indexOf(b.source);
    const pa = ra < 0 ? 99 : ra;
    const pb = rb < 0 ? 99 : rb;
    if (pa !== pb) return pa - pb;
    return new Date(b.observedAt ?? 0).getTime() - new Date(a.observedAt ?? 0).getTime();
  });
  return usable[0].value as T;
}
