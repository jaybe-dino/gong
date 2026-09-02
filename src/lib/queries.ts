import { all, one } from "./db";
import { fitScore, relatedCategories, timing, type ScoreInput, type ScoreResult, type Timing } from "./score";
import type { ChannelPolicy, SuppressionRow } from "./policy-gate";

/**
 * 화면이 쓰는 조회 계층.
 *
 * 원칙 하나: 크리에이터마다 쿼리를 돌리지 않는다. 목록·세그먼트는 한 번의 조회로
 * 필요한 모든 필드를 끌어오고 점수는 메모리에서 계산한다. 1,742명을 1인당 쿼리로
 * 점수화하면 첫 렌더가 수 초 걸린다.
 */

export interface CreatorRow {
  creator_id: string;
  display_name: string;
  tier: string | null;
  is_curated: boolean;
  handle: string;
  profile_url: string;
  is_active: boolean;
  followers: number | null;
  following: number | null;
  posts_count: number | null;
  engagement_rate: string | number | null;
  credibility: string | number | null;
  deals_30d: number | null;
  deals_90d: number | null;
  avg_interval_days: string | number | null;
  days_since_last: number | null;
  category_share: Record<string, number>;
  captured_at: string | null;
  reach: "email" | "inpock" | "dm" | null;
  email_verified: boolean;
  suppressed: boolean;
  active_slots: number;
  conflict_days: number | null;
  conflict_brand: string | null;
  last_contact_at: string | null;
  stage_key: string | null;
  stage_label: string | null;
  engine_state: number | null;
  interest_status: number | null;
  member_id: string | null;
}

export interface ScoredCreator extends CreatorRow {
  fit: ScoreResult;
  timing: Timing;
}

const num = (v: string | number | null | undefined): number | null =>
  v == null ? null : typeof v === "number" ? v : Number(v);

/**
 * 목록·세그먼트용 통합 조회.
 *
 * 브랜드 충돌은 캠페인 카테고리(+ 인접)와 겹치는 브랜드를 최근 90일 안에 진행했는지를
 * LATERAL 로 크리에이터당 한 건만 뽑는다.
 */
