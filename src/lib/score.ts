/**
 * 공구 적합도 (100점) + 타이밍.
 *
 * 팔로워 수는 점수 축이 아니라 분류 축이다. 팔로워가 많다고 공구를 잘 여는 게 아니라
 * 꾸준히 여는 사람이 잘 연다.
 *
 *   공구 실적   40   최근 30일 건수. 마지막 공구 120일 초과면 50% 감쇠
 *   참여 품질   25   ER 백분위 × credibility. 진성 50% 미만이면 0
 *   카테고리    20   완전일치 20 / 인접 12 / 무관 0
 *   도달 가능성 15   이메일 검증 15 / 인포크 10 / DM만 5
 *   ────────────
 *   경쟁 브랜드 30일 이내 → 제외 · 60일 −15 · 90일 −5
 *   진행·예정 3건 이상 → −8
 */

export const WEIGHTS = { activity: 40, quality: 25, category: 20, reach: 15 } as const;

export const TIERS = [
  { key: "nano", min: 1000, max: 10000, label: "나노" },
  { key: "micro", min: 10000, max: 100000, label: "마이크로" },
  { key: "mid", min: 100000, max: 500000, label: "미드" },
  { key: "macro", min: 500000, max: Infinity, label: "매크로+" },
] as const;

export function tierOf(followers: number | null | undefined, isAgency = false): string {
  if (isAgency) return "agency";
  const f = followers ?? 0;
  const t = TIERS.find((x) => f >= x.min && f < x.max);
  return t ? t.key : "nano";
}

export const TIER_LABEL: Record<string, string> = {
  nano: "나노", micro: "마이크로", mid: "미드", macro: "매크로+", agency: "에이전시",
};

/** 인접 카테고리 — 완전일치 20, 인접 12, 무관 0 */
export const ADJACENT: Record<string, string[]> = {
  리빙: ["인테리어", "가전"],
  인테리어: ["리빙", "가전"],
  가전: ["리빙", "인테리어"],
  육아: ["식품", "리빙"],
  식품: ["건강", "육아"],
  건강: ["식품", "뷰티"],
  뷰티: ["건강", "패션"],
  패션: ["뷰티"],
  여행: [],
  반려동물: ["리빙"],
};

export function relatedCategories(category: string): string[] {
  return [category, ...(ADJACENT[category] ?? [])];
}

export interface ScoreInput {
  deals30d?: number | null;
  deals90d?: number | null;
  daysSinceLast?: number | null;
  avgIntervalDays?: number | null;
  engagementRate?: number | null;
  engagementPercentile?: number | null;
  credibility?: number | null;
  categoryShare?: Record<string, number>;
  reach?: "email" | "inpock" | "dm" | "none" | null;
  emailVerified?: boolean;
  suppressed?: boolean;
  /** 최근 경쟁 브랜드 진행 경과일 */
  brandConflictDays?: number | null;
  brandConflictName?: string | null;
  activeSlots?: number | null;
}

export interface Breakdown {
  activity: number;
  quality: number;
  category: number;
  reach: number;
  penalty: number;
}

export interface ScoreResult {
  score: number;
  excluded: boolean;
  reason?: string;
  breakdown: Breakdown;
  notes: string[];
}

