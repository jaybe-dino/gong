import { all, one, run, tx } from "../db";
import { gmail } from "../channels";
import * as notify from "./notify";
import { ENGINE, INTEREST, interestEffects, type InterestEffects } from "../states";
import { parseReturnDate } from "../parse";

/**
 * 수신 동기화 — 회사 메일 한 개의 인박스를 캠페인에 연결한다.
 *
 * 매핑 순서
 *   1. Reply-To 플러스 주소의 cm_{token}  ← 가장 확실
 *   2. Gmail threadId = 우리 thread_key
 *   3. 발신자 이메일 → contact_point
 *
 * 회신이 도착하면 시퀀스를 즉시 중단한다. 단 부재중 자동응답은 '답장'이 아니다 —
 * 답장으로 세면 회신율이 부풀고 살아 있는 대상이 조용히 죽는다.
 */

let historyId: string | null = null;

export interface SyncResult {
  processed: number;
  skipped: number;
  unmapped: number;
  dryRun?: boolean;
}

export async function tick(): Promise<SyncResult> {
  const { messages, historyId: newId, dryRun } = await gmail.fetchInbound({ sinceHistoryId: historyId });
  historyId = newId ?? historyId;
  if (dryRun) return { processed: 0, skipped: 0, unmapped: 0, dryRun: true };

  let processed = 0;
  let skipped = 0;
  let unmapped = 0;
  for (const msg of messages) {
    try {
      const r = await ingest(msg);
      if (r === "ok") processed++;
      else if (r === "unmapped") unmapped++;
      else skipped++;
    } catch (e) {
      console.error("[inbound]", msg.providerMessageId, (e as Error).message);
      skipped++;
    }
  }
  return { processed, skipped, unmapped };
}

export interface MappedMember {
  id: string; creator_id: string; campaign_id: string;
  display_name: string; handle: string; campaign_name: string;
}

export async function ingest(msg: gmail.InboundMessage): Promise<"ok" | "duplicate" | "unmapped"> {
  if (await one(`SELECT id FROM message WHERE provider_msg_id=$1`, [msg.providerMessageId])) return "duplicate";

  const member = await resolveMember(msg);
  if (!member) {
    console.warn(`[inbound] 매핑 실패: ${msg.from} / ${msg.subject}`);
    return "unmapped";
  }

  const contact = await one<{ id: string }>(
    `SELECT id FROM contact_point WHERE creator_id=$1 AND channel='email' ORDER BY is_primary DESC LIMIT 1`,
    [member.creator_id],
  );

  const stored = await one<{ id: string }>(
    `INSERT INTO message
       (campaign_member_id, contact_point_id, channel, direction, thread_key, provider_msg_id,
        from_name, subject, body, sent_at)
     VALUES ($1,$2,'email','in',$3,$4,$5,$6,$7,$8) RETURNING id`,
    [member.id, contact?.id ?? null, msg.threadKey, msg.providerMessageId,
     msg.from, msg.subject, msg.body, msg.receivedAt.toISOString()],
  );

  await run(
    `INSERT INTO message_event (message_id, type, occurred_at, meta) VALUES ($1,$2,$3,$4)`,
    [stored!.id, msg.isAutoReply ? "ooo" : "reply", msg.receivedAt.toISOString(), JSON.stringify({ from: msg.from })],
  );

  if (msg.isAutoReply) {
    // 부재중은 답장이 아니다. 복귀일을 뽑아 그날 09시로 재스케줄한다.
    const back = parseReturnDate(msg.body, msg.receivedAt);
    const resumeAt = back
      ? `${back} 09:00+09`
      : new Date(msg.receivedAt.getTime() + 7 * 864e5).toISOString();
    await run(
      `UPDATE campaign_member SET engine_state=$2::smallint, interest_status=$3::smallint,
              next_action_at=$4::timestamptz WHERE id=$1`,
      [member.id, ENGINE.PAUSED_OOO, INTEREST.OOO, resumeAt],
    );
    return "ok";
  }

  // 진짜 회신 — 시퀀스 즉시 중단. 스테이지는 앞으로만 간다.
  await run(
    `UPDATE campaign_member
        SET engine_state=$2::smallint,
            replied_at = COALESCE(replied_at, $3::timestamptz),
            next_action_at = NULL,
            stage_id = GREATEST(stage_id, (SELECT id FROM pipeline_stage WHERE key='replied'))
      WHERE id=$1`,
    [member.id, ENGINE.REPLIED, msg.receivedAt.toISOString()],
  );

  await notify.replyArrived({
    name: member.display_name, handle: member.handle,
    campaign: member.campaign_name, preview: msg.body.slice(0, 120),
  });
  return "ok";
}

export async function resolveMember(msg: gmail.InboundMessage): Promise<MappedMember | null> {
  if (msg.replyToken) {
    const m = await byQuery(`cm.reply_token = $1`, [msg.replyToken]);
    if (m) return m;
  }
  if (msg.threadKey) {
    const m = await one<MappedMember>(
      `SELECT cm.id, cm.creator_id, cm.campaign_id, c.display_name, sa.handle, cp.name AS campaign_name
         FROM message msg
         JOIN campaign_member cm ON cm.id = msg.campaign_member_id
         JOIN creator c ON c.id = cm.creator_id
         JOIN social_account sa ON sa.creator_id = c.id AND sa.platform='instagram'
         JOIN campaign cp ON cp.id = cm.campaign_id
        WHERE msg.thread_key = $1 LIMIT 1`,
      [msg.threadKey],
    );
    if (m) return m;
  }
  const email = extractEmail(msg.from);
  if (email) {
    return (await byQuery(
      `cm.creator_id = (SELECT creator_id FROM contact_point WHERE value_norm=$1 LIMIT 1)`,
      [email.toLowerCase()],
    )) ?? null;
  }
  return null;
}

