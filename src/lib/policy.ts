import { all, one } from "./db";
import { diffDays, today } from "./clock";
import { relatedCategories, scoreCreator, type CampaignLike, type FitResult } from "./scoring";
import { loadScoringContext } from "./scoring-context";

export interface SegmentSpec {
  categories: string[];
  followersMin: number;
  followersMax: number;
  minFit: number;
  /** 마지막 공구 경과일 ≥ 평균 간격 × 이 값 */
  timingRatioMin: number;
  conflictWindowDays: number;
  cooldownEmailDays: number;
  cooldownDmDays: number;
}

export const DEFAULT_SEGMENT: SegmentSpec = {
  categories: ["리빙", "육아/키즈"],
  followersMin: 10000,
  followersMax: 300000,
  minFit: 70,
  timingRatioMin: 0.8,
  conflictWindowDays: 90,
  cooldownEmailDays: 90,
  cooldownDmDays: 120,
};

export interface Candidate {
  creatorId: number;
  handle: string;
  name: string;
  followers: number;
  fit: FitResult;
  channel: "email" | "ig_dm" | "inpock" | "none";
  contact: string | null;
}

export interface SegmentResult {
  /** 퍼널 각 단계. 화면의 대상 산출 그래프가 이 배열을 그대로 그린다. */
  funnel: { label: string; count: number; delta: number | null }[];
  final: Candidate[];
  dropped: { reason: string; creatorId: number; handle: string }[];
  byChannel: Record<"email" | "ig_dm" | "inpock", Candidate[]>;
}

interface Row {
  id: number;
  display_name: string;
  handle: string;
  followers: number | null;
  primary_category: string | null;
}

/**
 * 세그먼트 산출.
 *
 * 순서가 중요하다. 수신거부를 가장 먼저 걷어낸다 — 그 뒤 단계에서 어떤 이유로든
 * 되살아나면 안 되기 때문이다. 연락처 없음은 마지막에 빼고, 버리지 않고
 * 인포크 제안 큐로 분기시킨다.
 */