export async function loadCreators(opts: {
  campaignId?: string | null;
  category?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
  countOnly?: boolean;
  /** 특정 크리에이터만. 점수 캐시 갱신 워커가 쓴다. */
  filterIds?: string[];
  /**
   * 정렬 축.
   *   fit       캐시된 적합도 순 (기본). 캐시가 없는 크리에이터는 뒤로 밀린다.
   *   followers 팔로워 순
   *   id        고정 순서 — 배치 처리용
   */
  order?: "fit" | "followers" | "deals" | "timing" | "id";
  /** 이메일·인포크로 닿을 수 있고 수신거부가 아닌 대상만. */
  reachable?: boolean;
  /** 이 캠페인에 이미 담긴 크리에이터는 제외. 타깃 추천용. */
  notInCampaign?: string | null;
  /** 캐시가 excluded 로 판정한 대상만 (또는 제외). */
  onlyExcluded?: boolean;
}): Promise<{ rows: ScoredCreator[]; total: number; campaign: CampaignRow | null; unscored: number }> {
  const campaign = opts.campaignId ? await getCampaign(opts.campaignId) : await defaultCampaign();
  const cats = campaign ? relatedCategories(campaign.category) : [""];

  // 필터 조건은 카운트 쿼리와 목록 쿼리가 공유한다. 파라미터 번호가 어긋나지 않도록
  // 필터용 값을 먼저 모으고, 목록 쿼리에서만 쓰는 값(카테고리 집합·캠페인 브랜드)을 뒤에 붙인다.
  const filters: string[] = ["c.merged_into IS NULL"];
  // 캠페인 id 를 맨 앞에 둔다. 카운트 쿼리와 목록 쿼리가 같은 조인(creator_fit)을
  // 써야 하는데, 뒤에 붙이면 카운트 쿼리에 그 파라미터가 없어서 필터가 깨진다
  // (실제로 '연락 가능만' 필터가 500 을 냈다).
  const filterParams: unknown[] = [campaign?.id ?? null];
  const pCamp = 1;
  if (opts.category) {
    filterParams.push(opts.category);
    filters.push(`v.category_share ? $${filterParams.length}`);
  }
  if (opts.search) {
    filterParams.push(`%${opts.search}%`);
    const i = filterParams.length;
    filters.push(`(sa.handle ILIKE $${i} OR c.display_name ILIKE $${i}
      OR EXISTS (SELECT 1 FROM deal d JOIN brand b ON b.id=d.brand_id
                  WHERE d.creator_id=c.id AND b.name ILIKE $${i}))`);
  }
  if (opts.reachable) {
    filters.push(`EXISTS (SELECT 1 FROM contact_point x
                           WHERE x.creator_id = c.id
                             AND x.channel IN ('email','inpock_offer','linktree_form')
                             AND x.consent_status <> 'opt_out')`);
    filters.push(`COALESCE(cf.excluded, false) = false`);
  }
  if (opts.notInCampaign) {
    filterParams.push(opts.notInCampaign);
    filters.push(`NOT EXISTS (SELECT 1 FROM campaign_member m
                               WHERE m.creator_id = c.id AND m.campaign_id = $${filterParams.length})`);
  }
  if (opts.onlyExcluded != null) {
    filters.push(`COALESCE(cf.excluded, false) = ${opts.onlyExcluded ? "true" : "false"}`);
  }
  if (opts.filterIds) {
    if (!opts.filterIds.length) return { rows: [], total: 0, campaign, unscored: 0 };
    filterParams.push(opts.filterIds);
    filters.push(`c.id = ANY($${filterParams.length}::uuid[])`);
  }

  // 조인은 WHERE 앞에 와야 한다. 두 쿼리가 같은 조인/조건을 쓰도록 조각으로 나눠 둔다.
  const joins = `
    FROM creator c
    JOIN social_account sa ON sa.creator_id = c.id
    LEFT JOIN LATERAL (
      SELECT * FROM account_snapshot s WHERE s.social_account_id = sa.id
      ORDER BY s.captured_at DESC LIMIT 1
    ) v ON true
    LEFT JOIN creator_fit cf ON cf.creator_id = c.id AND cf.campaign_id = $${pCamp}::uuid`;
  const whereSql = `WHERE ${filters.join(" AND ")}`;

  const total = Number(
    (await one<{ n: string }>(`SELECT count(*) AS n ${joins} ${whereSql}`, filterParams))?.n ?? 0,
  );

  // 점수 캐시가 아직 없는 크리에이터 수. 화면이 "계산 필요"를 알려야 한다 —
  // 조용히 뒤로 밀면 목록이 완전해 보이는데 실제로는 아니다.
  const unscored = campaign
    ? Number(
        (await one<{ n: string }>(
          `SELECT count(*) AS n FROM creator c
             LEFT JOIN creator_fit cf ON cf.creator_id = c.id AND cf.campaign_id = $1
            WHERE c.merged_into IS NULL AND cf.creator_id IS NULL`,
          [campaign.id],
        ))?.n ?? 0,
      )
    : 0;

  if (opts.countOnly) return { rows: [], total, campaign, unscored };

  const pCats = filterParams.length + 1;
  const pBrand = filterParams.length + 2;
  const params = [...filterParams, cats, campaign?.brand_id ?? null];

  const order = opts.order ?? "fit";
  const orderSql =
    order === "followers" ? "v.followers DESC NULLS LAST, c.id"
    : order === "deals" ? "v.deals_30d DESC NULLS LAST, c.id"
    : order === "timing" ? "abs(cf.timing_ratio - 1) ASC NULLS LAST, cf.score DESC NULLS LAST, c.id"
    : order === "id" ? "c.id"
    : "cf.excluded ASC NULLS FIRST, cf.score DESC NULLS LAST, v.followers DESC NULLS LAST, c.id";
  const pageOrderSql =
    order === "followers" ? "p.followers DESC NULLS LAST, p.creator_id"
    : order === "deals" ? "p.deals_30d DESC NULLS LAST, p.creator_id"
    : order === "timing" ? "abs(p.timing_ratio - 1) ASC NULLS LAST, p.cached_score DESC NULLS LAST, p.creator_id"
    : order === "id" ? "p.creator_id"
    : "p.cached_excluded ASC NULLS FIRST, p.cached_score DESC NULLS LAST, p.followers DESC NULLS LAST, p.creator_id";

  const limit = Math.max(1, Math.min(5000, opts.limit ?? 25));
  const offset = Math.max(0, opts.offset ?? 0);

  // 비싼 LATERAL 을 페이지 밖에서 돌리면 안 된다.
  //
  // 전에는 여섯 개 LATERAL 을 본 SELECT 에 달고 마지막에 LIMIT 을 걸었다.
  // ORDER BY 가 전 행을 요구하므로 LATERAL 이 2만 번씩 돌았다 — 수신거부
  // 조회 하나만 457ms 였고 화면 전체가 1.9초였다. 먼저 정렬·자르기를 끝내고
  // 그 25행에만 붙인다.
  const rows = await all<CreatorRow>(
    `WITH page AS (
       SELECT c.id AS creator_id, c.display_name, c.tier, c.is_curated,
              sa.id AS account_id, sa.handle, sa.profile_url, sa.is_active,
              v.followers, v.following, v.posts_count, v.engagement_rate, v.credibility,
              v.deals_30d, v.deals_90d, v.avg_interval_days, v.days_since_last,
              COALESCE(v.category_share, '{}'::jsonb) AS category_share,
              to_char(v.captured_at, 'YYYY-MM-DD HH24:MI') AS captured_at,
              cf.score AS cached_score, cf.excluded AS cached_excluded, cf.timing_ratio
         ${joins}
        ${whereSql}
        ORDER BY ${orderSql}
        LIMIT ${limit} OFFSET ${offset}
     )
     SELECT p.creator_id, p.display_name, p.tier, p.is_curated,
            p.handle, p.profile_url, p.is_active,
            p.followers, p.following, p.posts_count, p.engagement_rate, p.credibility,
            p.deals_30d, p.deals_90d, p.avg_interval_days, p.days_since_last,
            p.category_share, p.captured_at,
            cp.reach, COALESCE(cp.email_verified, false) AS email_verified,
            (COALESCE(sup.n, 0) > 0) AS suppressed,
            COALESCE(slots.n, 0)::int AS active_slots,
            conf.days_ago::int AS conflict_days, conf.brand_name AS conflict_brand,
            to_char(lc.last_contact_at, 'YYYY-MM-DD') AS last_contact_at,
            ps.key AS stage_key, ps.label AS stage_label,
            cm.engine_state, cm.interest_status, cm.id AS member_id
       FROM page p
       LEFT JOIN LATERAL (
         SELECT CASE WHEN bool_or(channel='email') THEN 'email'
                     WHEN bool_or(channel IN ('inpock_offer','linktree_form')) THEN 'inpock'
                     WHEN bool_or(channel='instagram_dm') THEN 'dm' END AS reach,
                bool_or(channel='email' AND verification='valid') AS email_verified
           FROM contact_point WHERE creator_id = p.creator_id
       ) cp ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS n FROM suppression s
          WHERE (s.identifier_type='creator_id' AND s.identifier_val = p.creator_id::text)
             OR (s.identifier_type='ig_handle'  AND s.identifier_val = p.handle)
             OR (s.identifier_type='email'      AND s.identifier_val IN (SELECT value_norm FROM contact_point WHERE creator_id=p.creator_id))
             OR (s.identifier_type='email_domain' AND EXISTS (
                   SELECT 1 FROM contact_point x WHERE x.creator_id=p.creator_id AND x.channel='email'
                     AND x.value_norm LIKE '%@' || s.identifier_val))
       ) sup ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS n FROM deal d
          WHERE d.creator_id = p.creator_id AND d.status='active' AND NOT d.is_always_on
            AND d.close_date >= CURRENT_DATE
       ) slots ON true
       LEFT JOIN LATERAL (
         SELECT (CURRENT_DATE - d.open_date) AS days_ago, b.name AS brand_name
           FROM deal d JOIN brand b ON b.id = d.brand_id
          WHERE d.creator_id = p.creator_id AND d.status='active' AND d.open_date IS NOT NULL
            AND d.open_date <= CURRENT_DATE AND d.open_date >= CURRENT_DATE - 90
            AND (b.category = ANY($${pCats}) OR b.id = $${pBrand})
          ORDER BY d.open_date DESC LIMIT 1
       ) conf ON true
       LEFT JOIN LATERAL (
         SELECT max(m.sent_at) AS last_contact_at FROM message m
           JOIN campaign_member x ON x.id = m.campaign_member_id
          WHERE x.creator_id = p.creator_id AND m.direction='out'
       ) lc ON true
       LEFT JOIN LATERAL (
         SELECT * FROM campaign_member m WHERE m.creator_id = p.creator_id
          ORDER BY (m.campaign_id = $${pBrand}) DESC, m.created_at DESC LIMIT 1
       ) cm ON true
       LEFT JOIN pipeline_stage ps ON ps.id = cm.stage_id
      ORDER BY ${pageOrderSql}`,
    params,
  );

  return { rows: rows.map((r) => score(r, campaign)), total, campaign, unscored };
}

