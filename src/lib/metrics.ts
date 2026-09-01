import { all, one } from "./db";
import { diffDays, today } from "./clock";
import { occupiesSlot } from "./deals";

export interface CreatorMetrics {
  deals30: number;
  deals90: number;
  /** 평균 공구 간격(일). 이력이 부족하면 null. */
  cadence: number | null;
  /** 마지막 공구 종료 후 경과일. 이력이 없으면 null. */
  lastDealDays: number | null;
  /** 진행중 + 예정 공구 수. 슬롯 여유 판정에 쓴다. */
  slots: number;
  /** 지표 출처: imported(인공) | observed(우리 deal 테이블) | none */
  basis: "imported" | "observed" | "none";
}

interface DealRow {
  starts_on: string | null;
  ends_on: string | null;
  is_always_on: number;
}

/**
 * 우리 deal 테이블에서 직접 관측한 케이던스.
 * 상시 공구는 간격 계산에서 제외한다 — 시작일 하나로 주기를 만들 수 없다.
 */
export function observedMetrics(creatorId: number, ref = today()): CreatorMetrics {
  const rows = all<DealRow>(
    `SELECT d.starts_on, d.ends_on, d.is_always_on
       FROM deal d
       JOIN social_account a ON a.id = d.account_id
      WHERE a.creator_id = ? AND d.gone_at IS NULL
      ORDER BY d.starts_on`,
    [creatorId],
  );

  const dated = rows.filter((r) => !r.is_always_on && r.starts_on);
  const deals30 = dated.filter((r) => diffDays(ref, r.starts_on!) >= 0 && diffDays(ref, r.starts_on!) <= 30).length;
  const deals90 = dated.filter((r) => diffDays(ref, r.starts_on!) >= 0 && diffDays(ref, r.starts_on!) <= 90).length;

  let cadence: number | null = null;
  if (dated.length >= 3) {
    const gaps: number[] = [];
    for (let i = 1; i < dated.length; i++) gaps.push(diffDays(dated[i].starts_on!, dated[i - 1].starts_on!));
    const positive = gaps.filter((g) => g > 0);
    if (positive.length) cadence = positive.reduce((a, b) => a + b, 0) / positive.length;
  }

  const ended = dated.filter((r) => r.ends_on && r.ends_on < ref).map((r) => r.ends_on!);
  const lastDealDays = ended.length ? diffDays(ref, ended.sort().at(-1)!) : null;

  const slots = rows.filter((r) => occupiesSlot(r, ref)).length;

  return { deals30, deals90, cadence, lastDealDays, slots, basis: cadence != null ? "observed" : "none" };
}

/**
 * 실제 사용하는 지표.
 *
 * 인공에서 임포트한 값이 있으면 그것을 기준으로 삼는다 — 우리 deal 테이블은 임포트한
 * 스냅샷만 담고 있어 이력이 짧고, 인공은 그 크리에이터의 전체 공구 이력에서 계산한 값이다.
 * 임포트 값이 없을 때만 우리가 관측한 값으로 대체한다. 슬롯은 항상 우리 관측값을 쓴다
 * (지금 열려 있는 공구가 몇 건인가는 우리 스냅샷이 최신이다).
 */
export function creatorMetrics(creatorId: number, ref = today()): CreatorMetrics {
  const obs = observedMetrics(creatorId, ref);
  const imported = one<{
    deals_30d: number | null;
    deals_90d: number | null;
    avg_cadence_days: number | null;
    last_deal_on: string | null;
  }>(`SELECT deals_30d, deals_90d, avg_cadence_days, last_deal_on FROM creator_metric WHERE creator_id = ?`, [
    creatorId,
  ]);

  if (!imported || imported.avg_cadence_days == null) return obs;

  return {
    deals30: imported.deals_30d ?? obs.deals30,
    deals90: imported.deals_90d ?? obs.deals90,
    cadence: imported.avg_cadence_days,
    lastDealDays: imported.last_deal_on ? diffDays(ref, imported.last_deal_on) : obs.lastDealDays,
    slots: obs.slots,
    basis: "imported",
  };
}

/**
 * 타이밍 비율 = 마지막 공구 경과일 / 평균 간격.
 * 1.0 근처가 "다음 공구를 열 시점"이다.
 */
export function timingRatio(m: CreatorMetrics): number | null {
  if (m.cadence == null || m.lastDealDays == null || m.cadence <= 0) return null;
  return m.lastDealDays / m.cadence;
}

export function isRipe(m: CreatorMetrics): boolean {
  const r = timingRatio(m);
  return r != null && r >= 0.8 && r <= 2.2;
}
