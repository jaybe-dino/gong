import { one, tx } from "./db";
import { igUrl, normalizeHandle } from "./handle";
import { parseFollowers } from "./parse";
import { linkChannel, normalizeEmail, normalizePhone } from "./importer";
import { CATEGORY_KEYS } from "./score";

/**
 * 인플루언서 한 명 직접 등록.
 *
 * CSV 임포트는 수천 건을 한 번에 넣는 경로다. "지금 이 한 사람" 을 넣으려고
 * CSV 를 만들 사람은 없다 — 미팅에서 명함을 받거나 인바운드 문의가 오면
 * 그 자리에서 넣어야 한다.
 *
 * 연락처의 수집 출처는 스키마가 NOT NULL 로 강제한다(contact_point.source_type ·
 * source_url · collected_by). 소급이 불가능한 유일한 데이터라 그렇게 두었고,
 * 여기서도 예외를 두지 않는다 — 어디서 얻은 연락처인지 답할 수 없으면 저장되지
 * 않는다. 개인정보보호법 §20 조회 요청에 답할 수 있어야 한다.
 */

export const SOURCE_TYPES: { key: string; label: string }[] = [
  { key: "bio_public", label: "인스타 프로필 공개 정보" },
  { key: "link_page_public", label: "링크인바이오 공개 페이지" },
  { key: "inbound_apply", label: "인바운드 문의 · 지원" },
  { key: "business_card", label: "명함 · 대면 미팅" },
  { key: "referral", label: "소개 · 추천" },
];

export interface ManualInput {
  handle: string;
  displayName?: string;
  email?: string;
  phone?: string;
  kakao?: string;
  linkInBio?: string;
  inlinkUrl?: string;
  dmUrl?: string;
  followers?: string;
  category?: string;
  tier?: string;
  contactGrade?: string;
  hasGonggu?: boolean;
  note?: string;
  sourceType: string;
  sourceUrl?: string;
}

export interface ManualResult {
  ok: boolean;
  creatorId?: string;
  handle?: string;
  error?: string;
  /** 이미 있는 핸들이면 그 크리에이터로 보낸다 — 중복을 만들지 않는다. */
  existingId?: string;
}

export async function createManual(input: ManualInput, userId: string): Promise<ManualResult> {
  const handle = normalizeHandle(input.handle);
  if (!handle) {
    return { ok: false, error: "인스타 핸들이 올바르지 않습니다. 영문·숫자·밑줄·점만 쓸 수 있습니다." };
  }
  if (!SOURCE_TYPES.some((s) => s.key === input.sourceType)) {
    return { ok: false, error: "연락처 수집 출처를 고르세요. 출처 없이는 저장되지 않습니다." };
  }
  if (input.category && !CATEGORY_KEYS.includes(input.category)) {
    return { ok: false, error: `카테고리는 ${CATEGORY_KEYS.join(" · ")} 중에서 고르세요.` };
  }

  // 이미 있으면 새로 만들지 않는다. 같은 사람을 두 번 넣으면 두 번 보낸다.
  const dup = await one<{ creator_id: string }>(
    `SELECT creator_id FROM social_account WHERE platform='instagram' AND handle=$1`, [handle]);
  if (dup) {
    return { ok: false, error: `@${handle} 은 이미 등록돼 있습니다.`, existingId: dup.creator_id };
  }

  // 정규화는 임포터와 같은 함수를 쓴다. 판정이 갈리면 같은 사람이 두 경로에서
  // 다르게 저장된다.
  const email = input.email?.trim() ? normalizeEmail(input.email) : null;
  if (input.email?.trim() && !email) return { ok: false, error: "이메일 형식이 아닙니다." };

  const phone = input.phone?.trim() ? normalizePhone(input.phone) : null;
  if (input.phone?.trim() && !phone) {
    return { ok: false, error: "전화번호 형식이 아닙니다 (숫자 9~11자리)." };
  }

  const profileUrl = igUrl(handle);
  const sourceUrl = input.sourceUrl?.trim() || profileUrl;
  const followers = input.followers ? parseFollowers(input.followers)?.value ?? null : null;

  const creatorId = await tx(async (c) => {
    const cr = (await c.query<{ id: string }>(
      `INSERT INTO creator (display_name, primary_platform, outreach_tier, contact_grade,
                            has_gonggu_sign, notes)
       VALUES ($1,'instagram',$2,$3,$4,$5) RETURNING id`,
      [input.displayName?.trim() || handle, input.tier || null, input.contactGrade || null,
       Boolean(input.hasGonggu), input.note?.trim() || null],
    )).rows[0];

    const acc = (await c.query<{ id: string }>(
      `INSERT INTO social_account (creator_id, platform, handle, handle_raw, profile_url, dm_url)
       VALUES ($1,'instagram',$2,$3,$4,$5) RETURNING id`,
      [cr.id, handle, input.handle.trim(), profileUrl, input.dmUrl?.trim() || null],
    )).rows[0];

    // 연락처. 하나하나 출처를 같이 남긴다.
    const contacts: [string, string][] = [];
    if (email) contacts.push(["email", email]);
    if (phone) contacts.push(["phone", phone]);
    if (input.kakao?.trim()) contacts.push(["kakao", input.kakao.trim()]);
    if (input.inlinkUrl?.trim()) contacts.push(["inlink_form", input.inlinkUrl.trim()]);
    if (input.linkInBio?.trim()) {
      const ch = linkChannel(input.linkInBio);
      if (ch) contacts.push([ch, input.linkInBio.trim()]);
    }

    for (const [channel, value] of contacts) {
      await c.query(
        `INSERT INTO contact_point (creator_id, channel, value, value_norm, source_type, source_url,
                                    collected_at, collected_by, consent_status, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6, now(), $7, 'implied_public', true)
         ON CONFLICT (creator_id, channel, value_norm) DO NOTHING`,
        [cr.id, channel, value, value.toLowerCase(), input.sourceType, sourceUrl, userId]);
    }

    // 팔로워·카테고리는 스냅샷이다. 값이 하나도 없으면 빈 스냅샷을 만들지 않는다 —
    // 빈 스냅샷이 최신이 되면 나중에 들어온 실제 지표를 가린다.
    if (followers != null || input.category) {
      await c.query(
        `INSERT INTO account_snapshot (social_account_id, source, captured_at, followers, category_share)
         VALUES ($1, 'manual', now(), $2, $3::jsonb)`,
        [acc.id, followers, JSON.stringify(input.category ? { [input.category]: 100 } : {})]);
    }

    await c.query(
      `INSERT INTO source_ref (entity, entity_id, source, source_pk, source_url)
       VALUES ('creator',$1,'manual',$2,$3) ON CONFLICT DO NOTHING`,
      [cr.id, handle, sourceUrl]);

    await c.query(
      `INSERT INTO audit_log (actor_id, actor_kind, entity, entity_id, action, after)
       VALUES ($1,'user','creator',$2,'manual_create',$3)`,
      [userId, cr.id, JSON.stringify({ handle, contacts: contacts.map(([ch]) => ch), source: input.sourceType })]);

    return cr.id;
  });

  return { ok: true, creatorId, handle };
}
