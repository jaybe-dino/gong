"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, db, one, run } from "./db";
import { today } from "./clock";
import { invalidateFitCache } from "./fit-cache";
import { analyze, applyBatch, saveBatch, SOURCES, type SourceKey } from "./importer";
import { buildSegment, DEFAULT_SEGMENT, runGate } from "./policy";

function nowStamp() {
  return new Date().toISOString().slice(0, 16).replace("T", " ");
}

/** 작업 큐 한 건 완료. 발신 계정 사용량을 올리고 발송 기록을 남긴다. */
export async function completeTask(formData: FormData) {
  const id = Number(formData.get("id"));
  const task = one<{ id: number; kind: string; creator_id: number; campaign_id: number | null; sender_id: number | null; status: string }>(
    `SELECT id, kind, creator_id, campaign_id, sender_id, status FROM task WHERE id = ?`,
    [id],
  );
  if (!task || task.status !== "pending") return;

  db().transaction(() => {
    run(`UPDATE task SET status='done', done_at=? WHERE id=?`, [nowStamp(), id]);
    if (task.sender_id) {
      run(`UPDATE sender_account SET sent_today = sent_today + 1 WHERE id = ? AND status != 'suspended'`, [task.sender_id]);
    }
    if (task.kind !== "reply_check") {
      run(`INSERT INTO outreach_log (creator_id, campaign_id, channel, sent_at, result) VALUES (?,?,?,?, 'sent')`, [
        task.creator_id,
        task.campaign_id,
        task.kind === "ig_dm" ? "ig_dm" : "inpock",
      nowStamp()]);
    }
  })();

  revalidatePath("/queue");
  revalidatePath("/dashboard");
}

/** 액션 블록 신고 — 계정을 24시간 정지시키고 배급된 잔여 작업을 회수한다. */
export async function reportBlock(formData: FormData) {
  const senderId = Number(formData.get("senderId"));
  db().transaction(() => {
    run(`UPDATE sender_account SET status='suspended', paused_until=? WHERE id=?`, [`${today()} 23:59`, senderId]);
    run(`UPDATE task SET sender_id = NULL WHERE sender_id = ? AND status='pending'`, [senderId]);
    run(`UPDATE circuit_metric SET value = value + 1 WHERE key='block'`);
  })();
  revalidatePath("/queue");
  revalidatePath("/policy");
}

const REQUEUE_DAYS = 180;

/**
 * 회신 분류.
 * -4(연락 금지)는 수신거부 목록에 즉시 등록한다. 이건 되돌릴 수 없다.
 */
export async function classifyThread(formData: FormData) {
  const threadId = Number(formData.get("threadId"));
  const value = String(formData.get("classification") ?? "");
  if (!value) return;

  const t = one<{ creator_id: number; campaign_id: number | null }>(
    `SELECT creator_id, campaign_id FROM thread WHERE id = ?`,
    [threadId],
  );
  if (!t) return;

  const code = value.split(" ")[0];
  db().transaction(() => {
    run(`UPDATE thread SET classification = ? WHERE id = ?`, [value, threadId]);

    if (code === "-4") {
      const handle = one<{ handle: string }>(`SELECT handle FROM social_account WHERE creator_id=? AND is_primary=1`, [t.creator_id]);
      if (handle) {
        run(`INSERT OR IGNORE INTO suppression (identifier,kind,reason,scope,created_at) VALUES (?, 'handle', '연락 금지 요청', 'all', ?)`, [
          `@${handle.handle}`,
          today(),
        ]);
      }
      for (const cp of all<{ value: string }>(`SELECT value FROM contact_point WHERE creator_id=? AND kind='email'`, [t.creator_id])) {
        run(`INSERT OR IGNORE INTO suppression (identifier,kind,reason,scope,created_at) VALUES (?, 'email', '연락 금지 요청', 'all', ?)`, [
          cp.value,
          today(),
        ]);
      }
      if (t.campaign_id) {
        run(`UPDATE campaign_target SET stage='dropped', updated_at=? WHERE campaign_id=? AND creator_id=?`, [today(), t.campaign_id, t.creator_id]);
      }
    } else if (code === "3" && t.campaign_id) {
      run(`UPDATE campaign_target SET stage='confirmed', updated_at=? WHERE campaign_id=? AND creator_id=?`, [today(), t.campaign_id, t.creator_id]);
    } else if (code === "2" && t.campaign_id) {
      run(`UPDATE campaign_target SET stage='negotiating', updated_at=? WHERE campaign_id=? AND creator_id=?`, [today(), t.campaign_id, t.creator_id]);
    } else if (code === "-1") {
      // 이탈이 아니라 재큐잉이다. 6개월 뒤 다시 대상이 된다.
      run(`UPDATE thread SET sequence_state='stopped_by_reply' WHERE id=?`, [threadId]);
      run(`INSERT INTO outreach_log (creator_id, campaign_id, channel, sent_at, result) VALUES (?,?, 'email', ?, 'no_reply')`, [
        t.creator_id,
        t.campaign_id,
        nowStamp(),
      ]);
    }
  })();

  invalidateFitCache();
  revalidatePath("/inbox");
  revalidatePath("/dashboard");
}

