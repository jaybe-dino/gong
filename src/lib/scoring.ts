import { all, one } from "./db";
import { diffDays, today } from "./clock";
import { creatorMetrics, timingRatio, type CreatorMetrics } from "./metrics";
import type { ScoringContext } from "./scoring-context";

/**
 * 적합도 산정.
 *
 * "누구에게" 가 아니라 "언제 누구에게" 를 답하는 것이 목적이다. 그래서 카테고리 적합만
 * 보지 않고 케이던스 타이밍과 슬롯 여유를 같은 비중으로 넣는다.
 *
 * 배점은 합이 정확히 100 이 되도록 잡혀 있다. 가산식에 상한을 씌우면 상위권이 전부
 * 100 으로 뭉쳐 순위가 사라지기 때문이다.
 *
 *   카테고리 적합   0 ~ 55   그 크리에이터의 카테고리 점유율 vs 캠페인 카테고리
 *   케이던스 타이밍 0 ~ 20   평균 간격 대비 마지막 공구 경과일 (1.0 배에서 최대)
 *   슬롯 여유     -12 ~ +8   진행중·예정 공구가 많을수록 후순위
 *   연락 경로      -4 ~ +8   이메일 보유면 자동 시퀀스가 가능하다
 *   검증 큐레이션   0 ~ +5   맘캘린더 사람 검증 플래그
 *   소스 신뢰도     0 ~ +4   몇 개 소스에서 확인된 레코드인가
 *   브랜드 충돌   -15 ~ 0    30일 이내면 점수와 무관하게 제외
 *
 * ScoringContext 를 넘기면 쿼리 없이 메모리에서 계산한다 (목록·세그먼트용).
 * 넘기지 않으면 한 명 분량의 쿼리를 직접 돌린다 (드로어용).
 */

/** 각 축의 최대 배점. 합이 100 이다. */
export const WEIGHTS = { category: 55, timing: 20, slots: 8, reach: 8, curated: 5, sources: 4 } as const;

/**
 * 타이밍 점수. 경과일 / 평균간격 이 1.0 일 때 만점이고 양쪽으로 감소한다.
 * 아직 이른 쪽(<1)을 더 가파르게 깎는다 — 공구를 막 끝낸 셀러에게 보내는 건
 * 늦게 보내는 것보다 나쁘다.
 */
export function timingScore(ratio: number | null): number {
  if (ratio == null) return 0;
  const t = ratio < 1 ? 1 - (1 - ratio) / 0.5 : 1 - (ratio - 1) / 1.3;
  return Math.round(WEIGHTS.timing * Math.max(0, Math.min(1, t)));
}

/** 캠페인 카테고리와 인접한 카테고리. 점유율을 부분 인정한다. */
export const ADJACENT: Record<string, Record<string, number>> = {
  리빙: { 인테리어: 0.8, "주방·청소": 0.7, "생활/장보기": 0.6, 가전: 0.4 },
  인테리어: { 리빙: 0.8, "생활/장보기": 0.4 },
  "육아/키즈": { 육아: 1, "키즈/체험": 0.7, 식품: 0.3, "생활/장보기": 0.3 },
  육아: { "육아/키즈": 1, "키즈/체험": 0.7 },
  식품: { 건강: 0.6, "생활/장보기": 0.5, "육아/키즈": 0.3 },
  건강: { 식품: 0.6 },
  뷰티: { 패션: 0.4, 건강: 0.3 },
  패션: { 뷰티: 0.4 },
  가전: { 리빙: 0.4, "생활/장보기": 0.3 },
  "여행/숙소": { "키즈/체험": 0.4 },
  반려동물: { 리빙: 0.2 },
};

/** 캠페인 카테고리와 점수에 기여할 수 있는 카테고리 전체. 세그먼트 선필터에 쓴다. */
export function relatedCategories(campaignCategory: string): string[] {
  return [campaignCategory, ...Object.keys(ADJACENT[campaignCategory] ?? {})];
}

export interface ScoreReason {
  label: string;
  points: number;
  detail: string;
}

export interface BrandConflict {
  brand: string;
  daysAgo: number;
  verdict: "exclude" | "penalty";
  points: number;
}

export interface FitResult {
  score: number;
  excluded: boolean;
  excludeReason: string | null;
  reasons: ScoreReason[];
  metrics: CreatorMetrics;
  conflict: BrandConflict | null;
}

export interface CampaignLike {
  id: number;
  category: string;
  brand_id: number | null;
}

interface DealFact {
  brandId: number;
  brand: string;
  category: string | null;
  starts_on: string;
}

// ---------- 데이터 접근 (ctx 가 있으면 메모리, 없으면 쿼리) ----------

function getShares(creatorId: number, ctx?: ScoringContext) {
  if (ctx) return ctx.shares.get(creatorId) ?? [];
  return all<{ category: string; pct: number }>(`SELECT category, pct FROM category_share WHERE creator_id = ?`, [creatorId]);
}

