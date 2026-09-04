"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, one, run, tx } from "./db";
import { nextBusinessSlot } from "./policy-gate";
import { evaluateCandidate, loadCampaignInfo, loadGateInputs, loadSendCandidates } from "./outreach";
import { classifyReply } from "./jobs/inbound-sync";
import { reportActionBlock } from "./jobs/circuit-breaker";
import { detectChanges } from "./jobs/detect-changes";
import { tick as sequenceTick } from "./jobs/sequence-worker";
import { invalidateFitForBatch, refreshFit, type FitProgress } from "./jobs/refresh-fit";
import { gmail } from "./channels";
import { interestEffects, INTEREST, ENGINE } from "./states";
import { parseReturnDate } from "./parse";
import { batchProgress, beginStage, commitBatch, endStage, matchBatch, reopenDecided, stageRows, SOURCES, type SourceKey } from "./importer";

const JAY = "00000000-0000-0000-0000-0000000000aa";

async function audit(entity: string, entityId: string, action: string, reason?: string, after?: unknown) {
  await run(
    `INSERT INTO audit_log (actor_id, actor_kind, entity, entity_id, action, after, reason)
     VALUES ($1,'user',$2,$3,$4,$5,$6)`,
    [JAY, entity, entityId, action, after ? JSON.stringify(after) : null, reason ?? null],
  );
}