export function fitScore(c: ScoreInput, campaign: { category?: string } = {}): ScoreResult {
  const b: Breakdown = { activity: 0, quality: 0, category: 0, reach: 0, penalty: 0 };
  const notes: string[] = [];

  if (c.suppressed) {
    return { score: 0, excluded: true, reason: "suppression 등재", breakdown: b, notes: ["연락 금지"] };
  }

  // 1. 공구 실적 (40)
  const d90 = c.deals90d ?? (c.deals30d != null ? c.deals30d * 3 : null);
  const n = c.deals30d ?? 0;
  if (n >= 6) b.activity = 40;
  else if (n >= 3) b.activity = 28;
  else if (n >= 1) b.activity = 15;
  else b.activity = 0;
  if (c.daysSinceLast != null && c.daysSinceLast > 120) {
    b.activity = Math.round(b.activity * 0.5);
    notes.push("마지막 공구 120일 초과 · 실적 점수 50% 감쇠");
  }
  if (d90 != null && d90 >= 8) notes.push(`최근 90일 ${d90}건 · 활동성 높음`);

  // 2. 참여 품질 (25) — 진성 팔로워 50% 미만이면 0 으로 클램프
  if (c.credibility != null && c.credibility < 50) {
    notes.push(`진성 팔로워 ${c.credibility}% · 품질 점수 0`);
    b.quality = 0;
  } else {
    const pct = c.engagementPercentile ?? erPercentileFallback(c.engagementRate);
    b.quality = Math.round((pct / 100) * WEIGHTS.quality);
    if (c.credibility != null) b.quality = Math.round(b.quality * Math.min(1, c.credibility / 80));
  }

  // 3. 카테고리 적합 (20)
  const share = c.categoryShare ?? {};
  const target = campaign.category;
  if (target) {
    const direct = share[target] ?? 0;
    const adj = (ADJACENT[target] ?? []).reduce((s, k) => s + (share[k] ?? 0), 0);
    if (direct >= 20) b.category = 20;
    else if (direct > 0) b.category = 14;
    else if (adj >= 20) b.category = 12;
    else if (adj > 0) b.category = 7;
    else b.category = 0;
  } else {
    b.category = 10;
  }

  // 4. 도달 가능성 (15)
  if (c.reach === "email") b.reach = c.emailVerified ? 15 : 12;
  else if (c.reach === "inpock") b.reach = 10;
  else if (c.reach === "dm") b.reach = 5;
  else b.reach = 0;

  // 5. 브랜드 충돌
  if (c.brandConflictDays != null) {
    const who = c.brandConflictName ? `${c.brandConflictName} ` : "경쟁 브랜드 ";
    if (c.brandConflictDays <= 30) {
      return {
        score: 0,
        excluded: true,
        reason: `${who}${c.brandConflictDays}일 전 진행`,
        breakdown: b,
        notes,
      };
    }
    if (c.brandConflictDays <= 60) {
      b.penalty = -15;
      notes.push(`${who}${c.brandConflictDays}일 전 · −15`);
    } else if (c.brandConflictDays <= 90) {
      b.penalty = -5;
      notes.push(`${who}${c.brandConflictDays}일 전 · −5`);
    }
  }

  // 6. 슬롯 여유
  if (c.activeSlots != null && c.activeSlots >= 3) {
    b.penalty += -8;
    notes.push(`진행·예정 ${c.activeSlots}건 · 후순위`);
  }

  const score = Math.max(0, Math.min(100, b.activity + b.quality + b.category + b.reach + b.penalty));
  return { score: Math.round(score), excluded: false, breakdown: b, notes };
}

/** ER 백분위를 모를 때의 근사 */
export function erPercentileFallback(er: number | null | undefined): number {
  if (er == null) return 40;
  const e = er > 1 ? er / 100 : er; // 3.2 로 오든 0.032 로 오든
  if (e >= 0.06) return 95;
  if (e >= 0.04) return 85;
  if (e >= 0.03) return 70;
  if (e >= 0.02) return 55;
  if (e >= 0.01) return 35;
  return 15;
}

export interface Timing {
  ready: boolean;
  ratio: number | null;
  label: string;
  daysToWait?: number;
}

/**
 * 타이밍. 이 시스템의 차별점.
 * 평균 간격 대비 마지막 공구 경과일이 0.8~2.2 배면 "지금이 적기".
 */
export function timing(c: { avgIntervalDays?: number | null; daysSinceLast?: number | null }): Timing {
  const cad = c.avgIntervalDays;
  const last = c.daysSinceLast;
  if (cad == null || last == null || cad <= 0) return { ready: false, ratio: null, label: "데이터 없음" };
  const ratio = last / cad;
  if (ratio < 0.8) {
    const wait = Math.max(1, Math.ceil(cad * 0.8 - last));
    return { ready: false, ratio, daysToWait: wait, label: `아직 이릅니다 · 약 ${wait}일 후 재평가` };
  }
  if (ratio > 2.2) return { ready: false, ratio, label: "휴면 추정 · 계정 재검증 필요" };
  return { ready: true, ratio, label: `적기 · 평균 ${Math.round(cad)}일 간격, 마지막 ${last}일 전` };
}

export const BREAKDOWN_LABEL: Record<keyof Breakdown, string> = {
  activity: "공구 실적",
  quality: "참여 품질",
  category: "카테고리 적합",
  reach: "도달 가능성",
  penalty: "감점",
};