function getDeals(creatorId: number, ctx?: ScoringContext): DealFact[] {
  if (ctx) return ctx.deals.get(creatorId) ?? [];
  return all<{ brand_id: number; name: string; category: string | null; starts_on: string }>(
    `SELECT b.id AS brand_id, b.name, b.category, d.starts_on
       FROM deal d
       JOIN social_account a ON a.id = d.account_id
       JOIN brand b ON b.id = d.brand_id
      WHERE a.creator_id = ? AND d.starts_on IS NOT NULL AND d.gone_at IS NULL
      ORDER BY d.starts_on DESC`,
    [creatorId],
  ).map((r) => ({ brandId: r.brand_id, brand: r.name, category: r.category, starts_on: r.starts_on }));
}

function isBlocked(creatorId: number, ctx?: ScoringContext): boolean {
  if (ctx) return ctx.blocked.has(creatorId);
  const hit = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM suppression s
      WHERE s.scope='all' AND (
        s.identifier IN (SELECT '@'||handle FROM social_account WHERE creator_id = ?) OR
        s.identifier IN (SELECT value FROM contact_point WHERE creator_id = ?) OR
        (s.kind='domain' AND EXISTS (
           SELECT 1 FROM contact_point cp WHERE cp.creator_id = ? AND cp.kind='email'
             AND '@'||substr(cp.value, instr(cp.value,'@')+1) = s.identifier)))`,
    [creatorId, creatorId, creatorId],
  );
  return (hit?.n ?? 0) > 0;
}

function getSignals(creatorId: number, ctx?: ScoringContext): { reach: string | null; curated: boolean; sources: number } {
  if (ctx) {
    return {
      reach: ctx.reach.get(creatorId) ?? null,
      curated: ctx.curated.has(creatorId),
      sources: ctx.sourceCount.get(creatorId) ?? 0,
    };
  }
  const r = one<{ curated: number; reach: string | null; sources: number }>(
    `SELECT c.curated,
            (SELECT kind FROM contact_point cp WHERE cp.creator_id = c.id
              ORDER BY CASE kind WHEN 'email' THEN 0 WHEN 'inpock' THEN 1 WHEN 'linktree' THEN 2 ELSE 3 END
              LIMIT 1) AS reach,
            (SELECT COUNT(DISTINCT source) FROM source_ref sr
              WHERE sr.entity_type='creator' AND sr.entity_id = c.id) AS sources
       FROM creator c WHERE c.id = ?`,
    [creatorId],
  );
  return { reach: r?.reach ?? null, curated: r?.curated === 1, sources: r?.sources ?? 0 };
}

// ---------- 개별 축 ----------

/** 캠페인 카테고리에 대한 그 크리에이터의 유효 점유율(0~100). */
export function categoryFit(creatorId: number, campaignCategory: string, ctx?: ScoringContext): { pct: number; detail: string } {
  const shares = getShares(creatorId, ctx);
  if (!shares.length) return { pct: 0, detail: "카테고리 점유율 데이터 없음" };

  const adj = ADJACENT[campaignCategory] ?? {};
  let total = 0;
  const parts: string[] = [];
  for (const s of shares) {
    const weight = s.category === campaignCategory ? 1 : (adj[s.category] ?? 0);
    if (weight <= 0) continue;
    total += s.pct * weight;
    parts.push(`${s.category} ${s.pct}%${weight < 1 ? `×${weight}` : ""}`);
  }
  return { pct: Math.min(100, total), detail: parts.join(" · ") || "겹치는 카테고리 없음" };
}

/**
 * 브랜드 충돌 검사.
 *
 * 캠페인 카테고리와 겹치는 브랜드를 최근 90일 안에 진행한 셀러를 찾는다.
 * 캠페인 자신의 브랜드를 이미 진행 중인 경우도 충돌이다 — 같은 브랜드 공구가
 * 겹치면 셀러끼리 카니발라이즈된다.
 */
export function brandConflict(
  creatorId: number,
  campaign: CampaignLike,
  ref = today(),
  ctx?: ScoringContext,
): BrandConflict | null {
  const adj = ADJACENT[campaign.category] ?? {};
  let worst: BrandConflict | null = null;

  for (const r of getDeals(creatorId, ctx)) {
    const sameBrand = campaign.brand_id != null && r.brandId === campaign.brand_id;
    const overlaps = sameBrand || r.category === campaign.category || (r.category != null && (adj[r.category] ?? 0) >= 0.6);
    if (!overlaps) continue;

    const daysAgo = diffDays(ref, r.starts_on);
    if (daysAgo < 0 || daysAgo > 90) continue;

    const c: BrandConflict =
      daysAgo <= 30
        ? { brand: r.brand, daysAgo, verdict: "exclude", points: 0 }
        : daysAgo <= 60
          ? { brand: r.brand, daysAgo, verdict: "penalty", points: -15 }
          : { brand: r.brand, daysAgo, verdict: "penalty", points: -5 };

    if (!worst || c.verdict === "exclude" || c.points < worst.points) worst = c;
    if (worst.verdict === "exclude") break;
  }
  return worst;
}

export function scoreCreator(creatorId: number, campaign: CampaignLike, ref = today(), ctx?: ScoringContext): FitResult {
  const reasons: ScoreReason[] = [];
  const metrics = ctx
    ? (ctx.metrics.get(creatorId) ?? { deals30: 0, deals90: 0, cadence: null, lastDealDays: null, slots: 0, basis: "none" as const })
    : creatorMetrics(creatorId, ref);

  // 연락 금지는 점수 이전의 문제다.
  if (isBlocked(creatorId, ctx)) {
    return {
      score: 0,
      excluded: true,
      excludeReason: "연락 금지 등록",
      reasons: [{ label: "연락 금지", points: 0, detail: "전 채널 영구 차단 — 제안 대상에서 제외" }],
      metrics,
      conflict: null,
    };
  }

  // 1. 카테고리 적합 (기본 점수)
  const cat = categoryFit(creatorId, campaign.category, ctx);
  const base = Math.min(WEIGHTS.category, Math.round(cat.pct * 0.72));
  reasons.push({ label: "카테고리 적합", points: base, detail: cat.detail });
  let score = base;

  // 2. 브랜드 충돌
  const conflict = brandConflict(creatorId, campaign, ref, ctx);
  if (conflict?.verdict === "exclude") {
    return {
      score: 0,
      excluded: true,
      excludeReason: `${conflict.brand} ${conflict.daysAgo}일 전 진행`,
      reasons: [
        ...reasons,
        { label: "브랜드 충돌", points: 0, detail: `${conflict.brand} ${conflict.daysAgo}일 전 — 30일 이내 제외 규칙` },
      ],
      metrics,
      conflict,
    };
  }
  if (conflict) {
    score += conflict.points;
    reasons.push({ label: "브랜드 충돌", points: conflict.points, detail: `${conflict.brand} ${conflict.daysAgo}일 전` });
  }

  // 3. 케이던스 타이밍
  const ratio = timingRatio(metrics);
  const timing = timingScore(ratio);
  score += timing;
  if (ratio == null) {
    reasons.push({ label: "케이던스 타이밍", points: 0, detail: "간격 계산에 필요한 공구 이력 부족" });
  } else if (ratio >= 0.8 && ratio <= 2.2) {
    reasons.push({
      label: "케이던스 타이밍",
      points: timing,
      detail: `평균 ${Math.round(metrics.cadence!)}일 간격, 마지막 ${metrics.lastDealDays}일 전 — 지금이 적기`,
    });
  } else if (ratio < 0.8) {
    reasons.push({
      label: "케이던스 타이밍",
      points: timing,
      detail: `마지막 공구가 ${metrics.lastDealDays}일 전으로 아직 이름 (적기까지 약 ${Math.max(0, Math.round(metrics.cadence! - metrics.lastDealDays!))}일)`,
    });
  } else {
    reasons.push({
      label: "케이던스 타이밍",
      points: timing,
      detail: `마지막 공구 ${metrics.lastDealDays}일 전, 평균 간격의 ${ratio.toFixed(1)}배 — 휴면 가능성`,
    });
  }

  // 4. 슬롯 여유
  const slotPoints = metrics.slots <= 1 ? WEIGHTS.slots : metrics.slots === 2 ? 2 : metrics.slots === 3 ? -6 : -12;
  score += slotPoints;
  reasons.push({
    label: "슬롯 여유",
    points: slotPoints,
    detail: `진행중·예정 ${metrics.slots}건${metrics.slots >= 3 ? " — 후순위" : ""}`,
  });

  // 보조 신호
  const sig = getSignals(creatorId, ctx);
  if (sig.reach === "email") {
    score += WEIGHTS.reach;
    reasons.push({ label: "연락 경로", points: WEIGHTS.reach, detail: "이메일 보유 — 자동 시퀀스 가능" });
  } else if (sig.reach === "inpock" || sig.reach === "linktree") {
    score += 4;
    reasons.push({ label: "연락 경로", points: 4, detail: `${sig.reach} — 작업 큐 경유` });
  } else if (sig.reach) {
    reasons.push({ label: "연락 경로", points: 0, detail: "DM 만 가능 — 콜드 발송 불가 채널" });
  } else {
    score -= 4;
    reasons.push({ label: "연락 경로", points: -4, detail: "연락 경로 미확보" });
  }

  if (sig.curated) {
    score += WEIGHTS.curated;
    reasons.push({ label: "검증 큐레이션", points: WEIGHTS.curated, detail: "맘캘린더 사람 검증 플래그" });
  }

  const srcBonus = sig.sources >= 3 ? WEIGHTS.sources : sig.sources === 2 ? 2 : 0;
  if (srcBonus) {
    score += srcBonus;
    reasons.push({ label: "소스 신뢰도", points: srcBonus, detail: `${sig.sources}개 소스에서 확인됨` });
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    excluded: false,
    excludeReason: null,
    reasons,
    metrics,
    conflict,
  };
}
