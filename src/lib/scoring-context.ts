import { all } from "./db";
import { diffDays, today } from "./clock";
import { occupiesSlot } from "./deals";
import type { CreatorMetrics } from "./metrics";

/**
 * 점수 계산에 필요한 데이터를 한 번에 읽어 메모리에 올린다.
 *
 * 크리에이터마다 개별 쿼리를 돌리면 1,742명 × 6쿼리 = 1만 쿼리가 되어 첫 렌더가 수 초 걸린다.
 * 테이블별로 한 번씩만 읽고 Map 으로 붙이면 같은 결과를 훨씬 싸게 얻는다.
 */
export interface ScoringContext {
  ref: string;
  shares: Map<number, { category: string; pct: number }[]>;
  deals: Map<number, { brandId: number; brand: string; category: string | null; starts_on: string }[]>;
  blocked: Set<number>;
  reach: Map<number, string>;
  curated: Set<number>;
  sourceCount: Map<number, number>;
  metrics: Map<number, CreatorMetrics>;
}

export function loadScoringContext(ref = today()): ScoringContext {
  const shares = new Map<number, { category: string; pct: number }[]>();
  for (const r of all<{ creator_id: number; category: string; pct: number }>(
    `SELECT creator_id, category, pct FROM category_share`,
  )) {
    (shares.get(r.creator_id) ?? shares.set(r.creator_id, []).get(r.creator_id)!).push({ category: r.category, pct: r.pct });
  }

  const deals = new Map<number, { brandId: number; brand: string; category: string | null; starts_on: string }[]>();
  for (const r of all<{ creator_id: number; brand_id: number; name: string; category: string | null; starts_on: string }>(
    `SELECT a.creator_id, b.id AS brand_id, b.name, b.category, d.starts_on
       FROM deal d
       JOIN social_account a ON a.id = d.account_id
       JOIN brand b ON b.id = d.brand_id
      WHERE d.starts_on IS NOT NULL AND d.gone_at IS NULL
      ORDER BY d.starts_on DESC`,
  )) {
    (deals.get(r.creator_id) ?? deals.set(r.creator_id, []).get(r.creator_id)!).push({
      brandId: r.brand_id,
      brand: r.name,
      category: r.category,
      starts_on: r.starts_on,
    });
  }

  // 수신거부 — 핸들, 이메일, 도메인 세 경로를 모두 본다.
  const blocked = new Set<number>();
  for (const r of all<{ creator_id: number }>(
    `SELECT DISTINCT a.creator_id
       FROM social_account a JOIN suppression s ON s.identifier = '@' || a.handle
      WHERE s.scope = 'all'
      UNION
     SELECT DISTINCT cp.creator_id
       FROM contact_point cp JOIN suppression s ON s.identifier = cp.value
      WHERE s.scope = 'all'
      UNION
     SELECT DISTINCT cp.creator_id
       FROM contact_point cp JOIN suppression s ON s.kind = 'domain'
        AND '@' || substr(cp.value, instr(cp.value, '@') + 1) = s.identifier
      WHERE cp.kind = 'email' AND s.scope = 'all'`,
  )) {
    blocked.add(r.creator_id);
  }

  const reach = new Map<number, string>();
  for (const r of all<{ creator_id: number; kind: string }>(
    `SELECT creator_id, kind FROM contact_point
      ORDER BY CASE kind WHEN 'email' THEN 0 WHEN 'inpock' THEN 1 WHEN 'linktree' THEN 2 ELSE 3 END DESC`,
  )) {
    reach.set(r.creator_id, r.kind); // 마지막에 남는 것이 우선순위가 가장 높은 경로
  }

  const curated = new Set<number>(all<{ id: number }>(`SELECT id FROM creator WHERE curated = 1`).map((r) => r.id));

  const sourceCount = new Map<number, number>();
  for (const r of all<{ entity_id: number; n: number }>(
    `SELECT entity_id, COUNT(DISTINCT source) AS n FROM source_ref WHERE entity_type='creator' GROUP BY entity_id`,
  )) {
    sourceCount.set(r.entity_id, r.n);
  }

  // 슬롯(진행중·예정)은 우리 관측값, 케이던스는 임포트 값이 기준이다.
  const slots = new Map<number, number>();
  for (const r of all<{ creator_id: number; starts_on: string | null; ends_on: string | null; is_always_on: number }>(
    `SELECT a.creator_id, d.starts_on, d.ends_on, d.is_always_on
       FROM deal d JOIN social_account a ON a.id = d.account_id
      WHERE d.gone_at IS NULL`,
  )) {
    if (occupiesSlot(r, ref)) slots.set(r.creator_id, (slots.get(r.creator_id) ?? 0) + 1);
  }

  const metrics = new Map<number, CreatorMetrics>();
  for (const r of all<{
    creator_id: number; deals_30d: number | null; deals_90d: number | null;
    avg_cadence_days: number | null; last_deal_on: string | null;
  }>(`SELECT creator_id, deals_30d, deals_90d, avg_cadence_days, last_deal_on FROM creator_metric`)) {
    metrics.set(r.creator_id, {
      deals30: r.deals_30d ?? 0,
      deals90: r.deals_90d ?? 0,
      cadence: r.avg_cadence_days,
      lastDealDays: r.last_deal_on ? diffDays(ref, r.last_deal_on) : null,
      slots: slots.get(r.creator_id) ?? 0,
      basis: r.avg_cadence_days != null ? "imported" : "none",
    });
  }
  // 지표 행이 없는 크리에이터도 슬롯은 채워 둔다.
  for (const [creatorId, n] of slots) {
    if (!metrics.has(creatorId)) {
      metrics.set(creatorId, { deals30: 0, deals90: 0, cadence: null, lastDealDays: null, slots: n, basis: "none" });
    }
  }

  return { ref, shares, deals, blocked, reach, curated, sourceCount, metrics };
}
