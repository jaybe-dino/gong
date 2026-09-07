import { all, one, run } from "./db";
import { ENGINE } from "./states";
import { CATEGORY_KEYS } from "./score";
import { defaultMailbox, mailboxes } from "./google-sa";
import { gmail } from "./channels";
import * as settings from "./settings";
import { hasTable } from "./schema";

/**
 * 발송 (blast) — 채널 하나, 대상 한 묶음, 문안 하나.
 *
 * 캠페인·시퀀스는 여러 번에 걸쳐 관계를 쌓는 구조다. 그건 그대로 두고, "지금
 * 이 사람들에게 이 내용을 보낸다" 는 단순한 일을 위한 직선 경로를 따로 낸다.
 *
 * 엔진은 새로 만들지 않는다. campaign_member 를 그대로 쓴다 — 수신거부, 회신
 * 매핑(reply_token), 메시지 기록이 전부 거기 붙어 있다. 병렬 경로를 만들면
 * 회신이 안 붙거나 수신거부가 새어 나간다.
 */

export interface ChannelSpec {
  key: string;
  label: string;
  /** 자동 발송이 가능한가. 아니면 작업 큐로 간다 (사람이 붙여넣는다). */
  auto: boolean;
  /** 이 채널로 닿을 수 있는 조건을 만드는 SQL 조각. */
  reach: string;
  hint: string;
}

/**
 * 고를 수 있는 채널.
 *
 * 인스타 DM 은 자동 발송이 없다 — Messaging API 는 상대가 먼저 보낸 뒤 24시간
 * 창이 열려야 회신할 수 있고, 임의의 핸들에 첫 DM 을 보내는 엔드포인트 자체가
 * 없다. 인포크·인링크는 상대의 폼에 사람이 붙여넣는 방식이다. 그래서 이 셋은
 * 작업 큐로 가고, 자동으로 나가는 건 이메일뿐이다.
 */
export const CHANNELS: ChannelSpec[] = [
  {
    key: "email", label: "이메일", auto: true,
    reach: `EXISTS (SELECT 1 FROM contact_point x WHERE x.creator_id=c.id
                     AND x.channel='email' AND x.consent_status <> 'opt_out')`,
    hint: "우리 메일함에서 자동으로 나갑니다. 회신은 통합 인박스에 자동으로 붙습니다.",
  },
  {
    key: "inpock_offer", label: "인포크 제안", auto: false,
    reach: `EXISTS (SELECT 1 FROM contact_point x WHERE x.creator_id=c.id
                     AND x.channel='inpock_offer' AND x.consent_status <> 'opt_out')`,
    hint: "인포크 제안 폼에 사람이 붙여넣습니다. 작업 큐에 문안과 링크가 쌓입니다.",
  },
  {
    key: "inlink_form", label: "인링크 폼", auto: false,
    reach: `EXISTS (SELECT 1 FROM contact_point x WHERE x.creator_id=c.id
                     AND x.channel='inlink_form' AND x.consent_status <> 'opt_out')`,
    hint: "인링크 문의 폼에 사람이 붙여넣습니다. 우리 DB 에서 가장 많은 채널입니다.",
  },
  {
    key: "instagram_dm", label: "인스타 DM", auto: false,
    reach: `sa.dm_url IS NOT NULL`,
    hint: "원클릭 딥링크로 DM 창을 열어 붙여넣습니다. 다른 연락처가 없는 대상의 마지막 경로입니다.",
  },
];

export function channelSpec(key: string): ChannelSpec {
  const c = CHANNELS.find((x) => x.key === key);
  if (!c) throw new Error(`알 수 없는 채널: ${key}`);
  return c;
}

export interface Filters {
  category?: string | null;
  minFollowers?: number | null;
  tiers?: string[] | null;
  /** 공구 이력 징후가 있는 대상만. */
  gongguOnly?: boolean;
  /** 최근 N일 안에 연락한 대상은 제외. */
  cooldownDays?: number | null;
  limit?: number | null;
}

export const TIERS = ["A", "B", "C", "D", "E", "F"];
export const CATEGORIES = CATEGORY_KEYS;

/**
 * 필터를 SQL 로. 카운트·미리보기·확정이 같은 조건을 쓴다.
 *
 * 세 곳이 조건을 따로 쓰면, 화면에 1,200명이라고 떠 놓고 900명에게 나간다.
 * 그 차이는 아무 표시도 없이 생기므로 조각을 한 곳에서만 만든다.
 */