/** 캠페인 스테이지 이동. 자동화는 카드를 왼쪽으로 되돌리지 않는다 — 사람만 되돌릴 수 있다. */
export async function moveStage(formData: FormData) {
  const campaignId = Number(formData.get("campaignId"));
  const creatorId = Number(formData.get("creatorId"));
  const stage = String(formData.get("stage"));
  run(`UPDATE campaign_target SET stage=?, updated_at=? WHERE campaign_id=? AND creator_id=?`, [stage, today(), campaignId, creatorId]);
  revalidatePath("/campaigns");
}

/** 추천 타깃을 캠페인에 담는다. */
export async function addTarget(formData: FormData) {
  const campaignId = Number(formData.get("campaignId"));
  const creatorId = Number(formData.get("creatorId"));
  run(`INSERT OR IGNORE INTO campaign_target (campaign_id, creator_id, stage, updated_at) VALUES (?,?, 'contacted', ?)`, [
    campaignId,
    creatorId,
    today(),
  ]);
  revalidatePath("/campaigns");
}

/**
 * 발송 실행.
 *
 * 게이트를 다시 통과시킨 뒤에만 큐에 넣는다. 화면에서 통과했더라도 그 사이
 * 수신거부가 등록됐을 수 있으므로 서버에서 한 번 더 계산한다.
 */
