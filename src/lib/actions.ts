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
import { analyzeCsv, commitBatch, SOURCES, type SourceKey } from "./importer";

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

export async function uploadCsv(formData: FormData) {
  const source = String(formData.get("source") ?? "pangpang") as SourceKey;
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) redirect("/import?step=1&err=nofile");
  if (!SOURCES[source]) redirect("/import?step=1&err=badsource");

  const text = await (file as File).text();
  const batchId = await analyzeCsv(text, source, (file as File).name, JAY);
  if (!batchId) redirect("/import?step=1&err=empty");

  revalidatePath("/import");
  redirect(`/import?step=3&batch=${batchId}`);
}

export async function decideMerge(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!id || !["merge", "split"].includes(decision)) return;
  await run(`UPDATE merge_candidate SET decision=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [id, decision, JAY]);
  revalidatePath("/import");
}

export async function commitImport(formData: FormData) {
  const batchId = String(formData.get("batchId") ?? "");
  if (!batchId) return;

  // 커밋 시각을 기준으로 잡아야 이번 배치가 만든 것만 델타로 잡힌다.
  const since = new Date();
  const res = await commitBatch(batchId, JAY);
  // 델타를 뽑고 그대로 아웃리치 동작으로 연결한다 (브랜드 충돌 → 타깃 자동 제외).
  const delta = await detectChanges({ batchId, since });
  revalidatePath("/import");
  revalidatePath("/influencers");
  revalidatePath("/watch");
  redirect(
    `/import?step=4&batch=${batchId}&created=${res.created}&merged=${res.merged}` +
    `&skipped=${res.skipped}&events=${delta.events.length}&excluded=${delta.autoExcluded}`,
  );
}