function where(ch: ChannelSpec, f: Filters): { sql: string; params: unknown[] } {
  const parts = [`c.merged_into IS NULL`, ch.reach];
  const params: unknown[] = [];

  // 수신거부·연락 금지는 어떤 필터보다 먼저다. 세 식별자 전부 본다 —
  // 하나만 막으면 다른 채널로 새어 나간다.
  parts.push(`NOT EXISTS (
    SELECT 1 FROM suppression s
     WHERE (s.identifier_type='creator_id' AND s.identifier_val = c.id::text)
        OR (s.identifier_type='ig_handle'  AND s.identifier_val = sa.handle)
        OR (s.identifier_type='email' AND s.identifier_val IN
             (SELECT value_norm FROM contact_point WHERE creator_id=c.id AND channel='email')))`);

  if (f.category) {
    params.push(f.category);
    parts.push(`v.category_share ? $${params.length}`);
  }
  if (f.minFollowers) {
    params.push(f.minFollowers);
    parts.push(`v.followers >= $${params.length}`);
  }
  if (f.tiers?.length) {
    params.push(f.tiers);
    parts.push(`c.outreach_tier = ANY($${params.length}::text[])`);
  }
  if (f.gongguOnly) parts.push(`c.has_gonggu_sign`);
  if (f.cooldownDays) {
    params.push(String(f.cooldownDays));
    parts.push(`NOT EXISTS (
      SELECT 1 FROM message msg JOIN campaign_member mm ON mm.id = msg.campaign_member_id
       WHERE mm.creator_id = c.id AND msg.direction='out'
         AND msg.sent_at > now() - ($${params.length} || ' days')::interval)`);
  }
  return { sql: parts.join("\n AND "), params };
}

const FROM = `
  FROM creator c
  JOIN social_account sa ON sa.creator_id = c.id AND sa.platform='instagram'
  LEFT JOIN LATERAL (
    SELECT * FROM account_snapshot s WHERE s.social_account_id = sa.id
    ORDER BY s.captured_at DESC LIMIT 1
  ) v ON true`;

export async function countTargets(channel: string, f: Filters): Promise<number> {
  const ch = channelSpec(channel);
  const w = where(ch, f);
  const r = await one<{ n: number }>(`SELECT count(*)::int AS n ${FROM} WHERE ${w.sql}`, w.params);
  return r?.n ?? 0;
}

export interface TargetRow {
  creator_id: string;
  handle: string;
  display_name: string;
  followers: number | null;
  outreach_tier: string | null;
  contact: string | null;
  categories: string | null;
}

export async function previewTargets(channel: string, f: Filters, limit = 12): Promise<TargetRow[]> {
  const ch = channelSpec(channel);
  const w = where(ch, f);
  const p = [...w.params, limit];
  return all<TargetRow>(
    `SELECT c.id AS creator_id, sa.handle, c.display_name, v.followers, c.outreach_tier,
            ${channel === "instagram_dm"
              ? `sa.dm_url AS contact`
              : `(SELECT value FROM contact_point x WHERE x.creator_id=c.id AND x.channel=$${p.length + 1}
                   ORDER BY is_primary DESC LIMIT 1) AS contact`},
            (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(COALESCE(v.category_share,'{}'::jsonb)) k)
              AS categories
       ${FROM}
      WHERE ${w.sql}
      ORDER BY v.followers DESC NULLS LAST, c.id
      LIMIT $${w.params.length + 1}`,
    channel === "instagram_dm" ? p : [...p, channel],
  );
}

/** 발송 하나에 딸린 껍데기 캠페인. 이름은 발송 이름을 따라간다. */
async function ensureCampaign(b: Blast): Promise<string> {
  if (b.campaign_id) {
    await run(`UPDATE campaign SET name=$2 WHERE id=$1`, [b.campaign_id, b.name]);
    return b.campaign_id;
  }
  const row = await one<{ id: string }>(
    `INSERT INTO campaign (name, brand_name, category, status)
     VALUES ($1, $2, $3, 'running') RETURNING id`,
    [b.name, b.name, (b.filters.category as string) || CATEGORIES[0]],
  );
  await run(`UPDATE blast SET campaign_id=$2 WHERE id=$1`, [b.id, row!.id]);
  return row!.id;
}

