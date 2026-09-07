import { all, one, run } from "./db";
import { ENGINE } from "./states";
import { CATEGORY_KEYS } from "./score";
import { defaultMailbox, isConfigured as isSaConfigured, mailboxes } from "./google-sa";
import { gmail } from "./channels";
import { htmlToText } from "./channels/gmail";
import * as settings from "./settings";
import { hasColumn, hasTable } from "./schema";
import * as track from "./tracking";
import * as pace from "./pacing";
import { render, type PolicyRow } from "./template";
import { channelPolicies } from "./queries";

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
  /** HTML 본문. 있으면 multipart/alternative 로 나간다 — 이미지가 여기 들어간다. */
  body_html: string | null;
  track_opens: boolean;
  track_clicks: boolean;
  filters: Filters;
  /** 영리목적 광고성 정보인가. (광고) 표기와 수신거부 푸터가 여기에 달려 있다. */
  is_ad: boolean;
  state: string;
  target_count: number;
  created_at: string;
  sent_at: string | null;
}

/**
 * 발송 하나를 읽는다.
 *
 * 뒤에 더한 컬럼(012 의 is_ad, 013 의 body_html·추적 플래그)은 있는지 보고
 * 고른다. 마이그레이션이 밀린 배포에서 그냥 SELECT 하면
 * `column "body_html" does not exist` 로 화면 전체가 죽는다 — 실제로 죽었다.
 * 없으면 그 기능만 빠진 기본값으로 돌고, 화면이 무엇이 빠졌는지 알려준다.
 */
export async function getBlast(id: string): Promise<Blast | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;

  const [hasAd, hasHtml] = await Promise.all([
    hasColumn("blast", "is_ad"),
    hasColumn("blast", "body_html"),
  ]);

  const row = await one<Blast>(
    `SELECT id, name, channel, campaign_id, mailbox_email, subject, body, filters, state,
            target_count, to_char(created_at,'MM-DD HH24:MI') AS created_at,
            to_char(sent_at,'MM-DD HH24:MI') AS sent_at,
            ${hasAd ? "is_ad" : "true AS is_ad"},
            ${hasHtml
              ? "body_html, track_opens, track_clicks"
              : "NULL::text AS body_html, false AS track_opens, false AS track_clicks"}
       FROM blast WHERE id=$1`, [id]);
  return row ?? null;
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

export interface ContentInput {
  subject: string | null;
  body: string;
  html: string | null;
  isAd: boolean;
  trackOpens: boolean;
  trackClicks: boolean;
}

/**
 * 문안 저장.
 *
 * text/plain 은 항상 있어야 한다. HTML 만 쓴 경우 여기서 대안을 만든다 —
 * 부르는 쪽마다 만들게 하면 한 곳이 빠지고, 그러면 "본문이 비어 있다" 로
 * 발송이 막히거나 텍스트 클라이언트에서 빈 메일이 된다.
 */
