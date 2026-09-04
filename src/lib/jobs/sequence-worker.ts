import { all, one, run, tx } from "../db";
import { evaluate, nextBusinessSlot, type ChannelPolicy, type SuppressionRow } from "../policy-gate";
import { render } from "../template";
import { ENGINE } from "../states";
import { igUrl } from "../handle";
import * as channels from "../channels";
import { gmail } from "../channels";
import { MAIL } from "../outreach";
import { LINK_FORM_CHANNELS, sqlList } from "../channels/kinds";

/**
 * 시퀀스 워커.
 *
 * 하는 일은 발송이 아니라 배급이다:
 *   1. next_action_at 이 지난 살아 있는 멤버를 꺼낸다 (engine_state > 0)
 *   2. 스텝의 채널 정책을 조회한다
 *   3. 템플릿을 렌더링한다 (spintax + 광고표기 + 수신거부)
 *   4. 정책 게이트 8단계를 통과시킨다
 *   5. auto 채널이면 발송, manual_task 채널이면 작업 큐에 넣는다
 *   6. 다음 스텝 시각을 업무시간 안으로 잡고 지터를 준다
 */

const BATCH = 50;
const JITTER_MINUTES = 3;

export interface TickStats {
  processed: number; sent: number; queued: number; blocked: number; finished: number; failed: number;
}

interface DueMember {
  id: string; campaign_id: string; creator_id: string; sequence_id: string | null;
  current_step: number; engine_state: number; reply_token: string | null; last_sent_at: string | null;
  campaign_name: string; category: string; brand_name: string; commission_rate: string | null;
  sale_from: string | null; sale_to: string | null;
  display_name: string; handle: string; link_in_bio: string | null;
}

export async function tick({ now = new Date(), limit = BATCH } = {}): Promise<TickStats> {
  const due = await all<DueMember>(
    `SELECT cm.id, cm.campaign_id, cm.creator_id, cm.sequence_id, cm.current_step,
            cm.engine_state, cm.reply_token, cm.last_sent_at,
            cp.name AS campaign_name, cp.category, cp.brand_name, cp.commission_rate,
            to_char(cp.sale_from,'YYYY-MM-DD') AS sale_from,
            to_char(cp.sale_to,'YYYY-MM-DD') AS sale_to,
            c.display_name, sa.handle, sa.link_in_bio
       FROM campaign_member cm
       JOIN campaign cp ON cp.id = cm.campaign_id
       JOIN creator c ON c.id = cm.creator_id
       JOIN social_account sa ON sa.creator_id = c.id AND sa.platform='instagram'
      WHERE cm.engine_state > 0
        AND cm.next_action_at IS NOT NULL
        AND cm.next_action_at <= $1
        AND cm.sequence_id IS NOT NULL
      ORDER BY cm.next_action_at
      LIMIT $2`,
    [now.toISOString(), limit],
  );

  const stats: TickStats = { processed: 0, sent: 0, queued: 0, blocked: 0, finished: 0, failed: 0 };
  for (const m of due) {
    stats.processed++;
    try {
      stats[await processMember(m, now)]++;
    } catch (e) {
      stats.failed++;
      console.error(`[seq] member ${m.id} 실패:`, (e as Error).message);
      await run(
        `INSERT INTO gate_block (campaign_member_id, channel, failed_check, detail) VALUES ($1,'-','worker_error',$2)`,
        [m.id, (e as Error).message],
      );
    }
  }
  return stats;
}

type Outcome = "sent" | "queued" | "blocked" | "finished";