/**
 * 대상 확정.
 *
 * 필터 결과를 campaign_member 로 굳힌다. 이 시점 이후로는 필터를 바꿔도 대상이
 * 흔들리지 않는다 — 문안을 쓰는 동안 DB 가 바뀌어서 보낸 사람 수가 달라지면
 * 결과를 설명할 수 없다.
 */
export async function materialize(blastId: string): Promise<number> {
  const b = await getBlast(blastId);
  if (!b) throw new Error("발송을 찾을 수 없습니다.");
  const ch = channelSpec(b.channel);
  const campaignId = await ensureCampaign(b);
  const w = where(ch, b.filters as Filters);

  const limit = (b.filters as Filters).limit ?? 100000;
  const inserted = await one<{ n: number }>(
    `WITH picked AS (
       SELECT c.id ${FROM} WHERE ${w.sql}
       ORDER BY v.followers DESC NULLS LAST, c.id
       LIMIT $${w.params.length + 1}
     ), ins AS (
       INSERT INTO campaign_member (campaign_id, creator_id, stage_id, engine_state, reply_token)
       SELECT $${w.params.length + 2}, picked.id,
              (SELECT id FROM pipeline_stage WHERE key='qualified'),
              $${w.params.length + 3}::smallint,
              'cm_' || encode(gen_random_bytes(4),'hex')
         FROM picked
       ON CONFLICT (campaign_id, creator_id) DO NOTHING
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM ins`,
    [...w.params, limit, campaignId, ENGINE.QUEUED],
  );

  const total = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM campaign_member WHERE campaign_id=$1`, [campaignId]);
  await run(
    `UPDATE blast SET state='targeted', target_count=$2, updated_at=now() WHERE id=$1`,
    [blastId, total?.n ?? 0]);
  void inserted;
  return total?.n ?? 0;
}

export interface Blast {
  id: string;
  name: string;
  channel: string;
  campaign_id: string | null;
  mailbox_email: string | null;
  subject: string | null;
  body: string | null;
  filters: Filters;
  state: string;
  target_count: number;
  created_at: string;
  sent_at: string | null;
}

export async function getBlast(id: string): Promise<Blast | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return (await one<Blast>(
    `SELECT id, name, channel, campaign_id, mailbox_email, subject, body, filters, state,
            target_count, to_char(created_at,'MM-DD HH24:MI') AS created_at,
            to_char(sent_at,'MM-DD HH24:MI') AS sent_at
       FROM blast WHERE id=$1`, [id])) ?? null;
}

export async function listBlasts(limit = 20) {
  if (!(await hasTable("blast"))) return [];
  return all<Blast & { sent: number; replied: number }>(
    `SELECT b.id, b.name, b.channel, b.state, b.target_count, b.mailbox_email,
            to_char(b.created_at,'MM-DD HH24:MI') AS created_at,
            to_char(b.sent_at,'MM-DD HH24:MI') AS sent_at,
            (SELECT count(*)::int FROM message m WHERE m.blast_id=b.id AND m.direction='out') AS sent,
            (SELECT count(*)::int FROM message m
               JOIN campaign_member cm ON cm.id = m.campaign_member_id
              WHERE cm.campaign_id = b.campaign_id AND m.direction='in') AS replied
       FROM blast b ORDER BY b.created_at DESC LIMIT $1`, [limit]);
}

export async function createBlast(name: string, channel: string, userId: string): Promise<string> {
  channelSpec(channel);
  const row = await one<{ id: string }>(
    `INSERT INTO blast (name, channel, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [name.trim() || "이름 없는 발송", channel, userId]);
  return row!.id;
}

export async function saveFilters(id: string, f: Filters, mailbox: string | null): Promise<void> {
  await run(
    `UPDATE blast SET filters=$2, mailbox_email=$3, updated_at=now() WHERE id=$1`,
    [id, JSON.stringify(f), mailbox]);
}

export async function saveContent(id: string, subject: string | null, body: string): Promise<void> {
  await run(
    `UPDATE blast SET subject=$2, body=$3, updated_at=now() WHERE id=$1`,
    [id, subject, body]);
}

/** 치환 변수. 문안 화면이 그대로 안내한다. */
export const VARS: { key: string; label: string }[] = [
  { key: "handle", label: "인스타 핸들 (@ 없이)" },
  { key: "name", label: "표시 이름" },
  { key: "followers", label: "팔로워 수" },
  { key: "org", label: "우리 조직명" },
];

export function fillVars(body: string, v: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? "");
}