export async function startSend(formData: FormData) {
  const campaignId = Number(formData.get("campaignId"));
  const campaign = one<{ id: number; category: string; brand_id: number | null }>(
    `SELECT id, category, brand_id FROM campaign WHERE id = ?`,
    [campaignId],
  );
  if (!campaign) return;

  const seg = buildSegment(campaign, DEFAULT_SEGMENT);
  const gate = runGate(seg, "email");
  if (!gate.allPass) {
    redirect(`/send?step=3&campaign=${campaignId}&blocked=1`);
  }

  const targets = seg.byChannel.email;
  const stamp = nowStamp();

  db().transaction(() => {
    run(`INSERT INTO send_run (campaign_id, channel, planned, queued, started_at, eta, status) VALUES (?, 'email', ?, ?, ?, ?, 'queued')`, [
      campaignId,
      targets.length,
      targets.length,
      stamp,
      `${gate.days}일 소요 예정`,
    ]);
    for (const t of targets) {
      run(`INSERT OR IGNORE INTO campaign_target (campaign_id, creator_id, stage, updated_at) VALUES (?,?, 'contacted', ?)`, [
        campaignId,
        t.creatorId,
        today(),
      ]);
      run(`INSERT INTO outreach_log (creator_id, campaign_id, channel, sent_at, result) VALUES (?,?, 'email', ?, 'sent')`, [
        t.creatorId,
        campaignId,
        stamp,
      ]);
    }
    // 인포크·DM 대상은 자동 발송하지 않고 작업 큐로 넘긴다.
    for (const t of [...seg.byChannel.inpock, ...seg.byChannel.ig_dm].slice(0, 40)) {
      run(`INSERT INTO task (kind, creator_id, campaign_id, sender_id, body, scheduled_at, status) VALUES (?,?,?,?,?,?, 'pending')`, [
        t.channel === "inpock" ? "inpock" : "ig_dm",
        t.creatorId,
        campaignId,
        t.channel === "ig_dm" ? one<{ id: number }>(`SELECT id FROM sender_account WHERE channel='ig_dm' AND status='ok' LIMIT 1`)?.id ?? null : null,
        t.channel === "inpock"
          ? "제안 유형: 공동구매 / 조건은 캠페인 설정을 따릅니다."
          : "안녕하세요! 공구 제안드리고 싶어 연락드립니다.",
        stamp,
      ]);
    }
    const cap = one<{ n: number }>(`SELECT COALESCE(SUM(daily_cap - sent_today),0) AS n FROM sender_account WHERE channel='email' AND status!='suspended'`)!.n;
    const todaySend = Math.min(targets.length, Math.max(0, cap));
    run(`UPDATE sender_account SET sent_today = MIN(daily_cap, sent_today + ?) WHERE channel='email' AND status!='suspended'`, [
      Math.ceil(todaySend / Math.max(1, all(`SELECT id FROM sender_account WHERE channel='email' AND status!='suspended'`).length)),
    ]);
  })();

  invalidateFitCache(campaignId);
  revalidatePath("/dashboard");
  revalidatePath("/campaigns");
  revalidatePath("/queue");
  redirect(`/send?step=3&campaign=${campaignId}&sent=${targets.length}`);
}

// ---------- 임포트 ----------

/** CSV 업로드 → 파싱 → 중복 분석. 아직 본 테이블은 건드리지 않는다. */
export async function uploadCsv(formData: FormData) {
  const source = String(formData.get("source") ?? "pang") as SourceKey;
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) redirect("/import?step=1&err=nofile");
  if (!SOURCES[source]) redirect("/import?step=1&err=badsource");

  const text = await (file as File).text();
  const analysis = analyze(text, source, (file as File).name);
  if (!analysis.rows.length) redirect("/import?step=1&err=empty");

  const batchId = saveBatch(analysis, nowStamp());
  revalidatePath("/import");
  redirect(`/import?step=3&batch=${batchId}`);
}

/** 검토 큐 한 행 처리. 사람이 병합/분리를 결정한다. */
export async function decideRow(formData: FormData) {
  const rowId = Number(formData.get("rowId"));
  const decision = String(formData.get("decision"));
  if (!["merge", "split"].includes(decision)) return;
  run(`UPDATE import_row SET decision = ? WHERE id = ?`, [decision, rowId]);
  revalidatePath("/import");
}

/** 배치 반영. 검토 미처리 행은 그대로 남는다. */
export async function applyImport(formData: FormData) {
  const batchId = Number(formData.get("batchId"));
  const result = applyBatch(batchId, nowStamp());
  invalidateFitCache();
  revalidatePath("/import");
  revalidatePath("/influencers");
  revalidatePath("/dashboard");
  redirect(`/import?step=4&batch=${batchId}&created=${result.created}&updated=${result.updated}&skipped=${result.skipped}`);
}

/** 공구 찜 토글. */
export async function togglePick(formData: FormData) {
  const dealId = Number(formData.get("dealId"));
  run(`UPDATE deal SET picked = 1 - picked WHERE id = ?`, [dealId]);
  revalidatePath("/feed");
}

/** 변화 감지 이벤트 확인 처리. */
export async function markEventsSeen() {
  run(`UPDATE delta_event SET seen = 1 WHERE seen = 0`);
  revalidatePath("/watch");
}
