import { all, one } from "./db";
import { evaluate, type ChannelPolicy, type GateResult, type SuppressionRow } from "./policy-gate";
import { render, type Rendered } from "./template";

/**
 * 발송 대상 산출과 게이트 평가.
 *
 * 미리보기 화면과 실제 발송이 같은 코드를 쓴다. 화면에서 통과한 것이 실행에서 막히거나
 * 그 반대가 되면 담당자가 시스템을 믿지 않게 된다.
 */

export const MAIL = {
  orgName: process.env.MAIL_ORG_NAME ?? "Dinostudio (주)",
  address: process.env.MAIL_BASE_ADDRESS ?? "partner@dinostudio.kr",
  phone: process.env.MAIL_PHONE ?? "02-000-0000",
  postalAddress: process.env.MAIL_POSTAL ?? "서울시 성동구 …",
  unsubBase: process.env.UNSUB_BASE_URL ?? "http://localhost:3000/u",
};

export interface SendCandidate {
  member_id: string; creator_id: string; handle: string; display_name: string;
  contact_value: string | null; contact_norm: string | null; contact_channel: string | null; consent: string | null;
  last_contact_at: string | null; cadence: string | null; followers: number | null; last_brand: string | null;
}

export interface CampaignInfo {
  id: string; name: string; brand_name: string; category: string;
  commission_rate: string | null; sale_from: string | null; sale_to: string | null;
}

export interface SenderInfo {
  id: string; identifier: string; sent_today: number; current_cap: number;
  display_name: string | null; paused_until: string | null;
}

export async function loadCampaignInfo(campaignId: string) {
  return one<CampaignInfo>(
    `SELECT id, name, brand_name, category, commission_rate,
            to_char(sale_from,'YYYY-MM-DD') AS sale_from, to_char(sale_to,'YYYY-MM-DD') AS sale_to
       FROM campaign WHERE id=$1`,
    [campaignId],
  );
}

export async function loadSendCandidates(campaignId: string) {
  return all<SendCandidate>(
    `SELECT m.id AS member_id, c.id AS creator_id, sa.handle, c.display_name,
            cp.value AS contact_value, cp.value_norm AS contact_norm, cp.channel AS contact_channel,
            cp.consent_status AS consent,
            to_char(lc.last_contact_at,'YYYY-MM-DD') AS last_contact_at,
            v.avg_interval_days AS cadence, v.followers, lb.brand_name AS last_brand
       FROM campaign_member m
       JOIN creator c ON c.id=m.creator_id
       JOIN social_account sa ON sa.creator_id=c.id
       LEFT JOIN LATERAL (SELECT * FROM contact_point x WHERE x.creator_id=c.id
          ORDER BY CASE x.channel WHEN 'email' THEN 0 WHEN 'inpock_offer' THEN 1
                                  WHEN 'linktree_form' THEN 2 ELSE 3 END LIMIT 1) cp ON true
       LEFT JOIN LATERAL (SELECT max(msg.sent_at) AS last_contact_at FROM message msg
          JOIN campaign_member mm ON mm.id=msg.campaign_member_id
         WHERE mm.creator_id=c.id AND msg.direction='out') lc ON true
       LEFT JOIN LATERAL (SELECT * FROM account_snapshot s WHERE s.social_account_id=sa.id
          ORDER BY s.captured_at DESC LIMIT 1) v ON true
       LEFT JOIN LATERAL (SELECT b.name AS brand_name FROM deal d JOIN brand b ON b.id=d.brand_id
          WHERE d.creator_id=c.id ORDER BY d.open_date DESC NULLS LAST LIMIT 1) lb ON true
      WHERE m.campaign_id=$1 AND m.engine_state > 0`,
    [campaignId],
  );
}