export function score(r: CreatorRow, campaign: { category: string } | null): ScoredCreator {
  const input: ScoreInput = {
    deals30d: r.deals_30d,
    deals90d: r.deals_90d,
    daysSinceLast: r.days_since_last,
    avgIntervalDays: num(r.avg_interval_days),
    engagementRate: num(r.engagement_rate),
    credibility: num(r.credibility),
    categoryShare: r.category_share ?? {},
    reach: r.reach ?? "none",
    emailVerified: r.email_verified,
    suppressed: r.suppressed,
    brandConflictDays: r.conflict_days,
    brandConflictName: r.conflict_brand,
    activeSlots: r.active_slots,
  };
  return {
    ...r,
    fit: fitScore(input, { category: campaign?.category }),
    timing: timing({ avgIntervalDays: num(r.avg_interval_days), daysSinceLast: r.days_since_last }),
  };
}

export interface CampaignRow {
  id: string;
  name: string;
  brand_id: string | null;
  brand_name: string;
  category: string;
  commission_rate: string | number | null;
  sale_from: string | null;
  sale_to: string | null;
  status: string;
}

export async function defaultCampaign(): Promise<CampaignRow | null> {
  return (
    (await one<CampaignRow>(
      `SELECT id,name,brand_id,brand_name,category,commission_rate,
              to_char(sale_from,'YYYY-MM-DD') AS sale_from, to_char(sale_to,'YYYY-MM-DD') AS sale_to, status
         FROM campaign c
        WHERE status='running'
        ORDER BY (SELECT count(*) FROM campaign_member m WHERE m.campaign_id = c.id) DESC, sale_from
        LIMIT 1`,
    )) ?? null
  );
}

