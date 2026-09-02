import { all, one, run } from "../db";
import { loadCreators } from "../queries";

/**
 * 적합도 점수 캐시 갱신.
 *
 * 점수는 src/lib/score.ts 한 곳에서만 계산한다. SQL 로 옮겨 적으면 진실이 두 곳에
 * 생기고, 배점을 고칠 때 한쪽만 고치게 된다. 그래서 계산은 JS 로 하고 결과만 담는다.
 *
 * 점수는 캠페인마다 다르다 — 카테고리 인접성과 브랜드 충돌이 캠페인 기준이다.
 * 그래서 (campaign_id, creator_id) 로 캐시한다.
 *
 * 한 번에 limit 명씩 처리하고 남은 수를 돌려준다. 2만 명을 한 요청에 다 돌릴 수 없다.
 */
export const FIT_CHUNK = 2000;

export interface FitProgress {
  scored: number;
  remaining: number;
  done: boolean;
}

/** 캐시가 없거나 stale 인 크리에이터를 찾아 점수를 채운다. */
export async function refreshFit(
  campaignId: string,
  opts: { limit?: number; staleBefore?: Date } = {},
): Promise<FitProgress> {
  const limit = opts.limit ?? FIT_CHUNK;
  const stale = opts.staleBefore ?? null;

  const todo = await all<{ id: string }>(
    `SELECT c.id FROM creator c
       LEFT JOIN creator_fit cf ON cf.creator_id = c.id AND cf.campaign_id = $1
      WHERE c.merged_into IS NULL
        AND (cf.creator_id IS NULL OR ($2::timestamptz IS NOT NULL AND cf.computed_at < $2))
      ORDER BY c.id
      LIMIT $3`,
    [campaignId, stale, limit],
  );

  if (todo.length) {
    const { rows } = await loadCreators({
      campaignId,
      filterIds: todo.map((t) => t.id),
      limit: todo.length,
      order: "id",
    });
    await upsert(campaignId, rows);
  }

  const remaining = (await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM creator c
       LEFT JOIN creator_fit cf ON cf.creator_id = c.id AND cf.campaign_id = $1
      WHERE c.merged_into IS NULL
        AND (cf.creator_id IS NULL OR ($2::timestamptz IS NOT NULL AND cf.computed_at < $2))`,
    [campaignId, stale],
  ))!.n;

  return { scored: todo.length, remaining, done: remaining === 0 };
}

type Scored = Awaited<ReturnType<typeof loadCreators>>["rows"][number];

/** 다중 행 UPSERT. 행마다 왕복하면 2만 번이다. */
async function upsert(campaignId: string, rows: Scored[]) {
  if (!rows.length) return;
  const per = 8;
  const chunk = Math.max(1, Math.floor(60000 / per));
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const values: string[] = [];
    const params: unknown[] = [];
    slice.forEach((r, ri) => {
      const b = ri * per;
      values.push(
        `($${b + 1}::uuid,$${b + 2}::uuid,$${b + 3}::smallint,$${b + 4}::boolean,` +
          `$${b + 5}::text,$${b + 6}::text,$${b + 7}::jsonb,$${b + 8}::numeric)`,
      );
      params.push(
        campaignId, r.creator_id, Math.round(r.fit.score), r.fit.excluded,
        r.fit.reason ?? null, r.timing.label, JSON.stringify(r.fit.breakdown),
        r.timing.ratio,
      );
    });
    await run(
      `INSERT INTO creator_fit (campaign_id, creator_id, score, excluded, reason, timing, breakdown, timing_ratio)
       VALUES ${values.join(",")}
       ON CONFLICT (campaign_id, creator_id) DO UPDATE SET
         score = EXCLUDED.score, excluded = EXCLUDED.excluded, reason = EXCLUDED.reason,
         timing = EXCLUDED.timing, breakdown = EXCLUDED.breakdown,
         timing_ratio = EXCLUDED.timing_ratio, computed_at = now()`,
      params,
    );
  }
}

/**
 * 데이터가 바뀐 크리에이터의 캐시를 버린다.
 *
 * 임포트가 스냅샷을 쌓거나 딜을 넣으면 점수가 달라진다. 지우면 갱신 워커가
 * 다음 차례에 다시 계산한다 — 화면은 "계산 필요 N명" 으로 이 상태를 드러낸다.
 */
export async function invalidateFit(creatorIds: string[]): Promise<number> {
  if (!creatorIds.length) return 0;
  const r = await one<{ n: number }>(
    `WITH d AS (DELETE FROM creator_fit WHERE creator_id = ANY($1::uuid[]) RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
    [creatorIds],
  );
  return r?.n ?? 0;
}

/** 배치가 건드린 크리에이터의 캐시를 버린다. */
export async function invalidateFitForBatch(batchId: string): Promise<number> {
  const r = await one<{ n: number }>(
    `WITH touched AS (
       SELECT DISTINCT r.applied_creator_id AS creator_id
         FROM import_row r
        WHERE r.batch_id = $1 AND r.state = 'applied' AND r.applied_creator_id IS NOT NULL
     ), d AS (
       DELETE FROM creator_fit cf WHERE cf.creator_id IN (SELECT creator_id FROM touched) RETURNING 1
     )
     SELECT count(*)::int AS n FROM d`,
    [batchId],
  );
  return r?.n ?? 0;
}