export async function saveContent(id: string, c: ContentInput): Promise<void> {
  const html = c.html?.trim() || null;
  const body = c.body.trim() ? c.body : html ? htmlToText(html) : "";

  // 컬럼이 없는 배포에서는 있는 것만 저장한다. 문안 저장이 통째로 실패하는
  // 것보다, HTML·추적만 빠지고 텍스트는 저장되는 편이 낫다.
  const [hasAd, hasHtml] = await Promise.all([
    hasColumn("blast", "is_ad"),
    hasColumn("blast", "body_html"),
  ]);
  const sets = ["subject=$2", "body=$3"];
  const params: unknown[] = [id, c.subject, body];
  if (hasAd) { params.push(c.isAd); sets.push(`is_ad=$${params.length}`); }
  if (hasHtml) {
    params.push(html); sets.push(`body_html=$${params.length}`);
    params.push(c.trackOpens); sets.push(`track_opens=$${params.length}`);
    params.push(c.trackClicks); sets.push(`track_clicks=$${params.length}`);
  }
  await run(`UPDATE blast SET ${sets.join(", ")}, updated_at=now() WHERE id=$1`, params);
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
 * 발송용 최종 문안.
 *
 * 여기를 거치지 않고 본문을 그대로 보내면 안 된다. 콜드 광고 메일에는
 * (광고) 표기와 수신거부 방법이 있어야 한다 — 정보통신망법 §50 이고, 없으면
 * 과태료 대상이며 Gmail·네이버가 스팸으로 분류한다.
 *
 * 처음 만들 때 이 단계를 빼먹어서 본문이 그대로 나가게 돼 있었다. 화면에서는
 * 아무 문제가 없어 보인다 — 그래서 렌더 경로를 하나로 좁히고, 미리보기도
 * 같은 함수를 쓰게 한다.
 */
export interface RenderedBlast {
  subject: string | null;
  body: string;
  /** HTML 본문. 추적을 켜면 링크가 치환되고 픽셀이 붙은 상태다. */
  html: string | null;
  headers: Record<string, string>;
  warnings: string[];
}

export async function renderForSend(
  b: Blast,
  vars: Record<string, string>,
  replyToken: string | null,
  policy: PolicyRow | null,
): Promise<RenderedBlast> {
  const [org, address, phone, postal, unsubBase] = await Promise.all([
    settings.get("mail.org"), settings.get("mail.address"),
    settings.get("mail.phone"), settings.get("mail.postal"), settings.unsubBase(),
  ]);
  const [local, domain] = address.split("@");
  const bare = replyToken ? gmail.bareToken(replyToken) : null;

  const sender = {
    orgName: org, address, phone, postalAddress: postal,
    unsubUrl: bare ? `${unsubBase}/${bare}` : undefined,
    unsubMailto: bare ? `${local}+unsub_${bare}@${domain}` : undefined,
    displayName: org,
  };

  const text = render(
    { subject: b.subject, body: b.body ?? "", is_ad_content: b.is_ad, channel: b.channel },
    vars, policy, sender);

  if (!b.body_html?.trim()) return { ...text, html: null };

  // HTML 도 같은 렌더러를 거친다 — (광고) 표기와 수신거부가 HTML 쪽에만 빠지면
  // 텍스트로 읽는 사람에게만 표기가 보인다.
  const htmlRendered = render(
    { subject: b.subject, body: fillVars(b.body_html, vars), is_ad_content: b.is_ad, channel: b.channel },
    {}, policy, sender);

  // 푸터는 render 가 평문으로 붙인다. HTML 안에서는 줄바꿈이 무시되므로 옮겨 준다.
  const [htmlBody, ...footer] = htmlRendered.body.split("\n\n—\n");
  const html = footer.length
    ? `${htmlBody}\n<hr style="border:0;border-top:1px solid #ddd;margin:24px 0" />\n` +
      `<div style="font-size:12px;color:#666;line-height:1.7">` +
      footer.join("\n").split("\n").map((l) => escapeHtml(l)).join("<br />") +
      `</div>`
    : htmlBody;

  return { ...text, html, warnings: [...text.warnings, ...htmlRendered.warnings] };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 추적을 붙인다. 링크를 우리 도메인으로 바꾸고 열람 픽셀을 넣는다.
 *
 * 발송마다 켜고 끈다 — 켜면 도달률이 떨어진다(tracking.ts). 텍스트 본문은
 * 건드리지 않는다: 평문에서 링크를 바꿔치기하면 받는 사람이 눈으로 목적지를
 * 확인할 수 없다.
 */
export async function applyTracking(
  b: Blast, r: RenderedBlast, token: string, baseUrl: string, links: string[],
): Promise<RenderedBlast> {
  if (!r.html || (!b.track_opens && !b.track_clicks)) return r;
  // 013 이 없으면 담을 곳이 없다. 추적만 조용히 빠지고 발송은 그대로 나간다.
  if (!(await hasTable("blast_link"))) return r;
  let html = r.html;
  if (b.track_clicks) html = track.rewriteLinks(html, links, baseUrl, token);
  if (b.track_opens) html += track.pixelTag(baseUrl, token);
  return { ...r, html };
}

/**
 * 이 채널의 정책. (광고) 표기·수신거부 필수 여부가 여기서 나온다.
 *
 * 광고성 정보가 아니라고 표시한 발송에는 표기를 붙이지 않는다 — 광고가 아닌
 * 1:1 제안에 (광고) 를 붙이면 그게 오히려 사실과 다르고, 받는 쪽 필터도
 * 광고함으로 보낸다.
 */
export async function policyFor(channel: string, isAd = true): Promise<PolicyRow | null> {
  const rows = await channelPolicies().catch(() => []);
  const p = (rows.find((x) => x.channel === channel) as PolicyRow | undefined) ?? null;
  if (!p || isAd) return p;
  return { ...p, requires_ad_label: false, requires_optout: false };
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
  // 실제 발송과 같은 렌더러를 거친다. 테스트가 법정 표기를 빼고 나가면
  // "무엇이 나가는지" 를 확인하는 목적 자체가 사라진다.
  const policy = await policyFor(b.channel, b.is_ad);
  const r = await renderForSend(b, vars, "cm_testtoken", policy);
  const body = r.body +
    `\n\n---\n[테스트 발송] 실제 대상에게는 보내지 않았습니다. 치환 값은 첫 대상(${vars.handle})의 것이고, ` +
    `수신거부 링크는 테스트용이라 동작하지 않습니다.`;

  const from = b.mailbox_email ?? (await defaultMailbox());
  if (!from) {
    return { ok: false, detail: "발신 메일함이 없습니다. 설정에서 메일함을 등록하고 기본으로 지정하세요." };
  }
  const display = await settings.fromName();

  try {
    const res = await gmail.send({
      from, fromName: display, to,
      subject: `[테스트] ${r.subject ?? b.name}`,
      body,
      html: r.html,
      headers: r.headers,
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
  /**
   * 상한 때문에 멈췄으면 그 이유. done=false 인데 이 값이 있으면 화면은 이어
   * 돌리기를 멈춰야 한다 — 계속 호출해도 0건씩 돌아온다.
   */
  paced: string | null;
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

  // 화면을 우회해도 막힌다. 법정 표기가 빈 채로 나가는 경로를 남기지 않는다.
  const pre = await preflight(blastId);
  if (!pre.ok) throw new Error(pre.blockers.join(" · "));

  // 발송량 상한. 자동 채널만 해당한다 — 사람이 붙여넣는 채널은 큐에 쌓는 것이
  // 발송이 아니므로 여기서 깎으면 하루치만 큐에 들어가고 나머지가 사라진 것처럼
  // 보인다. 그쪽은 큐 화면에서 사람이 하루에 처리하는 양이 곧 상한이다.
  const budget = ch.auto ? pre.pace : null;
  if (budget?.blocked) {
    const left = await countRemaining(blastId, b.campaign_id);
    return { sent: 0, queued: 0, blocked: 0, remaining: left, done: left === 0,
             paced: budget.blocked };
  }
  const take = budget ? Math.min(limit, budget.allowedNow) : limit;
  if (take <= 0) {
    const left = await countRemaining(blastId, b.campaign_id);
    return { sent: 0, queued: 0, blocked: 0, remaining: left, done: left === 0,
             paced: "오늘 보낼 수 있는 여유가 없습니다." };
  }

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
    [b.campaign_id, take, b.channel, blastId],
  );

  const org = await settings.get("mail.org");
  const base = await settings.get("mail.address");
  const from = b.mailbox_email ?? (await defaultMailbox());
  const policy = await policyFor(b.channel, b.is_ad);
  const display = await settings.fromName();
  const baseUrl = (await settings.get("app.base_url")).replace(/\/$/, "");
  // 링크 번호는 발송 전체에서 같아야 한다 — 이미 담아 둔 것을 이어서 쓴다.
  const hasTrackToken = await hasColumn("message", "track_token");
  const links = (await hasTable("blast_link"))
    ? (await all<{ url: string }>(
        `SELECT url FROM blast_link WHERE blast_id=$1 ORDER BY idx`, [blastId])).map((x) => x.url)
    : [];

  let sent = 0, queued = 0, blocked = 0;
  for (const r of rows) {
    const vars = {
      handle: r.handle,
      name: r.display_name || r.handle,
      followers: r.followers ? r.followers.toLocaleString("ko-KR") : "",
      org,
    };
    // 렌더러가 (광고) 표기와 수신거부를 붙인다. 본문을 그대로 보내면 안 된다.
    const trackToken = track.newTrackToken();
    const rendered = await applyTracking(
      b, await renderForSend(b, vars, r.reply_token, policy), trackToken, baseUrl, links);
    const body = rendered.body;
    const subject = rendered.subject ?? b.name;

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
        from: from!, fromName: display, to: r.contact,
        replyTo: r.reply_token ? gmail.replyToAddress(base, r.reply_token) : null,
        subject, body, html: rendered.html, headers: rendered.headers,
      });
      // 컬럼이 없으면 자리표시자도 같이 빠져야 한다. 하나만 빼면
      // "bind message supplies 10 parameters, but prepared statement requires 9" 로 죽는다.
      const msgParams: unknown[] = [
        r.member_id, r.contact_id, b.channel, blastId, res.threadKey, res.providerMessageId,
        subject, body, res.dryRun ? "dry_run" : "sent",
        // 시간당 상한은 message.sender_id 를 세어 계산한다. 여기서 비워 두면
        // 상한이 영원히 0/12 로 읽히고 분산이 아무 일도 하지 않는다.
        budget?.senderId ?? null,
      ];
      if (hasTrackToken) msgParams.push(b.track_opens || b.track_clicks ? trackToken : null);
      await run(
        `INSERT INTO message (campaign_member_id, contact_point_id, channel, direction, blast_id,
                              thread_key, provider_msg_id, subject, body, status, sender_id
                              ${hasTrackToken ? ", track_token" : ""})
         VALUES ($1,$2,$3,'out',$4,$5,$6,$7,$8,$9,$10${hasTrackToken ? ",$11" : ""})`,
        msgParams);
      await run(
        `UPDATE campaign_member
            SET last_sent_at=now(), first_sent_at=COALESCE(first_sent_at, now()),
                stage_id = GREATEST(stage_id, (SELECT id FROM pipeline_stage WHERE key='contacted'))
          WHERE id=$1`, [r.member_id]);
      sent++;
      // 성공한 뒤에 깎는다. 미리 깎으면 실패한 건까지 오늘 몫을 먹는다.
      if (budget?.senderId) await pace.consume(budget.senderId);
      // 건당 간격. 40건을 1초 안에 밀어 넣는 것도 급증 신호다.
      if (budget?.gapMs) await sleep(budget.gapMs);
    } catch (e) {
      console.error("[blast]", r.handle, (e as Error).message);
      blocked++;
    }
  }

  // 본문에서 찾은 링크를 담아 둔다. /t/c 는 이 표만 보고 리다이렉트하므로
  // 여기 없는 주소로는 어디로도 보낼 수 없다.
  if (b.track_clicks && links.length) await track.saveLinks(blastId, links);

  const remaining = await countRemaining(blastId, b.campaign_id);

  if (remaining === 0) {
    await run(`UPDATE blast SET state='done', sent_at=COALESCE(sent_at, now()) WHERE id=$1`, [blastId]);
  }
  // 상한에 걸려 청크가 잘렸으면 화면에 알려야 한다. 그냥 remaining 만 돌려주면
  // 화면이 끝없이 이어 돌리고, 매번 0건이 나가면서 다 끝난 것처럼 보인다.
  const paced = budget && sent >= take && remaining > 0
    ? `오늘 몫 ${budget.capToday}건을 다 썼습니다 — 남은 ${remaining.toLocaleString("ko-KR")}명은 내일 이어서 보내세요.`
    : null;
  return { sent, queued, blocked, remaining, done: remaining === 0, paced };
}

/** 지터를 섞은 대기. 정확히 같은 간격으로 나가는 것도 사람 같지 않다. */
function sleep(ms: number): Promise<void> {
  const jittered = ms + Math.floor(Math.random() * ms);
  return new Promise((r) => setTimeout(r, jittered));
}

/** 아직 메시지도 작업도 만들어지지 않은 대상 수. */
async function countRemaining(blastId: string, campaignId: string): Promise<number> {
  return (await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM campaign_member m
      WHERE m.campaign_id=$1
        AND NOT EXISTS (SELECT 1 FROM message msg WHERE msg.campaign_member_id=m.id AND msg.blast_id=$2)
        AND NOT EXISTS (SELECT 1 FROM outreach_task t WHERE t.campaign_member_id=m.id AND t.blast_id=$2)`,
    [campaignId, blastId]))?.n ?? 0;
}

export interface BlastResult {
  sent: number;
  dryRun: number;
  queued: number;
  replied: number;
  bounced: number;
  optedOut: number;
}

/**
 * 발송 전 점검. 통과하지 못하면 보내지 않는다.
 *
 * 법정 표기가 비면 푸터가 "Dinostudio (주) ·  ·  ·" 처럼 빈 칸으로 나간다 —
 * 표기가 있는 것도 아니고 없는 것도 아닌 상태로 나가는 게 최악이다.
 * 수신거부 링크도 마찬가지다: 앱 주소가 기본값이면 우리 도메인이 아닌 곳을
 * 가리키는 링크를 수천 명에게 보낸다.
 *
 * 그래서 화면이 아니라 발송 함수가 막는다. 화면만 막으면 다른 경로로 새어 나간다.
 */
export interface Preflight {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  /** 오늘 이 발신 계정으로 보낼 수 있는 여유. 없으면 페이스 규칙이 없는 채널이다. */
  pace: pace.Budget | null;
}

export async function preflight(blastId: string): Promise<Preflight> {
  const b = await getBlast(blastId);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!b) return { ok: false, blockers: ["발송을 찾을 수 없습니다."], warnings, pace: null };

  const ch = channelSpec(b.channel);
  if (!b.body?.trim()) blockers.push("본문이 비어 있습니다.");
  if (!b.campaign_id || b.target_count === 0) blockers.push("대상이 확정되지 않았습니다.");

  // 같은 문장을 대량으로 보내는 것이 스팸으로 분류되는 가장 빠른 길이다. 막지는
  // 않되 발송 버튼 옆에서 보이게 한다.
  if (b.body?.trim()) warnings.push(...pace.diversityWarnings(b.subject, b.body));

  const policy = await policyFor(b.channel, b.is_ad);
  if (policy?.requires_optout) {
    const [postal, phone, baseUrl] = await Promise.all([
      settings.get("mail.postal"), settings.get("mail.phone"), settings.get("app.base_url"),
    ]);
    if (!postal.trim()) blockers.push("사업장 주소가 비어 있습니다 — 광고 메일 푸터에 법정 필수입니다 (설정 → 발신 정보).");
    if (!phone.trim()) blockers.push("연락처가 비어 있습니다 — 위와 같은 이유로 필수입니다.");

    const domain = await settings.get("mail.domain");
    if (domain && !baseUrl.includes(domain)) {
      blockers.push(
        `수신거부 링크가 ${baseUrl} 를 가리킵니다. 발송 도메인(${domain})과 달라 링크가 동작하지 않을 수 있습니다 (설정 → 앱 주소).`);
    }
  }

  let budget: pace.Budget | null = null;
  if (ch.auto) {
    const from = b.mailbox_email ?? (await defaultMailbox());
    if (!from) blockers.push("보낼 메일함이 없습니다 (설정 → 메일함).");
    if (!isSaConfigured()) {
      warnings.push("서비스 계정 키가 없어 전부 dry-run 으로 처리됩니다 — 실제로 나가지 않습니다.");
    }
    if (from) {
      budget = await pace.budget(b.channel, from, await settings.fromName());
      // 상한 도달은 blocker 가 아니다 — 오늘 몫을 이미 보냈다는 뜻이고, 내일 이어
      // 보내면 된다. 여기서 blocker 로 만들면 발송 자체가 실패한 것처럼 보인다.
      if (budget.blocked && budget.capToday === 0) blockers.push(budget.blocked);
      else if (budget.blocked) warnings.push(budget.blocked);
      else if (b.target_count > budget.remaining) {
        warnings.push(
          `대상 ${b.target_count.toLocaleString("ko-KR")}명 중 오늘은 ${budget.remaining}명까지 나갑니다 ` +
          `(${budget.reason}). 나머지는 내일 이어서 보내세요.`);
      }
    }
  }
  return { ok: blockers.length === 0, blockers, warnings, pace: budget };
}

/**
 * 발송 전 미리보기 — 실제로 나가는 그대로.
 *
 * 화면이 본문만 보여주면 (광고) 표기와 수신거부 푸터가 붙는 걸 모른다.
 * 발송 버튼을 누르는 자리에서 최종 결과물을 봐야 한다.
 */
export async function previewFinal(blastId: string): Promise<RenderedBlast | null> {
  const b = await getBlast(blastId);
  if (!b?.body?.trim()) return null;
  const sample = (await previewTargets(b.channel, b.filters, 1))[0];
  const org = await settings.get("mail.org");
  return renderForSend(b, {
    handle: sample?.handle ?? "example_handle",
    name: sample?.display_name ?? "홍길동",
    followers: sample?.followers ? sample.followers.toLocaleString("ko-KR") : "12,000",
    org,
  }, "cm_preview0", await policyFor(b.channel, b.is_ad));
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