export async function getCampaign(id: string): Promise<CampaignRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return defaultCampaign();
  return (
    (await one<CampaignRow>(
      `SELECT id,name,brand_id,brand_name,category,commission_rate,
              to_char(sale_from,'YYYY-MM-DD') AS sale_from, to_char(sale_to,'YYYY-MM-DD') AS sale_to, status
         FROM campaign WHERE id=$1`,
      [id],
    )) ?? (await defaultCampaign())
  );
}

export async function listCampaigns() {
  return all<{
    id: string; name: string; brand_name: string; category: string;
    sale_from: string | null; sale_to: string | null;
    members: string; agreed: string; gmv: string;
  }>(
    `SELECT c.id, c.name, c.brand_name, c.category,
            to_char(c.sale_from,'YYYY-MM-DD') AS sale_from,
            to_char(c.sale_to,'YYYY-MM-DD') AS sale_to,
            count(m.id) AS members,
            count(*) FILTER (WHERE ps.key IN ('agreed','sampling','live','settling','complete')) AS agreed,
            COALESCE(sum(m.gmv),0) AS gmv
       FROM campaign c
       LEFT JOIN campaign_member m ON m.campaign_id = c.id
       LEFT JOIN pipeline_stage ps ON ps.id = m.stage_id
      GROUP BY c.id ORDER BY c.sale_from`,
  );
}

export async function channelPolicies(): Promise<ChannelPolicy[]> {
  return all<ChannelPolicy>(`SELECT * FROM channel_policy ORDER BY
    CASE channel WHEN 'email' THEN 0 WHEN 'instagram_dm' THEN 1 WHEN 'inpock_offer' THEN 2
                 WHEN 'linktree_form' THEN 3 WHEN 'kakao' THEN 4 ELSE 5 END`);
}

export async function suppressions(): Promise<SuppressionRow[]> {
  return all<SuppressionRow>(`SELECT identifier_type, identifier_val, channels, reason, expires_at FROM suppression`);
}

export async function breakers() {
  return all<{ metric: string; warn_at: string | null; halt_at: string | null; action: string; current_value: string | null; is_tripped: boolean }>(
    `SELECT metric, warn_at, halt_at, action, current_value, is_tripped FROM circuit_breaker ORDER BY id`,
  );
}

export async function senders(channel?: string) {
  return all<{
    id: string; channel: string; identifier: string; display_name: string | null;
    daily_cap: number; current_cap: number; sent_today: number; account_age_d: number | null;
    paused_until: string | null; pause_reason: string | null; is_active: boolean; warmup_on: boolean;
  }>(
    `SELECT id, channel, identifier, display_name, daily_cap, current_cap, sent_today,
            account_age_d, paused_until, pause_reason, is_active, warmup_on
       FROM sender ${channel ? "WHERE channel = $1" : ""} ORDER BY channel, identifier`,
    channel ? [channel] : [],
  );
}