/**
 * 테스트 발송. 실제 대상이 아니라 우리가 받아본다.
 *
 * 치환 변수는 첫 대상의 값으로 채운다 — 빈 칸으로 보내면 "{{name}} 님" 이
 * 그대로 보이는지 알 수 없다.
 */
export async function sendTest(blastId: string, to: string): Promise<{ ok: boolean; detail: string }> {
  const b = await getBlast(blastId);
  if (!b) return { ok: false, detail: "발송을 찾을 수 없습니다." };
  if (!b.body?.trim()) return { ok: false, detail: "본문이 비어 있습니다." };

  const sample = (await previewTargets(b.channel, b.filters, 1))[0];
  const org = await settings.get("mail.org");
  const vars = {
    handle: sample?.handle ?? "example_handle",
    name: sample?.display_name ?? "홍길동",
    followers: sample?.followers ? sample.followers.toLocaleString("ko-KR") : "12,000",
    org,
  };
  const body = fillVars(b.body, vars) +
    `\n\n---\n[테스트 발송] 실제 대상에게는 보내지 않았습니다. 치환 값은 첫 대상(${vars.handle})의 것입니다.`;

  const from = b.mailbox_email ?? (await defaultMailbox());
  if (!from) {
    return { ok: false, detail: "발신 메일함이 없습니다. 설정에서 메일함을 등록하고 기본으로 지정하세요." };
  }

  try {
    const res = await gmail.send({
      from, fromName: org, to,
      subject: `[테스트] ${fillVars(b.subject ?? b.name, vars)}`,
      body,
    });
    await settings.testLog("send", !res.dryRun, { detail: `발송 테스트 · ${b.name}` }, null, to);
    return res.dryRun
      ? { ok: false, detail: "키가 없어 dry-run 으로 처리했습니다. 메일은 나가지 않았습니다." }
      : { ok: true, detail: `${from} → ${to} 로 보냈습니다. 받은편지함을 확인하세요.` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

export interface SendProgress {
  sent: number;
  queued: number;
  blocked: number;
  remaining: number;
  done: boolean;
}

/**
 * 발송 실행. 한 번에 청크만 처리하고 남은 수를 돌려준다.
 *
 * 1.2만 명을 한 요청에 보낼 수 없다 — 서버리스 제한 시간에 걸린다. 화면이
 * 스스로 이어 돌리고, 중간에 탭을 닫아도 보낸 것은 보낸 것으로 남는다.
 */
export async function sendChunk(blastId: string, limit = 40): Promise<SendProgress> {
  const b = await getBlast(blastId);
  if (!b) throw new Error("발송을 찾을 수 없습니다.");
  if (!b.campaign_id) throw new Error("대상이 확정되지 않았습니다.");
  if (!b.body?.trim()) throw new Error("본문이 비어 있습니다.");

  const ch = channelSpec(b.channel);
  await run(`UPDATE blast SET state='sending' WHERE id=$1 AND state <> 'done'`, [blastId]);

  const rows = await all<{
    member_id: string; reply_token: string | null; handle: string; display_name: string;
    followers: number | null; contact_id: string | null; contact: string | null; dm_url: string | null;
  }>(
    `SELECT m.id AS member_id, m.reply_token, sa.handle, c.display_name, v.followers,
            cp.id AS contact_id, cp.value AS contact, sa.dm_url
       FROM campaign_member m
       JOIN creator c ON c.id = m.creator_id
       JOIN social_account sa ON sa.creator_id = c.id AND sa.platform='instagram'
       LEFT JOIN LATERAL (
         SELECT * FROM account_snapshot s WHERE s.social_account_id=sa.id
         ORDER BY s.captured_at DESC LIMIT 1) v ON true
       LEFT JOIN LATERAL (
         SELECT * FROM contact_point x WHERE x.creator_id=c.id AND x.channel=$3
         ORDER BY is_primary DESC LIMIT 1) cp ON true
      WHERE m.campaign_id=$1
        AND NOT EXISTS (SELECT 1 FROM message msg WHERE msg.campaign_member_id=m.id AND msg.blast_id=$4)
        AND NOT EXISTS (SELECT 1 FROM outreach_task t WHERE t.campaign_member_id=m.id AND t.blast_id=$4)
      ORDER BY v.followers DESC NULLS LAST, m.id
      LIMIT $2`,
    [b.campaign_id, limit, b.channel, blastId],
  );

  const org = await settings.get("mail.org");
  const base = await settings.get("mail.address");
  const from = b.mailbox_email ?? (await defaultMailbox());

  let sent = 0, queued = 0, blocked = 0;
  for (const r of rows) {
    const vars = {
      handle: r.handle,
      name: r.display_name || r.handle,
      followers: r.followers ? r.followers.toLocaleString("ko-KR") : "",
      org,
    };
    const body = fillVars(b.body, vars);
    const subject = fillVars(b.subject ?? b.name, vars);

    if (!ch.auto) {
      // 사람이 붙여넣는 채널. 문안과 링크를 큐에 넣는다.
      await run(
        `INSERT INTO outreach_task (campaign_member_id, channel, contact_point_id, blast_id,
                                    rendered_subject, rendered_body, target_url, due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
        [r.member_id, b.channel, r.contact_id, blastId, subject, body,
         b.channel === "instagram_dm" ? r.dm_url : r.contact]);
      queued++;
      continue;
    }

    if (!r.contact) { blocked++; continue; }

    try {
      const res = await gmail.send({
        from: from!, fromName: org, to: r.contact,
        replyTo: r.reply_token ? gmail.replyToAddress(base, r.reply_token) : null,
        subject, body,
      });
      await run(
        `INSERT INTO message (campaign_member_id, contact_point_id, channel, direction, blast_id,
                              thread_key, provider_msg_id, subject, body, status)
         VALUES ($1,$2,$3,'out',$4,$5,$6,$7,$8,$9)`,
        [r.member_id, r.contact_id, b.channel, blastId, res.threadKey, res.providerMessageId,
         subject, body, res.dryRun ? "dry_run" : "sent"]);
      await run(
        `UPDATE campaign_member
            SET last_sent_at=now(), first_sent_at=COALESCE(first_sent_at, now()),
                stage_id = GREATEST(stage_id, (SELECT id FROM pipeline_stage WHERE key='contacted'))
          WHERE id=$1`, [r.member_id]);
      sent++;
    } catch (e) {
      console.error("[blast]", r.handle, (e as Error).message);
      blocked++;
    }
  }

  const remaining = (await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM campaign_member m
      WHERE m.campaign_id=$1
        AND NOT EXISTS (SELECT 1 FROM message msg WHERE msg.campaign_member_id=m.id AND msg.blast_id=$2)
        AND NOT EXISTS (SELECT 1 FROM outreach_task t WHERE t.campaign_member_id=m.id AND t.blast_id=$2)`,
    [b.campaign_id, blastId]))?.n ?? 0;

  if (remaining === 0) {
    await run(`UPDATE blast SET state='done', sent_at=COALESCE(sent_at, now()) WHERE id=$1`, [blastId]);
  }
  return { sent, queued, blocked, remaining, done: remaining === 0 };
}

export interface BlastResult {
  sent: number;
  dryRun: number;
  queued: number;
  replied: number;
  bounced: number;
  optedOut: number;
}

export async function results(blastId: string): Promise<BlastResult> {
  const b = await getBlast(blastId);
  const zero = { sent: 0, dryRun: 0, queued: 0, replied: 0, bounced: 0, optedOut: 0 };
  if (!b?.campaign_id) return zero;
  return (await one<BlastResult>(
    `SELECT
       (SELECT count(*)::int FROM message m WHERE m.blast_id=$1 AND m.status='sent') AS sent,
       (SELECT count(*)::int FROM message m WHERE m.blast_id=$1 AND m.status='dry_run') AS "dryRun",
       (SELECT count(*)::int FROM outreach_task t WHERE t.blast_id=$1) AS queued,
       (SELECT count(*)::int FROM message m
          JOIN campaign_member cm ON cm.id=m.campaign_member_id
         WHERE cm.campaign_id=$2 AND m.direction='in') AS replied,
       (SELECT count(*)::int FROM message_event e
          JOIN message m ON m.id=e.message_id
         WHERE m.blast_id=$1 AND e.type LIKE 'bounce%') AS bounced,
       (SELECT count(*)::int FROM message_event e
          JOIN message m ON m.id=e.message_id
         WHERE m.blast_id=$1 AND e.type='unsubscribe') AS "optedOut"`,
    [blastId, b.campaign_id])) ?? zero;
}

/** 이메일 채널에서 고를 수 있는 발신함. 등록·활성화된 것만. */
export async function sendableMailboxes() {
  return (await mailboxes()).filter((m) => m.enabled);
}