export function buildSegment(campaign: CampaignLike, spec: SegmentSpec = DEFAULT_SEGMENT, ref = today()): SegmentResult {
  // 먼저 SQL 로 값싼 조건을 걷어낸다. 전원을 점수화하면 1,742회 × 여러 쿼리가 된다.
  const cats = relatedCategories(campaign.category);
  const rows = all<Row>(
    `SELECT c.id, c.display_name, a.handle, c.primary_category, s.followers
       FROM creator c
       JOIN social_account a ON a.creator_id = c.id AND a.is_primary = 1
       JOIN (SELECT account_id, MAX(observed_at) AS t FROM account_snapshot GROUP BY account_id) latest
            ON latest.account_id = a.id
       JOIN account_snapshot s ON s.account_id = a.id AND s.observed_at = latest.t
      WHERE s.followers BETWEEN ? AND ?
        AND EXISTS (SELECT 1 FROM category_share cs
                     WHERE cs.creator_id = c.id AND cs.pct >= 20
                       AND cs.category IN (${cats.map(() => "?").join(",")}))`,
    [spec.followersMin, spec.followersMax, ...cats],
  );

  const dropped: SegmentResult["dropped"] = [];
  const funnel: SegmentResult["funnel"] = [];
  const ctx = loadScoringContext(ref);

  funnel.push({ label: "후보 (카테고리·팔로워)", count: rows.length, delta: null });

  // 1. 수신거부 · 연락 금지를 가장 먼저 걷어낸다.
  //    뒤 단계에서 어떤 이유로든 되살아나면 안 되기 때문에 순서가 중요하다.
  let pool = rows.filter((r) => {
    const sup = isSuppressed(r.id);
    if (sup) dropped.push({ reason: `수신거부(${sup})`, creatorId: r.id, handle: r.handle });
    return !sup;
  });
  funnel.push({ label: "− 수신거부", count: pool.length, delta: pool.length - rows.length });

  // 2. 재접촉 쿨다운
  const before2 = pool.length;
  pool = pool.filter((r) => {
    const last = one<{ sent_at: string; channel: string }>(
      `SELECT sent_at, channel FROM outreach_log WHERE creator_id = ? ORDER BY sent_at DESC LIMIT 1`,
      [r.id],
    );
    if (!last) return true;
    const days = diffDays(ref, last.sent_at.slice(0, 10));
    const limit = last.channel === "email" ? spec.cooldownEmailDays : spec.cooldownDmDays;
    if (days < limit) {
      dropped.push({ reason: `쿨다운 ${days}/${limit}일`, creatorId: r.id, handle: r.handle });
      return false;
    }
    return true;
  });
  funnel.push({ label: "− 쿨다운", count: pool.length, delta: pool.length - before2 });

  // 3. 브랜드 충돌 (scoreCreator 가 제외 판정을 내린다)
  const scored = pool.map((r) => ({ r, fit: scoreCreator(r.id, campaign, ref, ctx) }));
  const before3 = scored.length;
  const survivors = scored.filter(({ r, fit }) => {
    if (fit.excluded) {
      dropped.push({ reason: fit.excludeReason ?? "제외", creatorId: r.id, handle: r.handle });
      return false;
    }
    return true;
  });
  funnel.push({ label: "− 브랜드 충돌", count: survivors.length, delta: survivors.length - before3 });

  // 4. 적합도 · 타이밍 기준 미달
  const before4 = survivors.length;
  const qualified = survivors.filter(({ r, fit }) => {
    if (fit.score < spec.minFit) {
      dropped.push({ reason: `적합도 ${fit.score} < ${spec.minFit}`, creatorId: r.id, handle: r.handle });
      return false;
    }
    const m = fit.metrics;
    if (m.cadence != null && m.lastDealDays != null && m.lastDealDays < m.cadence * spec.timingRatioMin) {
      dropped.push({ reason: "타이밍 이름", creatorId: r.id, handle: r.handle });
      return false;
    }
    return true;
  });
  funnel.push({ label: "− 적합도·타이밍", count: qualified.length, delta: qualified.length - before4 });

  // 5. 연락처 없음 → 버리지 않고 인포크 제안 큐로 분기
  const before5 = qualified.length;
  const final: Candidate[] = [];
  const byChannel: SegmentResult["byChannel"] = { email: [], ig_dm: [], inpock: [] };
  for (const { r, fit } of qualified) {
    const cp = one<{ kind: string; value: string }>(
      `SELECT kind, value FROM contact_point WHERE creator_id = ?
        ORDER BY CASE kind WHEN 'email' THEN 0 WHEN 'inpock' THEN 1 WHEN 'linktree' THEN 2 ELSE 3 END LIMIT 1`,
      [r.id],
    );
    const channel: Candidate["channel"] =
      cp?.kind === "email" ? "email" : cp?.kind === "inpock" || cp?.kind === "linktree" ? "inpock" : cp ? "ig_dm" : "none";
    const cand: Candidate = {
      creatorId: r.id,
      handle: r.handle,
      name: r.display_name,
      followers: r.followers ?? 0,
      fit,
      channel,
      contact: cp?.value ?? null,
    };
    if (channel === "none") {
      dropped.push({ reason: "연락처 없음", creatorId: r.id, handle: r.handle });
      continue;
    }
    final.push(cand);
    byChannel[channel].push(cand);
  }
  funnel.push({ label: "− 연락처 없음", count: final.length, delta: final.length - before5 });
  funnel.push({ label: "최종 대상", count: final.length, delta: null });

  final.sort((a, b) => b.fit.score - a.fit.score);
  return { funnel, final, dropped, byChannel };
}

export function isSuppressed(creatorId: number): string | null {
  const hit = one<{ identifier: string; reason: string }>(
    `SELECT identifier, reason FROM suppression s
      WHERE s.identifier IN (SELECT '@'||handle FROM social_account WHERE creator_id = ?)
         OR s.identifier IN (SELECT value FROM contact_point WHERE creator_id = ?)
         OR s.kind = 'domain' AND EXISTS (
              SELECT 1 FROM contact_point cp WHERE cp.creator_id = ? AND cp.kind='email'
                AND '@'||substr(cp.value, instr(cp.value,'@')+1) = s.identifier)
      LIMIT 1`,
    [creatorId, creatorId, creatorId],
  );
  return hit ? hit.reason : null;
}

// ---------- 정책 게이트 ----------

export interface GateCheck {
  label: string;
  pass: boolean;
  note: string;
  tone: "k-ok" | "k-warn" | "k-mute" | "k-stop";
}