/** 작업 큐 한 건 완료. 발신 계정 사용량을 올리고 메시지 기록을 남긴다. */
export async function completeTask(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await tx(async (c) => {
    const t = (
      await c.query(
        `SELECT t.*, cm.creator_id FROM outreach_task t
           JOIN campaign_member cm ON cm.id = t.campaign_member_id
          WHERE t.id=$1 AND t.state IN ('queued','claimed') FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!t) return;

    await c.query(`UPDATE outreach_task SET state='sent', completed_at=now(), assigned_to=$2 WHERE id=$1`, [id, JAY]);
    if (t.sender_id) {
      await c.query(
        `UPDATE sender SET sent_today = CASE WHEN sent_date = CURRENT_DATE THEN sent_today + 1 ELSE 1 END,
                           sent_date = CURRENT_DATE
          WHERE id=$1 AND (paused_until IS NULL OR paused_until < now())`,
        [t.sender_id],
      );
    }
    await c.query(
      `INSERT INTO message (campaign_member_id, sender_id, channel, direction, from_name, body, sent_at, status)
       VALUES ($1,$2,$3,'out','담당자 수동 발송',$4, now(), 'sent')`,
      [t.campaign_member_id, t.sender_id, t.channel, t.rendered_body],
    );
    await c.query(
      `UPDATE campaign_member SET last_sent_at=now(),
              first_sent_at = COALESCE(first_sent_at, now())
        WHERE id=$1`,
      [t.campaign_member_id],
    );
  });

  await audit("outreach_task", id, "complete");
  revalidatePath("/queue");
  revalidatePath("/dashboard");
}

/** 액션 블록 신고 — 계정을 24시간 정지하고 배급된 잔여 작업을 다른 계정으로 재배정한다. */
export async function reportBlock(formData: FormData) {
  const senderId = String(formData.get("senderId") ?? "");
  if (!senderId) return;
  const r = await reportActionBlock(senderId, "액션 블록 신고");
  await audit("sender", senderId, "action_block", `재배정 ${r.reassigned}건`);
  revalidatePath("/queue");
  revalidatePath("/policy");
}

export async function classifyThread(formData: FormData) {
  const memberId = String(formData.get("memberId") ?? "");
  const interest = Number(formData.get("interest"));
  if (!memberId || Number.isNaN(interest)) return;

  // 분류의 부수효과는 워커와 화면이 같은 코드를 쓴다 (jobs/inbound-sync).
  await classifyReply(memberId, interest, JAY);

  revalidatePath("/inbox");
  revalidatePath("/dashboard");
  revalidatePath("/campaigns");
  revalidatePath("/policy");
}

/**
 * 스테이지 이동.
 * 자동화는 절대 뒤로 옮기지 않는다. 사람이 옮길 때도 사유가 없으면 거부한다.
 */
export async function moveStage(formData: FormData) {
  const memberId = String(formData.get("memberId") ?? "");
  const stage = String(formData.get("stage") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!memberId || !stage) return;

  const cur = await one<{ sort_order: number; key: string }>(
    `SELECT ps.sort_order, ps.key FROM campaign_member m JOIN pipeline_stage ps ON ps.id=m.stage_id WHERE m.id=$1`,
    [memberId],
  );
  const next = await one<{ id: number; sort_order: number }>(`SELECT id, sort_order FROM pipeline_stage WHERE key=$1`, [stage]);
  if (!cur || !next) return;

  if (next.sort_order < cur.sort_order && !reason) {
    redirect(`/campaigns?err=reason_required`);
  }

  await run(`UPDATE campaign_member SET stage_id=$2 WHERE id=$1`, [memberId, next.id]);
  await audit("campaign_member", memberId, "stage_change", reason || `${cur.key} → ${stage}`);
  revalidatePath("/campaigns");
}

/** 추천 타깃을 캠페인에 담는다. */
export async function addTarget(formData: FormData) {
  const campaignId = String(formData.get("campaignId") ?? "");
  const creatorId = String(formData.get("creatorId") ?? "");
  if (!campaignId || !creatorId) return;
  await run(
    `INSERT INTO campaign_member (campaign_id, creator_id, stage_id, engine_state, reply_token, owner_user_id)
     VALUES ($1,$2,(SELECT id FROM pipeline_stage WHERE key='qualified'), $3,
             'cm_' || encode(gen_random_bytes(4),'hex'), $4)
     ON CONFLICT (campaign_id, creator_id) DO NOTHING`,
    [campaignId, creatorId, ENGINE.QUEUED, JAY],
  );
  revalidatePath("/campaigns");
}

export async function markEventsRead() {
  await run(`UPDATE change_event SET is_read = true WHERE NOT is_read`);
  revalidatePath("/watch");
}

/**
 * 발송 실행.
 *
 * 화면에서 통과했더라도 그 사이 수신거부가 등재됐을 수 있으므로 대상마다 게이트를
 * 다시 통과시킨다. 막힌 건은 gate_block 에 사유를 남긴다.
 */
/**
 * 발송 시작.
 *
 * 예전에는 이 함수가 message 를 'sent' 로 직접 기록했다 — 채널 어댑터를 부르지
 * 않았으므로 메일은 한 통도 나가지 않는데 나갔다고 남았다. Gmail 을 연동해도
 * 마찬가지였다. 그러면 회신율 분모가 부풀고, 재접촉 쿨다운이 걸려 진짜 발송 때
 * 그 사람을 건너뛴다.
 *
 * 발송 경로를 두 개 두면 한쪽만 고치게 된다. 대상을 지금 만기로 만들고
 * 시퀀스 워커를 한 틱 돌린다 — 렌더링·게이트·어댑터 호출·기록이 전부
 * 검증된 한 경로로 지나간다.
 */
export async function startSend(formData: FormData) {
  const campaignId = String(formData.get("campaignId") ?? "");
  if (!campaignId) return;

  // 아직 컨택하지 않은 살아 있는 대상을 지금 만기로 만든다.
  await run(
    `UPDATE campaign_member SET next_action_at = now() - interval '1 minute'
      WHERE campaign_id=$1 AND engine_state > 0
        AND (next_action_at IS NULL OR next_action_at > now())`,
    [campaignId],
  );

  const before = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM outreach_task WHERE state='queued'`);
  const stats = await sequenceTick({ limit: 500 });
  const after = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM outreach_task WHERE state='queued'`);
  const tasks = Math.max(0, (after?.n ?? 0) - (before?.n ?? 0));

  await audit("campaign", campaignId, "send",
    `sent=${stats.sent} tasks=${tasks} blocked=${stats.blocked} failed=${stats.failed}`);
  revalidatePath("/dashboard");
  revalidatePath("/queue");
  revalidatePath("/send");
  redirect(
    `/send?step=3&campaign=${campaignId}&sent=${stats.sent}&blocked=${stats.blocked}` +
    `&tasks=${tasks}&failed=${stats.failed}`,
  );
}

export async function beginUpload(source: string, filename: string, headerLine: string): Promise<string> {
  const src = source as SourceKey;
  if (!SOURCES[src]) throw new Error("알 수 없는 소스입니다");
  const id = await beginStage(src, filename, JAY, headerLine);
  if (!id) throw new Error("헤더를 읽을 수 없습니다");
  return id;
}

export async function uploadChunk(
  batchId: string,
  headerLine: string,
  records: string[],
  startLine: number,
): Promise<number> {
  return await stageRows(batchId, headerLine, records, startLine);
}

export async function endUpload(batchId: string): Promise<number> {
  const n = await endStage(batchId);
  revalidatePath("/import");
  return n;
}

export interface StepResult {
  done: boolean;
  processed: number;
  total: number;
  remaining: number;
  note?: string;
}

/** 2단계 한 청크. 화면이 done 이 될 때까지 반복 호출한다. */
export async function matchStep(batchId: string): Promise<StepResult> {
  const r = await matchBatch(batchId);
  const p = await batchProgress(batchId);
  const total = p?.total ?? 0;
  return { done: r.done, total, remaining: r.remaining, processed: total - r.remaining };
}

/** 3단계 한 청크. 결정이 끝난 검토 행을 먼저 대기로 되돌린다. */
export async function commitStep(batchId: string): Promise<StepResult> {
  await reopenDecided(batchId);
  const r = await commitBatch(batchId, JAY);
  const p = await batchProgress(batchId);
  const total = p?.total ?? 0;
  const left = (p?.pending ?? 0) + (p?.deferred ?? 0);
  return {
    done: r.done,
    total,
    remaining: r.remaining,
    processed: (p?.applied ?? 0) + (p?.skipped ?? 0),
    note: r.deferred > 0 ? `검토 대기 ${left}건은 결정 후 반영됩니다` : undefined,
  };
}

/**
 * 커밋이 끝난 뒤 델타를 뽑는다.
 *
 * 커밋을 여러 요청에 나눠 하므로 변화 감지는 마지막에 한 번만 돈다.
 * 매 청크마다 돌면 같은 이벤트가 중복 생성된다.
 */
export async function finalizeImport(batchId: string): Promise<{ events: number; excluded: number; restale: number }> {
  const b = await one<{ created_at: string }>(`SELECT created_at FROM import_batch WHERE id=$1`, [batchId]);
  const since = b ? new Date(b.created_at) : new Date(Date.now() - 3600_000);
  const delta = await detectChanges({ batchId, since });
  // 새 스냅샷·딜이 들어왔으니 그 크리에이터의 적합도는 더 이상 유효하지 않다.
  const restale = await invalidateFitForBatch(batchId);
  revalidatePath("/import");
  revalidatePath("/influencers");
  revalidatePath("/watch");
  return { events: delta.events.length, excluded: delta.autoExcluded, restale };
}

/** 적합도 점수 캐시 한 청크. 화면이 done 까지 반복 호출한다. */
export async function fitStep(campaignId: string): Promise<FitProgress> {
  const r = await refreshFit(campaignId);
  if (r.done) revalidatePath("/influencers");
  return r;
}

export async function decideMerge(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!id || !["merge", "split"].includes(decision)) return;
  await run(`UPDATE merge_candidate SET decision=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [id, decision, JAY]);
  revalidatePath("/import");
}

/** 커밋 시작 — 화면의 진행 컴포넌트가 commitStep 을 이어 돌린다. */
export async function beginCommit(formData: FormData) {
  const batchId = String(formData.get("batchId") ?? "");
  if (!batchId) return;
  await reopenDecided(batchId);
  revalidatePath("/import");
  redirect(`/import?step=3&batch=${batchId}&run=commit`);
}

