import { all, one, run, tx } from "../db";
import * as notify from "./notify";

/**
 * 서킷브레이커 — 계정 안전을 사람의 주의력이 아니라 제품 기능으로 만든다.
 *
 * 계정 하나를 잃는 비용이 발송 30건의 가치보다 크다. 그래서 IG 계정은 24시간 정지한다.
 */

export const WINDOW_DAYS = 7;

export interface BreakerTick {
  values: Record<string, number>;
  fired: { metric: string; value: number; action: string }[];
}

/** 최근 7일 발송 지표를 다시 계산하고 임계를 넘으면 조치를 실행한다. */
export async function tick(): Promise<BreakerTick> {
  const stats = await one<{ sent: string; delivered: string; complaints: string; bounces: string }>(
    `SELECT
        -- dry-run 은 실제 발송이 아니다. 분모에 넣으면 스팸률·바운스율이 희석돼
        -- 브레이커가 늦게 걸린다 — 계정을 지키라고 만든 장치가 반대로 는다.
        count(*) FILTER (WHERE m.direction='out' AND m.channel='email' AND m.status <> 'dry_run') AS sent,
        count(*) FILTER (WHERE e.type='delivered' AND m.status <> 'dry_run')  AS delivered,
        count(*) FILTER (WHERE e.type='complaint' AND m.status <> 'dry_run')  AS complaints,
        count(*) FILTER (WHERE e.type IN ('bounce_hard','bounce_soft')
                           AND m.status <> 'dry_run')                         AS bounces
       FROM message m LEFT JOIN message_event e ON e.message_id = m.id
      WHERE m.sent_at >= now() - ($1 || ' days')::interval`,
    [String(WINDOW_DAYS)],
  );

  const sent = Number(stats?.sent ?? 0);
  // delivered 이벤트가 없으면 발송분이 다 도달했다고 본다 (dry-run 환경)
  const delivered = Number(stats?.delivered ?? 0) || sent;
  const values: Record<string, number> = {
    spam_rate: delivered ? Number(stats!.complaints) / delivered : 0,
    bounce_rate: sent ? Number(stats!.bounces) / sent : 0,
    inbox_rate: sent ? delivered / sent : 1,
  };

  const breakers = await all<{ id: number; metric: string; warn_at: string | null; halt_at: string | null; action: string; is_tripped: boolean }>(
    `SELECT id, metric, warn_at, halt_at, action, is_tripped FROM circuit_breaker`,
  );
  const fired: BreakerTick["fired"] = [];

  for (const b of breakers) {
    if (!(b.metric in values)) continue;
    const v = values[b.metric];
    const halt = Number(b.halt_at);
    const warn = Number(b.warn_at);
    // 도달률만 방향이 반대다 — 낮을수록 나쁘다
    const isBad = b.metric === "inbox_rate" ? v < halt : v > halt;
    const isWarn = b.metric === "inbox_rate" ? v < warn : v > warn;

    await run(`UPDATE circuit_breaker SET current_value=$2 WHERE id=$1`, [b.id, v]);

    if (isBad && !b.is_tripped) {
      await run(`UPDATE circuit_breaker SET is_tripped=true, tripped_at=now() WHERE id=$1`, [b.id]);
      await applyAction(b.action);
      await notify.breakerTripped(b.metric, v.toFixed(4), b.action);
      fired.push({ metric: b.metric, value: v, action: b.action });
    } else if (!isWarn && b.is_tripped) {
      // 경보선 아래로 회복하면 스스로 내려간다
      await run(`UPDATE circuit_breaker SET is_tripped=false, tripped_at=NULL WHERE id=$1`, [b.id]);
    }
  }
  return { values, fired };
}

export async function applyAction(action: string): Promise<void> {
  switch (action) {
    case "halt_all_sending":
      await run(`UPDATE sender SET paused_until = now() + interval '24 hours',
                        pause_reason = '서킷브레이커 · 전면 중단' WHERE channel='email'`);
      break;
    case "reduce_volume_50":
      await run(`UPDATE sender SET current_cap = GREATEST(5, current_cap / 2),
                        pause_reason = '서킷브레이커 · 볼륨 50% 감축' WHERE channel='email'`);
      break;
    case "pause_sending":
      await run(`UPDATE sender SET paused_until = now() + interval '6 hours',
                        pause_reason = '서킷브레이커 · 인박스 도달률 저하' WHERE channel='email'`);
      break;
    default:
      break;
  }
}

/**
 * 담당자가 액션 블록을 신고하면 즉시 24시간 정지하고 잔여 작업을 다른 계정으로 재배정한다.
 * 재배정할 계정이 없으면 sender_id 를 비워 큐에 남긴다 — 작업을 잃지 않는다.
 */
export async function reportActionBlock(
  senderId: string,
  reason = "액션 블록 신고",
): Promise<{ paused: string; reassigned: number }> {
  const sender = await one<{ id: string; identifier: string; channel: string }>(
    `SELECT id, identifier, channel FROM sender WHERE id=$1`, [senderId],
  );
  if (!sender) throw new Error("발신 계정을 찾을 수 없습니다");

  const reassigned = await tx(async (c) => {
    await c.query(
      `UPDATE sender SET paused_until = now() + interval '24 hours', pause_reason=$2 WHERE id=$1`,
      [senderId, reason],
    );
    const alt = await c.query<{ id: string }>(
      `SELECT id FROM sender
        WHERE channel=$1 AND id <> $2 AND is_active
          AND (paused_until IS NULL OR paused_until < now())
        ORDER BY sent_today ASC LIMIT 1`,
      [sender.channel, senderId],
    );
    const r = await c.query(
      `UPDATE outreach_task SET sender_id=$2 WHERE sender_id=$1 AND state IN ('queued','claimed')`,
      [senderId, alt.rows[0]?.id ?? null],
    );
    await c.query(
      `UPDATE circuit_breaker SET current_value = COALESCE(current_value,0) + 1,
              is_tripped = true, tripped_at = now() WHERE metric='ig_action_block'`,
    );
    return r.rowCount ?? 0;
  });

  await notify.senderPaused(sender.identifier, reason);
  return { paused: sender.identifier, reassigned };
}

/** 워밍업 램프 — 하루 한 번. current_cap 을 ramp_step 씩 daily_cap 까지 올린다. */
export async function rampUp(): Promise<number> {
  return run(
    `UPDATE sender SET current_cap = LEAST(daily_cap, current_cap + ramp_step)
      WHERE warmup_on AND current_cap < daily_cap
        AND (paused_until IS NULL OR paused_until < now())`,
  );
}

/** 일일 카운터 리셋. */
export async function resetDaily(): Promise<number> {
  return run(`UPDATE sender SET sent_today=0, sent_date=CURRENT_DATE WHERE sent_date < CURRENT_DATE`);
}