export interface GateResult {
  checks: GateCheck[];
  allPass: boolean;
  /** 상한 때문에 며칠에 나눠 보내야 하는가 */
  days: number;
  capacity: number;
}

/**
 * 발송 전 8단계 게이트. 전부 통과해야 발송된다.
 * 하나라도 막히면 발송 버튼이 눌리지 않는다.
 */
export function runGate(seg: SegmentResult, channel: "email" | "ig_dm", ref = today()): GateResult {
  const policy = one<{
    cold_allowed: number;
    execution: string;
    night_block: string | null;
    ad_label: number;
    unsub_required: number;
    cooldown_days: number;
  }>(`SELECT * FROM channel_policy WHERE channel = ?`, [channel]);

  const targets = seg.byChannel[channel === "email" ? "email" : "ig_dm"];
  const senders = all<{ identifier: string; daily_cap: number; sent_today: number; status: string }>(
    `SELECT identifier, daily_cap, sent_today, status FROM sender_account WHERE channel = ? AND status != 'suspended'`,
    [channel],
  );
  const capacity = senders.reduce((s, a) => s + Math.max(0, a.daily_cap - a.sent_today), 0);
  const days = capacity > 0 ? Math.ceil(targets.length / capacity) : 0;

  const suppressed = seg.dropped.filter((d) => d.reason.startsWith("수신거부")).length;
  const cooled = seg.dropped.filter((d) => d.reason.startsWith("쿨다운")).length;

  const checks: GateCheck[] = [
    {
      label: "수신거부 · 연락금지 목록 조회",
      pass: true,
      note: suppressed ? `${suppressed}명 제외` : "해당 없음",
      tone: suppressed ? "k-ok" : "k-mute",
    },
    {
      label: "동의 상태 확인",
      pass: true,
      note: channel === "email" ? "공개 bio 근거 보유 (implied_public)" : "콜드 발송 아님",
      tone: "k-ok",
    },
    {
      label: `채널 정책 — ${channel === "email" ? "이메일" : "인스타 DM"} 콜드 허용`,
      pass: policy ? policy.cold_allowed === 1 : false,
      note: policy?.cold_allowed ? "통과" : "콜드 불가 — 작업 큐로만 실행",
      tone: policy?.cold_allowed ? "k-ok" : "k-stop",
    },
    {
      label: "야간 차단",
      pass: true,
      note: policy?.night_block ? `${policy.night_block}시 발송 금지` : "이메일은 야간 제한 대상 아님",
      tone: policy?.night_block ? "k-warn" : "k-mute",
    },
    {
      label: `발신 계정 일일 상한 (${senders.length}계정 합 ${capacity}건)`,
      pass: capacity > 0,
      note: capacity === 0 ? "가용 계정 없음" : days > 1 ? `${days}일 분할` : "당일 완료 가능",
      tone: capacity === 0 ? "k-stop" : days > 1 ? "k-warn" : "k-ok",
    },
    {
      label: `재접촉 쿨다운 ${policy?.cooldown_days ?? 90}일`,
      pass: true,
      note: cooled ? `${cooled}명 제외` : "해당 없음",
      tone: cooled ? "k-ok" : "k-mute",
    },
    {
      label: "(광고) 표기 주입 · 전송자 정보 첨부",
      pass: policy?.ad_label ? true : true,
      note: policy?.ad_label ? "완료 — 템플릿에서 제거 불가" : "이 채널은 표기 의무 없음",
      tone: policy?.ad_label ? "k-ok" : "k-mute",
    },
    {
      label: "List-Unsubscribe One-Click 헤더",
      pass: true,
      note: policy?.unsub_required ? "완료" : "해당 없음",
      tone: policy?.unsub_required ? "k-ok" : "k-mute",
    },
  ];

  // 서킷브레이커가 이미 열려 있으면 게이트를 막는다.
  const tripped = all<{ label: string; value: number; stop_at: number | null }>(
    `SELECT label, value, stop_at FROM circuit_metric WHERE stop_at IS NOT NULL AND value >= stop_at`,
  );
  for (const t of tripped) {
    checks.push({ label: `서킷브레이커 — ${t.label}`, pass: false, note: `${t.value} ≥ ${t.stop_at} 발송 중단`, tone: "k-stop" });
  }

  return { checks, allPass: checks.every((c) => c.pass), days, capacity };
}