export async function loadGateInputs() {
  const [policies, sups, brs, tpl, sender] = await Promise.all([
    all<ChannelPolicy>(`SELECT * FROM channel_policy`),
    all<SuppressionRow>(`SELECT identifier_type, identifier_val, channels, reason, expires_at FROM suppression`),
    all<{ metric: string; is_tripped: boolean; action: string }>(`SELECT metric, is_tripped, action FROM circuit_breaker`),
    one<{ id: string; subject: string | null; body: string; is_ad_content: boolean }>(
      `SELECT id, subject, body, is_ad_content FROM template
        WHERE channel='email' AND is_ad_content ORDER BY name LIMIT 1`),
    one<SenderInfo>(
      `SELECT id, identifier, sent_today, current_cap, display_name,
              to_char(paused_until,'YYYY-MM-DD HH24:MI') AS paused_until
         FROM sender WHERE channel='email' AND is_active
           AND (paused_until IS NULL OR paused_until < now())
         ORDER BY (current_cap - sent_today) DESC LIMIT 1`),
  ]);
  return { policies, sups, brs, tpl, sender };
}

export function buildVars(cand: SendCandidate, campaign: CampaignInfo, senderName: string) {
  return {
    name: cand.display_name,
    handle: cand.handle,
    category: campaign.category,
    brand: campaign.brand_name,
    product: campaign.name,
    commission: campaign.commission_rate != null ? String(Number(campaign.commission_rate)) : "협의",
    sale_from: campaign.sale_from ?? "",
    sale_to: campaign.sale_to ?? "",
    cadence: cand.cadence ? String(Math.round(Number(cand.cadence))) : "",
    last_gb_brand: cand.last_brand ?? "최근",
    sender_name: senderName,
    followers: cand.followers ? cand.followers.toLocaleString("ko-KR") : "",
    social_proof: "",
  };
}

export interface Evaluated {
  cand: SendCandidate;
  channel: string;
  policy: ChannelPolicy;
  gate: GateResult;
  rendered: Rendered | null;
  renderError: string | null;
}

/** 한 대상에 대해 렌더 + 게이트를 평가한다. 부수효과가 없어 미리보기에도 그대로 쓴다. */
export function evaluateCandidate(
  cand: SendCandidate,
  campaign: CampaignInfo,
  inputs: Awaited<ReturnType<typeof loadGateInputs>>,
  now = new Date(),
): Evaluated {
  const { policies, sups, brs, tpl, sender } = inputs;
  const isEmail = cand.contact_channel === "email";
  const channel = isEmail ? "email" : (cand.contact_channel ?? "instagram_dm");
  const policy = policies.find((p) => p.channel === channel) ?? policies.find((p) => p.channel === "instagram_dm")!;

  const unsubUrl = `${MAIL.unsubBase}/${cand.member_id}`;
  let rendered: Rendered | null = null;
  let renderError: string | null = null;
  try {
    rendered = render(
      { subject: tpl?.subject ?? null, body: tpl?.body ?? "제안 드립니다.", is_ad_content: tpl?.is_ad_content ?? true },
      buildVars(cand, campaign, sender?.display_name ?? "Dinostudio"),
      policy,
      { ...MAIL, unsubUrl, unsubMailto: MAIL.address, displayName: sender?.display_name ?? "Dinostudio" },
    );
  } catch (e) {
    renderError = (e as Error).message;
  }

  const gate = evaluate({
    channel,
    policy,
    contact: cand.contact_norm
      ? { value_norm: cand.contact_norm, consent_status: cand.consent ?? "none", channel }
      : null,
    creator: { id: cand.creator_id },
    handle: cand.handle,
    suppressions: sups,
    sender: isEmail && sender ? sender : null,
    lastContactAt: cand.last_contact_at,
    template: { is_ad_content: tpl?.is_ad_content ?? true },
    rendered: rendered ?? { subject: null, body: "", headers: {} },
    now,
    breakers: brs,
    mode: policy.automation_mode === "manual_task" ? "manual" : "auto",
  });

  if (renderError) gate.block("ad_label", renderError);
  return { cand, channel, policy, gate, rendered, renderError };
}
