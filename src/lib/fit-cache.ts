import { all, db, one, run } from "./db";
import { today } from "./clock";
import { scoreCreator, type CampaignLike } from "./scoring";
import { loadScoringContext } from "./scoring-context";

/**
 * 캠페인별 적합도 캐시.
 *
 * 정렬·필터가 전체 모집단을 훑어야 해서, 점수를 한 번 계산해 테이블에 물질화한다.
 * 계산 기준일이 오늘이 아니면 다시 계산한다 — 타이밍 점수가 날짜에 의존하기 때문이다.
 */
export function ensureFitCache(campaign: CampaignLike, ref = today()): void {
  const fresh = one<{ n: number }>(`SELECT COUNT(*) AS n FROM fit_cache WHERE campaign_id = ? AND computed_at = ?`, [
    campaign.id,
    ref,
  ])!.n;
  const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM creator`)!.n;
  if (fresh === total && total > 0) return;

  const ctx = loadScoringContext(ref);
  const ids = all<{ id: number }>(`SELECT id FROM creator`).map((r) => r.id);
  const stmt = db().prepare(
    `INSERT INTO fit_cache (campaign_id, creator_id, score, excluded, exclude_reason, reasons, computed_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(campaign_id, creator_id) DO UPDATE SET
       score=excluded.score, excluded=excluded.excluded, exclude_reason=excluded.exclude_reason,
       reasons=excluded.reasons, computed_at=excluded.computed_at`,
  );
  const tx = db().transaction(() => {
    for (const id of ids) {
      const f = scoreCreator(id, campaign, ref, ctx);
      stmt.run(campaign.id, id, f.score, f.excluded ? 1 : 0, f.excludeReason, JSON.stringify(f.reasons), ref);
    }
  });
  tx();
}

/** 딜·수신거부·연락처가 바뀌면 캐시를 버린다. */
export function invalidateFitCache(campaignId?: number) {
  if (campaignId) run(`DELETE FROM fit_cache WHERE campaign_id = ?`, [campaignId]);
  else run(`DELETE FROM fit_cache`);
}

/** 화면이 기준으로 삼는 캠페인. ?campaign= 로 바꿀 수 있다. */
export function defaultCampaign(id?: number): CampaignLike & { name: string } {
  const row = id
    ? one<CampaignLike & { name: string }>(`SELECT id, name, category, brand_id FROM campaign WHERE id = ?`, [id])
    : undefined;
  return (
    row ??
    one<CampaignLike & { name: string }>(
      `SELECT id, name, category, brand_id FROM campaign WHERE status='active' ORDER BY id LIMIT 1`,
    )!
  );
}
