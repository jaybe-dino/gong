/**
 * 정책 게이트 — 모든 발송은 여기를 통과한다.
 *
 * 채널이 늘어나도 컴플라이언스 로직이 채널별로 복제되지 않도록, 실행 레이어를 감싸는
 * 필터 하나로 둔다. 8단계 중 하나라도 실패하면 발송하지 않고 gate_block 에 사유를 남긴다.
 *
 *  G1  정보통신망법 §50②  수신거부 회피는 형사처벌
 *  G2  §50④              (광고) 표기 · 과태료 3천만원 이하
 *  G4  §50③              21:00~08:00 전송 제한 (이메일은 대상 아님)
 *  G12 Gmail 대량 발송자 요구사항  스팸률 0.30% 미만
 */

export const CHECKS = [
  "suppression", "consent", "channel_cold", "night_window",
  "sender_cap", "cooldown", "ad_label", "unsubscribe",
] as const;

export type CheckName = (typeof CHECKS)[number] | "circuit_breaker";

export interface PassRecord {
  check: CheckName;
  note: string;
}

export interface BlockRecord {
  check: CheckName;
  detail: string;
}

export class GateResult {
  passed: PassRecord[] = [];
  blocked: BlockRecord | null = null;
  warnings: string[] = [];

  pass(check: CheckName, note: string) {
    this.passed.push({ check, note });
    return this;
  }
  block(check: CheckName, detail: string) {
    this.blocked = { check, detail };
    return this;
  }
  get ok() {
    return this.blocked === null;
  }
}

export interface ChannelPolicy {
  channel: string;
  allows_cold: boolean;
  automation_mode: "auto" | "manual_task" | "disabled";
  night_block: boolean;
  night_from_hour: number;
  night_to_hour: number;
  requires_ad_label: boolean;
  requires_optout: boolean;
  default_daily_cap: number | null;
  cooldown_days: number;
}

export interface SuppressionRow {
  identifier_type: string;
  identifier_val: string;
  channels: string[] | null;
  reason: string;
  expires_at?: string | Date | null;
}

export interface SenderRow {
  id: string;
  identifier: string;
  sent_today: number;
  current_cap: number;
  paused_until?: string | Date | null;
}

export interface GateContext {
  channel: string;
  policy: ChannelPolicy | null | undefined;
  contact: { value_norm: string; consent_status: string; channel: string } | null;
  creator: { id: string } | null;
  handle?: string | null;
  /** 배열이 아니면 조회 실패로 보고 차단한다. */
  suppressions: SuppressionRow[] | null | undefined;
  sender?: SenderRow | null;
  lastContactAt?: string | Date | null;
  template?: { is_ad_content?: boolean } | null;
  rendered?: { subject?: string | null; body?: string; headers?: Record<string, string> };
  now?: Date;
  breakers?: { metric: string; is_tripped: boolean; action: string }[];
  /** 'manual' 이면 작업 큐 경로로 평가한다. */
  mode?: "auto" | "manual";
}

