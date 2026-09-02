"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, one, run, tx } from "./db";
import { nextBusinessSlot } from "./policy-gate";
import { evaluateCandidate, loadCampaignInfo, loadGateInputs, loadSendCandidates } from "./outreach";
import { classifyReply } from "./jobs/inbound-sync";
import { reportActionBlock } from "./jobs/circuit-breaker";
import { detectChanges } from "./jobs/detect-changes";
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
export async function startSend(formData: FormData) {
  const campaignId = String(formData.get("campaignId") ?? "");
  if (!campaignId) return;

  const campaign = await loadCampaignInfo(campaignId);
  if (!campaign) return;

  const inputs = await loadGateInputs();
  const candidates = await loadSendCandidates(campaignId);
  const sender = inputs.sender;
  const now = new Date();

  let queued = 0;
  let blocked = 0;
  let tasks = 0;

  for (const cand of candidates) {
    // 회신을 되돌릴 열쇠. 없으면 지금 만든다 — 수신거부 URL 도 이 토큰을 쓴다.
    if (!cand.reply_token) {
      cand.reply_token = gmail.newReplyToken();
      await run(`UPDATE campaign_member SET reply_token=$2 WHERE id=$1`, [cand.member_id, cand.reply_token]);
    }
    const ev = evaluateCandidate(cand, campaign, inputs, now);

    if (!ev.gate.ok) {
      blocked++;
      await run(`INSERT INTO gate_block (campaign_member_id, channel, failed_check, detail) VALUES ($1,$2,$3,$4)`,
        [cand.member_id, ev.channel, ev.gate.blocked!.check, ev.gate.blocked!.detail]);
      continue;
    }

    // 콜드 자동 발송이 불가한 채널은 작업 큐로만 나간다.
    if (ev.policy.automation_mode === "manual_task") {
      await run(
        `INSERT INTO outreach_task (campaign_member_id, channel, sender_id, rendered_subject, rendered_body, target_url, state, due_at)
         VALUES ($1,$2,NULL,$3,$4,$5,'queued',$6)`,
        [cand.member_id, ev.channel, ev.rendered!.subject, ev.rendered!.body,
         `https://www.instagram.com/${cand.handle}`, nextBusinessSlot(now).toISOString()],
      );
      tasks++;
      continue;
    }

    await tx(async (c) => {
      await c.query(
        `INSERT INTO message (campaign_member_id, sender_id, channel, direction, from_name, subject, body, status)
         VALUES ($1,$2,'email','out',$3,$4,$5,'sent')`,
        [cand.member_id, sender?.id ?? null, sender?.display_name ?? "Dinostudio", ev.rendered!.subject, ev.rendered!.body],
      );
      await c.query(
        `UPDATE campaign_member SET engine_state=$2::smallint, current_step = current_step + 1,
                first_sent_at = COALESCE(first_sent_at, now()), last_sent_at = now(),
                stage_id = GREATEST(stage_id, (SELECT id FROM pipeline_stage WHERE key='contacted'))
          WHERE id=$1 AND engine_state > 0`,
        [cand.member_id, ENGINE.IN_SEQUENCE],
      );
      if (sender) {
        await c.query(
          `UPDATE sender SET sent_today = CASE WHEN sent_date=CURRENT_DATE THEN sent_today+1 ELSE 1 END,
                             sent_date=CURRENT_DATE WHERE id=$1`,
          [sender.id],
        );
      }
    });
    queued++;
    if (sender) sender.sent_today++;
  }

  await audit("campaign", campaignId, "send", `queued=${queued} blocked=${blocked} tasks=${tasks}`);
  revalidatePath("/dashboard");
  revalidatePath("/queue");
  revalidatePath("/campaigns");
  revalidatePath("/policy");
  redirect(`/send?step=3&campaign=${campaignId}&sent=${queued}&blocked=${blocked}&tasks=${tasks}`);
}

// ---------- 임포트 ----------

/**
 * 업로드는 청크로 받는다.
 *
 * 예전에는 File 을 서버 액션 하나로 넘겼다. Next 의 기본 본문 한도가 1 MB 라
 * 1.9만 행(2.8 MB) 파일이 413 으로 튕겼고, 화면에는 원인이 안 보이는
 * "Server Components render" 오류만 떴다. Vercel 은 요청 본문을 4.5 MB 로
 * 막으니 한도를 올리는 것만으로는 곧 또 막힌다.
 */
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
export async function finalizeImport(batchId: string): Promise<{ events: number; excluded: number }> {
  const b = await one<{ created_at: string }>(`SELECT created_at FROM import_batch WHERE id=$1`, [batchId]);
  const since = b ? new Date(b.created_at) : new Date(Date.now() - 3600_000);
  const delta = await detectChanges({ batchId, since });
  revalidatePath("/import");
  revalidatePath("/influencers");
  revalidatePath("/watch");
  return { events: delta.events.length, excluded: delta.autoExcluded };
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