async function byQuery(where: string, params: unknown[]): Promise<MappedMember | undefined> {
  return one<MappedMember>(
    `SELECT cm.id, cm.creator_id, cm.campaign_id, c.display_name, sa.handle, cp.name AS campaign_name
       FROM campaign_member cm
       JOIN creator c ON c.id = cm.creator_id
       JOIN social_account sa ON sa.creator_id = c.id AND sa.platform='instagram'
       JOIN campaign cp ON cp.id = cm.campaign_id
      WHERE ${where}
      ORDER BY cm.created_at DESC LIMIT 1`,
    params,
  );
}

export function extractEmail(from: string | null | undefined): string | null {
  const s = String(from ?? "");
  const m = s.match(/<([^>]+)>/) ?? s.match(/([^\s<>]+@[^\s<>]+)/);
  return m ? m[1] : null;
}

/**
 * 회신 분류 + 부수효과.
 *
 * 분류가 무엇을 일으키는지는 states.interestEffects 한 곳에만 있고, 여기서 그대로 실행한다.
 * 연락 금지는 creator_id · 핸들 · 이메일 셋 다 등재한다 — 하나만 막으면 다른 채널로 새어 나간다.
 */
export async function classifyReply(memberId: string, interest: number, actorId: string): Promise<InterestEffects> {
  const eff = interestEffects(interest);
  const member = await one<{ id: string; creator_id: string; campaign_id: string }>(
    `SELECT id, creator_id, campaign_id FROM campaign_member WHERE id=$1`, [memberId],
  );
  if (!member) throw new Error("멤버를 찾을 수 없습니다");

  await tx(async (c) => {
    await c.query(`UPDATE campaign_member SET interest_status=$2::smallint WHERE id=$1`, [memberId, interest]);

    if (eff.stage) {
      await c.query(
        `UPDATE campaign_member
            SET stage_id=(SELECT id FROM pipeline_stage WHERE key=$2),
                agreed_at = CASE WHEN $2='agreed' THEN now() ELSE agreed_at END,
                dropped_at = CASE WHEN $2='dropped' THEN now() ELSE dropped_at END
          WHERE id=$1`,
        [memberId, eff.stage],
      );
    }
    if (eff.dropReason) {
      await c.query(`UPDATE campaign_member SET drop_reason=$2 WHERE id=$1`, [memberId, eff.dropReason]);
    }
    if (eff.engineState != null) {
      await c.query(`UPDATE campaign_member SET engine_state=$2::smallint, next_action_at=NULL WHERE id=$1`,
        [memberId, eff.engineState]);
    } else if (interest !== INTEREST.OOO && !eff.requeueAfterDays) {
      // 회신이 온 것이므로 시퀀스는 성공 종료다.
      await c.query(`UPDATE campaign_member SET engine_state=$2::smallint, next_action_at=NULL
                      WHERE id=$1 AND engine_state > 0`, [memberId, ENGINE.REPLIED]);
    }

    if (eff.requeueAfterDays) {
      // 이탈이 아니라 재큐잉이다. 살아 있는 상태로 되돌린다.
      await c.query(
        `UPDATE campaign_member SET engine_state=$2::smallint,
                next_action_at = now() + ($3 || ' days')::interval WHERE id=$1`,
        [memberId, ENGINE.QUEUED, String(eff.requeueAfterDays)],
      );
    }

    if (eff.parseReturnDate) {
      const body = (await c.query<{ body: string }>(
        `SELECT body FROM message WHERE campaign_member_id=$1 AND direction='in' ORDER BY sent_at DESC LIMIT 1`,
        [memberId],
      )).rows[0]?.body;
      const back = parseReturnDate(body);
      await c.query(
        `UPDATE campaign_member SET engine_state=$2::smallint, next_action_at=$3::timestamptz WHERE id=$1`,
        [memberId, ENGINE.PAUSED_OOO, back ? `${back} 09:00+09` : null],
      );
    }

    if (eff.suppress) {
      const reason = eff.suppress.reason;
      await c.query(
        `INSERT INTO suppression (identifier_type, identifier_val, channels, reason)
         VALUES ('creator_id',$1,'{}',$2) ON CONFLICT DO NOTHING`, [member.creator_id, reason]);
      await c.query(
        `INSERT INTO suppression (identifier_type, identifier_val, channels, reason)
         SELECT 'ig_handle', handle, '{}', $2 FROM social_account WHERE creator_id=$1
         ON CONFLICT DO NOTHING`, [member.creator_id, reason]);
      await c.query(
        `INSERT INTO suppression (identifier_type, identifier_val, channels, reason)
         SELECT 'email', value_norm, '{}', $2 FROM contact_point WHERE creator_id=$1 AND channel='email'
         ON CONFLICT DO NOTHING`, [member.creator_id, reason]);
      await c.query(`UPDATE contact_point SET consent_status='opt_out' WHERE creator_id=$1`, [member.creator_id]);
    }

    if (eff.issueToken) {
      await c.query(
        `INSERT INTO attribution_token (campaign_id, creator_id, kind, token)
         VALUES ($1,$2,'link', 'lk_' || encode(gen_random_bytes(4),'hex')),
                ($1,$2,'coupon', 'CP' || upper(encode(gen_random_bytes(3),'hex')))
         ON CONFLICT DO NOTHING`,
        [member.campaign_id, member.creator_id],
      );
    }
  });

  await run(
    `INSERT INTO audit_log (actor_id, actor_kind, entity, entity_id, action, after)
     VALUES ($1,'user','campaign_member',$2,'classify_reply',$3)`,
    [actorId, memberId, JSON.stringify({ interest, effects: eff })],
  );
  return eff;
}