export function evaluate(ctx: GateContext): GateResult {
  const r = new GateResult();
  const now = ctx.now ?? new Date();
  const p = ctx.policy;
  if (!p) return r.block("channel_cold", `channel_policy 에 '${ctx.channel}' 정의가 없습니다`);

  // 0. 서킷브레이커 — 전역 차단이 최우선
  const tripped = (ctx.breakers ?? []).find(
    (b) => b.is_tripped && ["halt_all_sending", "pause_sending"].includes(b.action),
  );
  if (tripped) return r.block("circuit_breaker", `${tripped.metric} 임계 초과 · ${tripped.action}`);

  // 1. suppression 조회 — 조회 자체를 못 했어도 차단한다 (fail-closed)
  if (!Array.isArray(ctx.suppressions)) {
    return r.block("suppression", "suppression 조회 실패 · 안전을 위해 차단");
  }
  const hit = ctx.suppressions.find((s) => {
    if (s.expires_at && new Date(s.expires_at) < now) return false;
    const scoped = !s.channels || s.channels.length === 0 || s.channels.includes(ctx.channel);
    if (!scoped) return false;
    switch (s.identifier_type) {
      case "creator_id":
        return !!ctx.creator && s.identifier_val === ctx.creator.id;
      case "ig_handle":
        return !!ctx.handle && s.identifier_val.replace(/^@/, "") === ctx.handle;
      case "email":
      case "phone":
        return !!ctx.contact && s.identifier_val === ctx.contact.value_norm;
      case "email_domain":
        return !!ctx.contact && ctx.contact.value_norm.endsWith("@" + s.identifier_val.replace(/^@/, ""));
      default:
        return false;
    }
  });
  if (hit) return r.block("suppression", `${hit.identifier_type}=${hit.identifier_val} · ${hit.reason}`);
  r.pass("suppression", `${ctx.suppressions.length}건 대조 · 해당 없음`);

  // 2. 동의 상태 — 그 전에 이 채널로 닿을 연락처가 있는지부터
  if (!ctx.contact && p.automation_mode === "auto") {
    return r.block("consent", `'${ctx.channel}' 연락처가 없습니다. 다른 채널(작업 큐)로 분기하세요.`);
  }
  const consent = ctx.contact ? ctx.contact.consent_status : "none";
  if (consent === "opt_out") return r.block("consent", "이 연락처는 수신거부 상태입니다");
  if (!p.allows_cold && consent !== "opt_in" && p.automation_mode === "auto") {
    return r.block(
      "consent",
      `'${ctx.channel}' 은 콜드 자동 발송이 허용되지 않습니다. opt_in 만 통과합니다 (현재 '${consent}')`,
    );
  }
  if (!p.allows_cold && consent !== "opt_in") {
    r.warnings.push(`'${ctx.channel}' 은 콜드 자동 발송 불가 채널 · 사람이 처리하는 작업으로 생성됩니다`);
  }
  r.pass("consent", consent === "opt_in" ? "사전 동의 있음" : "공개 출처 근거 (implied_public)");

  // 3. 채널 실행 방식 — manual_task 채널은 자동 발송기가 건드리지 못한다
  if (p.automation_mode === "disabled") return r.block("channel_cold", "비활성화된 채널입니다");
  if (p.automation_mode === "manual_task" && ctx.mode !== "manual") {
    return r.block("channel_cold", `'${ctx.channel}' 은 작업 큐로만 실행됩니다. 자동 발송 불가.`);
  }
  r.pass("channel_cold", `allows_cold=${p.allows_cold} · ${p.automation_mode}`);

  // 4. 야간 차단 — 수신자 도달 시각 기준
  if (p.night_block && p.automation_mode === "manual_task") {
    r.pass("night_window", "작업 큐 · due_at 이 업무시간으로 잡힘");
  } else if (p.night_block) {
    const h = hourInKST(now);
    const from = p.night_from_hour;
    const to = p.night_to_hour;
    const inNight = from > to ? h >= from || h < to : h >= from && h < to;
    if (inNight) return r.block("night_window", `${from}:00~${to}:00 전송 제한 시간 (현재 ${h}시 KST)`);
    r.pass("night_window", `${h}시 KST · 허용 시간대`);
  } else {
    r.pass("night_window", "이메일은 야간 제한 대상 아님");
  }

  // 5. 발신 계정 상한
  if (p.automation_mode === "auto" || ctx.sender) {
    const s = ctx.sender;
    if (!s) return r.block("sender_cap", "사용 가능한 발신 계정이 없습니다");
    if (s.paused_until && new Date(s.paused_until) > now) {
      return r.block("sender_cap", `${s.identifier} 정지 중`);
    }
    if (s.sent_today >= s.current_cap) {
      return r.block("sender_cap", `${s.identifier} 오늘 상한 도달 (${s.sent_today}/${s.current_cap})`);
    }
    r.pass("sender_cap", `${s.identifier} ${s.sent_today}/${s.current_cap}`);
  } else {
    r.pass("sender_cap", "발신 계정 불필요");
  }

  // 6. 재접촉 쿨다운
  if (ctx.lastContactAt) {
    const days = Math.floor((now.getTime() - new Date(ctx.lastContactAt).getTime()) / 864e5);
    if (days < p.cooldown_days) {
      return r.block("cooldown", `${days}일 전 컨택 · 쿨다운 ${p.cooldown_days}일 미충족`);
    }
    r.pass("cooldown", `마지막 컨택 ${days}일 전`);
  } else {
    r.pass("cooldown", "이전 컨택 없음");
  }

  // 7. 광고 표기 — 렌더러가 이미 주입했는지 확인
  if (p.requires_ad_label && ctx.template?.is_ad_content) {
    const head = ctx.rendered?.subject || ctx.rendered?.body || "";
    if (!head.trimStart().startsWith("(광고)")) {
      return r.block("ad_label", "(광고) 표기가 주입되지 않았습니다");
    }
    r.pass("ad_label", "(광고) 표기 확인");
  } else {
    r.pass("ad_label", "광고성 정보 아님 또는 표기 불필요");
  }

  // 8. 수신거부 수단
  if (p.requires_optout) {
    const h = ctx.rendered?.headers ?? {};
    if (!h["List-Unsubscribe"]) return r.block("unsubscribe", "List-Unsubscribe 헤더가 없습니다");
    if (!h["List-Unsubscribe-Post"]) r.warnings.push("One-Click(RFC 8058) 헤더 권장");
    r.pass("unsubscribe", "List-Unsubscribe · One-Click");
  } else {
    r.pass("unsubscribe", "해당 없음");
  }

  return r;
}

/** 서버 TZ 와 무관하게 KST 기준 시각 */
export function hourInKST(d: Date): number {
  return (
    Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "numeric", hour12: false }).format(d),
    ) % 24
  );
}

export function inBusinessWindow(
  d: Date,
  { from = 9, to = 18, weekdaysOnly = true }: { from?: number; to?: number; weekdaysOnly?: boolean } = {},
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(d);
  const wd = parts.find((p) => p.type === "weekday")!.value;
  const h = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  if (weekdaysOnly && ["Sat", "Sun"].includes(wd)) return false;
  return h >= from && h < to;
}

/** 다음 업무시간 시작으로 밀기 */
export function nextBusinessSlot(d: Date, opts: { from?: number; to?: number; weekdaysOnly?: boolean } = {}): Date {
  const next = new Date(d);
  for (let i = 0; i < 24 * 14; i++) {
    if (inBusinessWindow(next, opts)) return next;
    next.setTime(next.getTime() + 3600e3);
  }
  return next;
}

export const CHECK_LABEL: Record<string, string> = {
  circuit_breaker: "서킷브레이커",
  suppression: "수신거부 · 연락금지 목록 조회",
  consent: "동의 상태 확인",
  channel_cold: "채널 정책 — 콜드 허용 여부",
  night_window: "야간 차단",
  sender_cap: "발신 계정 일일 상한",
  cooldown: "재접촉 쿨다운",
  ad_label: "(광고) 표기 주입",
  unsubscribe: "수신거부 수단 (List-Unsubscribe)",
};