export async function processMember(m: DueMember, now: Date): Promise<Outcome> {
  const rawStep = await one<{ id: string; step_no: number; channel: string; delay_minutes: number }>(
    `SELECT id, step_no, channel, delay_minutes FROM sequence_step WHERE sequence_id=$1 AND step_no=$2`,
    [m.sequence_id, m.current_step + 1],
  );

  if (!rawStep) {
    // 전 스텝 소진. 실패가 아니라 시퀀스의 정상 종료다.
    await run(`UPDATE campaign_member SET engine_state=$2::smallint, next_action_at=NULL WHERE id=$1`,
      [m.id, ENGINE.NO_REPLY]);
    return "finished";
  }

  // 채널 폴백 — 이메일이 없으면 버리지 않고 인포크 제안 → DM 순으로 작업 큐에 분기한다.
  let channel = rawStep.channel;
  if (channel === "email") {
    const hasEmail = await one(
      `SELECT 1 FROM contact_point WHERE creator_id=$1 AND channel='email' AND consent_status <> 'opt_out' LIMIT 1`,
      [m.creator_id],
    );
    if (!hasEmail) {
      const alt = await one<{ channel: string }>(
        `SELECT channel FROM contact_point
          WHERE creator_id=$1 AND channel IN (${sqlList(LINK_FORM_CHANNELS)}) AND consent_status <> 'opt_out' LIMIT 1`,
        [m.creator_id],
      );
      channel = alt?.channel ?? "instagram_dm";
    }
  }
  const step = { ...rawStep, channel };

  const policy = await one<ChannelPolicy>(`SELECT * FROM channel_policy WHERE channel=$1`, [step.channel]);
  if (!policy) throw new Error(`channel_policy 에 '${step.channel}' 정의가 없습니다`);

  let variant = await one<{ id: string | null; subject: string | null; body: string; is_ad_content: boolean }>(
    `SELECT sv.id, t.subject, t.body, t.is_ad_content
       FROM step_variant sv JOIN template t ON t.id = sv.template_id
      WHERE sv.step_id=$1 AND sv.is_approved AND t.channel=$2
      ORDER BY random() LIMIT 1`,
    [step.id, step.channel],
  );
  if (!variant && step.channel !== rawStep.channel) {
    // 폴백 채널용 템플릿은 채널 기준으로 찾는다
    variant = await one(
      `SELECT NULL::uuid AS id, t.subject, t.body, t.is_ad_content
         FROM template t WHERE t.channel=$1 ORDER BY random() LIMIT 1`,
      [step.channel],
    );
  }
  if (!variant) throw new Error(`승인된 변형이 없습니다 (step ${step.step_no}, ${step.channel})`);

  const contact = await one<{ id: string; value: string; value_norm: string; consent_status: string; channel: string }>(
    `SELECT id, value, value_norm, consent_status, channel FROM contact_point
      WHERE creator_id=$1 AND channel=$2 AND consent_status <> 'opt_out'
      ORDER BY is_primary DESC, created_at LIMIT 1`,
    [m.creator_id, step.channel],
  );

  const snapshot = await one<{ avg_interval_days: string | null; followers: number | null }>(
    `SELECT s.avg_interval_days, s.followers FROM account_snapshot s
       JOIN social_account sa ON sa.id = s.social_account_id
      WHERE sa.creator_id=$1 ORDER BY s.captured_at DESC LIMIT 1`,
    [m.creator_id],
  );
  const lastDeal = await one<{ title: string; brand_name: string | null }>(
    `SELECT d.title, b.name AS brand_name FROM deal d LEFT JOIN brand b ON b.id=d.brand_id
      WHERE d.creator_id=$1 ORDER BY d.open_date DESC NULLS LAST LIMIT 1`,
    [m.creator_id],
  );

  const sender = await pickSender(step.channel);

  // reply token — 회신을 이 멤버로 되돌리는 열쇠. 없으면 지금 만든다.
  let replyToken = m.reply_token;
  if (!replyToken) {
    replyToken = gmail.newReplyToken();
    await run(`UPDATE campaign_member SET reply_token=$2 WHERE id=$1`, [m.id, replyToken]);
  }

  const [local, domain] = MAIL.address.split("@");
  const bare = gmail.bareToken(replyToken);
  const senderInfo = {
    orgName: MAIL.orgName, address: MAIL.address, phone: MAIL.phone, postalAddress: MAIL.postalAddress,
    unsubUrl: `${MAIL.unsubBase}/${bare}`,
    unsubMailto: `${local}+unsub_${bare}@${domain}`,
    displayName: sender?.display_name ?? "Dinostudio",
  };

  const rendered = render(variant, {
    name: m.display_name, handle: m.handle, category: m.category, brand: m.brand_name,
    product: m.campaign_name,
    commission: m.commission_rate != null ? String(Number(m.commission_rate)) : "협의",
    sale_from: m.sale_from ?? "", sale_to: m.sale_to ?? "",
    cadence: snapshot?.avg_interval_days ? String(Math.round(Number(snapshot.avg_interval_days))) : "",
    last_gb_brand: lastDeal?.brand_name ?? lastDeal?.title ?? "최근",
    followers: snapshot?.followers ? snapshot.followers.toLocaleString("ko-KR") : "",
    sender_name: senderInfo.displayName, social_proof: "",
  }, policy, senderInfo);

  const [suppressions, breakers] = await Promise.all([
    all<SuppressionRow>(
      `SELECT identifier_type, identifier_val, channels, reason, expires_at FROM suppression
        WHERE scope='global' OR (scope='campaign' AND scope_ref=$1)`, [m.campaign_id]),
    all<{ metric: string; is_tripped: boolean; action: string }>(
      `SELECT metric, is_tripped, action FROM circuit_breaker WHERE is_tripped`),
  ]);

  const result = evaluate({
    channel: step.channel, policy,
    contact: contact ? { value_norm: contact.value_norm, consent_status: contact.consent_status, channel: contact.channel } : null,
    creator: { id: m.creator_id }, handle: m.handle,
    suppressions, sender, lastContactAt: m.last_sent_at,
    template: variant, rendered, now, breakers,
    mode: policy.automation_mode === "manual_task" ? "manual" : "auto",
  });

  if (!result.ok) {
    await run(
      `INSERT INTO gate_block (campaign_member_id, channel, failed_check, detail) VALUES ($1,$2,$3,$4)`,
      [m.id, step.channel, result.blocked!.check, result.blocked!.detail],
    );
    // suppression·consent 는 되돌릴 일이 없으니 종결. 나머지(상한·야간 등)는 한 시간 뒤 재시도.
    const terminal = ["suppression", "consent"].includes(result.blocked!.check);
    await run(
      `UPDATE campaign_member SET engine_state=$2::smallint, next_action_at=$3::timestamptz WHERE id=$1`,
      [m.id, terminal ? ENGINE.SUPPRESSED : m.engine_state,
       terminal ? null : new Date(now.getTime() + 3600e3).toISOString()],
    );
    return "blocked";
  }

  if (policy.automation_mode === "manual_task") {
    const task = channels.get(step.channel).makeTask!({
      rendered, handle: m.handle, linkInBio: m.link_in_bio, sender,
      dueAt: nextBusinessSlot(now),
    });
    await run(
      `INSERT INTO outreach_task
         (campaign_member_id, channel, contact_point_id, sender_id, step_id,
          rendered_subject, rendered_body, target_url, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [m.id, task.channel, contact?.id ?? null, task.sender_id, step.id,
       task.rendered_subject, task.rendered_body, task.target_url || igUrl(m.handle), task.due_at.toISOString()],
    );
    await advance(m, step, now, null);
    return "queued";
  }

  const thread = await one<{ thread_key: string; subject: string | null }>(
    `SELECT thread_key, subject FROM message
      WHERE campaign_member_id=$1 AND thread_key IS NOT NULL ORDER BY sent_at LIMIT 1`,
    [m.id],
  );

  // 폴로업 템플릿에는 제목이 없다. 첫 메일 제목을 Re: 로 물려받아야 같은 스레드에 붙는다.
  // 물려받을 스레드가 없으면 캠페인으로 짓는다 — 제목 없는 메일은 스팸으로 걸린다.
  const inherited = thread?.subject ? `Re: ${thread.subject.replace(/^Re:\s*/i, "")}` : null;
  const outbound = {
    ...rendered,
    subject: rendered.subject ?? inherited ?? `Re: ${m.brand_name} ${m.campaign_name} 공동구매 제안`,
  };

  const sendRes = await channels.get(step.channel).send!({
    sender: sender!, contact: contact!, rendered: outbound, replyToken,
    baseAddress: MAIL.address, threadKey: thread?.thread_key ?? null,
  });

  await tx(async (c) => {
    await c.query(
      // dry-run 은 'sent' 로 기록하지 않는다. 실제로 나가지 않았는데 나갔다고 남기면
      // 회신율 분모가 부풀고, 재접촉 쿨다운이 걸려 진짜 발송 때 이 사람을 건너뛴다.
      `INSERT INTO message
         (campaign_member_id, contact_point_id, sender_id, channel, direction, step_id, variant_id,
          thread_key, provider_msg_id, from_name, subject, body, status)
       VALUES ($1,$2,$3,$4,'out',$5,$6,$7,$8,$9,$10,$11,$12)`,
      [m.id, contact?.id ?? null, sender?.id ?? null, step.channel, step.id, variant.id,
       sendRes.threadKey, sendRes.providerMessageId, senderInfo.displayName, outbound.subject, outbound.body,
       sendRes.dryRun ? "dry_run" : "sent"],
    );
    if (sender) {
      await c.query(
        `UPDATE sender SET sent_today = CASE WHEN sent_date=CURRENT_DATE THEN sent_today+1 ELSE 1 END,
                           sent_date = CURRENT_DATE WHERE id=$1`, [sender.id]);
    }
    if (contact) await c.query(`UPDATE contact_point SET last_sent_at=now() WHERE id=$1`, [contact.id]);
  });

  await advance(m, step, now, now);
  return "sent";
}

/** 다음 스텝 예약 + 스테이지 전진. 자동화는 앞으로만 간다 (GREATEST). */
async function advance(m: DueMember, step: { step_no: number }, now: Date, sentAt: Date | null) {
  const next = await one<{ delay_minutes: number }>(
    `SELECT delay_minutes FROM sequence_step WHERE sequence_id=$1 AND step_no=$2`,
    [m.sequence_id, step.step_no + 1],
  );

  let nextAt: string | null = null;
  if (next) {
    const jitter = Math.round((Math.random() * 2 - 1) * JITTER_MINUTES * 60e3);
    nextAt = nextBusinessSlot(new Date(now.getTime() + next.delay_minutes * 60e3 + jitter)).toISOString();
  }

  await run(
    `UPDATE campaign_member
        SET current_step = $2,
            engine_state = $3::smallint,
            next_action_at = $4::timestamptz,
            first_sent_at = COALESCE(first_sent_at, $5::timestamptz),
            last_sent_at = COALESCE($5::timestamptz, last_sent_at),
            stage_id = GREATEST(stage_id, (SELECT id FROM pipeline_stage WHERE key='contacted'))
      WHERE id = $1`,
    [m.id, step.step_no, next ? ENGINE.IN_SEQUENCE : ENGINE.NO_REPLY, nextAt, sentAt?.toISOString() ?? null],
  );
}

/** 상한 여유가 있는 발신 계정을 적게 쓴 순으로 고른다. */
export async function pickSender(channel: string) {
  return (
    (await one<{ id: string; identifier: string; display_name: string | null; sent_today: number; current_cap: number; paused_until: string | null }>(
      `SELECT id, identifier, display_name, sent_today, current_cap,
              to_char(paused_until,'YYYY-MM-DD HH24:MI') AS paused_until
         FROM sender
        WHERE channel=$1 AND is_active
          AND (paused_until IS NULL OR paused_until < now())
          AND (sent_date < CURRENT_DATE OR sent_today < current_cap)
        ORDER BY (CASE WHEN sent_date = CURRENT_DATE THEN sent_today ELSE 0 END) ASC, random()
        LIMIT 1`,
      [channel],
    )) ?? null
  );
}
