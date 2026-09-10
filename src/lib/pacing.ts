import { all, one, run } from "./db";
import { hasColumn, hasTable } from "./schema";
import { getFlag } from "./settings";

/**
 * 발송 페이스 — 하루 상한 · 워밍업 증량 · 시간당 분산.
 *
 * 왜 필요한가: /blast 의 sendChunk 는 sender 테이블을 전혀 보지 않았다. 화면에서
 * 「발송」을 누르면 대상 전원이 한 번에 나갔다. 2주 된 도메인에서 1,000건을 하루에
 * 쏟으면 도메인이 타고, 그 뒤로는 무슨 문안을 써도 스팸함으로 간다. 기존 시퀀스
 * 경로(policy-gate 의 sender_cap)는 이걸 지키는데 blast 경로만 새어 있었다.
 *
 * 수치의 근거는 "계정이 얼마나 신뢰를 쌓았는지" 하나다. 공개 자료들이 공통으로
 * 말하는 것:
 *   · 콜드 메일: 신규 메일함은 1주차 5~10건/일에서 시작해 주당 5~10건씩 올린다.
 *     확립된 메일함도 콜드는 20~25건/일, 안전 상한 50~100건/일. Workspace 공식
 *     한도 2,000건/일은 콜드 발송과 아무 관계가 없다.
 *   · 인스타 DM: 신규(30일 미만)는 20~50건/일, 확립(180일+)은 150~200건/일.
 *     국내 자료는 정상 계정 1개당 1일 70건을 든다. 첫 주는 콜드 0건이 원칙이다.
 *   · 공통 금지: 어제의 2배를 오늘 보내는 것. 볼륨 급증이 도메인·계정이 찍히는
 *     가장 흔한 원인이고, 문안을 다양하게 써도 급증 자체가 신호가 된다.
 *
 * 그래서 상한을 사람이 입력하는 값으로 두지 않고 계정 나이에서 계산한다. 운영자가
 * 급할 때 숫자를 올리는 것이 정확히 사고가 나는 경로이기 때문이다. 올리고 싶으면
 * daily_cap(하드 실링)을 올리거나 warmup_on 을 끄는, 눈에 보이는 결정을 해야 한다.
 */

export interface PaceRule {
  channel: string;
  /** 계정 나이(일) 이상일 때의 하루 콜드 발송 상한. 큰 minAge 부터 본다. */
  ramp: { minAgeDays: number; cap: number }[];
  /** 한 시간에 몰아넣을 수 있는 최대 건수. 하루치를 한꺼번에 쏟는 것도 급증이다. */
  perHour: number;
  /** 건당 최소 간격(ms). 0 이면 간격을 두지 않는다. */
  gapMs: number;
}

/**
 * 단계 사이가 2배를 넘지 않게 끊었다. 5→10 은 두 배지만 그 구간의 절대량이
 * 작아서(하루 5건 → 10건) 급증 신호가 되지 않는다. 위로 갈수록 완만해진다.
 */
export const RULES: PaceRule[] = [
  {
    channel: "email",
    ramp: [
      { minAgeDays: 90, cap: 250 },
      { minAgeDays: 60, cap: 160 },
      { minAgeDays: 45, cap: 120 },
      { minAgeDays: 30, cap: 90 },
      { minAgeDays: 21, cap: 60 },
      { minAgeDays: 14, cap: 45 },
      { minAgeDays: 7, cap: 30 },
      { minAgeDays: 0, cap: 20 },
    ],
    perHour: 40,
    gapMs: 250,
  },
  {
    channel: "instagram_dm",
    ramp: [
      { minAgeDays: 180, cap: 80 },
      { minAgeDays: 90, cap: 70 },
      { minAgeDays: 60, cap: 60 },
      { minAgeDays: 30, cap: 50 },
      { minAgeDays: 21, cap: 40 },
      { minAgeDays: 14, cap: 30 },
      { minAgeDays: 7, cap: 20 },
      // DM 의 천장은 우리가 아니라 인스타그램이 정한다. 만든 지 얼마 안 된
      // 계정으로 여기까지 밀면 며칠 막히는 쪽이 정상이다.
      { minAgeDays: 0, cap: 10 },
    ],
    perHour: 15,
    gapMs: 0, // 사람이 직접 누르는 채널이라 간격은 사람 속도가 정한다
  },
];

/** 규칙이 없는 채널(인포크·인링크 등)은 사람이 손으로 하므로 넉넉히 둔다. */
export const MANUAL_RULE: PaceRule = {
  channel: "manual",
  ramp: [{ minAgeDays: 0, cap: 200 }],
  perHour: 40,
  gapMs: 0,
};

export function ruleFor(channel: string): PaceRule {
  return RULES.find((r) => r.channel === channel) ?? MANUAL_RULE;
}

/** 이 채널이 끝까지 올라갔을 때의 값. 새 발신 계정의 하드 실링 기본값이 된다. */
export function maxCap(channel: string): number {
  return Math.max(...ruleFor(channel).ramp.map((r) => r.cap));
}

/**
 * 계정 나이로 하루 상한을 뽑는다.
 *
 * 나이를 모르면(null) 0일로 본다 — 새 메일함을 등록하자마자 500건을 보내는 것보다
 * 5건에서 시작해 사람이 나이를 채워 넣는 쪽이 복구 가능한 실수다.
 */
export function rampCap(channel: string, ageDays: number | null): number {
  const age = Math.max(0, ageDays ?? 0);
  const rule = ruleFor(channel);
  for (const step of rule.ramp) if (age >= step.minAgeDays) return step.cap;
  return 0;
}

export interface SenderRow {
  id: string;
  channel: string;
  identifier: string;
  display_name: string | null;
  account_age_d: number | null;
  daily_cap: number;
  current_cap: number;
  sent_today: number;
  /**
   * 오늘 보낸 양. 날짜가 바뀌었으면 0 이다.
   *
   * 자정 롤오버를 SQL 에서 판단한다. Node 에서 sent_date 를 오늘 날짜 문자열과
   * 비교했더니 pg 가 date 를 Date 객체로 돌려주는 탓에 영원히 false 였고, 상한이
   * 청크 사이에 전혀 누적되지 않았다. 컨테이너와 Postgres 의 시간대가 다를 수
   * 있다는 문제도 같이 없어진다 — consume 도 CURRENT_DATE 를 쓴다.
   */
  sent_effective: number;
  warmup_on: boolean;
  paused_until: string | null;
  pause_reason: string | null;
  is_active: boolean;
}

const SELECT_SENDER = `
  SELECT *, CASE WHEN sent_date = CURRENT_DATE THEN sent_today ELSE 0 END AS sent_effective
    FROM sender WHERE identifier = $1`;

/**
 * 권장 상한을 실제로 적용할지.
 *
 * 기본은 꺼져 있다 — 워밍업은 가이드다. 화면에 권장치와 근거를 보여주되 발송을
 * 막지 않는다. 급한 발송을 시스템이 대신 판단해 세우면, 사람은 그 판단을 끄는
 * 방법부터 찾게 되고 결국 가드 전체가 꺼진 채로 남는다.
 *
 * 켜면 오늘 몫을 다 쓴 시점에서 실제로 멈춘다.
 */
export const ENFORCE_KEY = "send.enforce_cap";

export async function isEnforced(): Promise<boolean> {
  return getFlag(ENFORCE_KEY);
}

export interface Budget {
  senderId: string | null;
  identifier: string;
  /** 오늘 보낼 수 있는 총량. */
  capToday: number;
  /** 오늘 이미 보낸 양. 날짜가 바뀌었으면 0 으로 읽는다. */
  sentToday: number;
  /** 남은 여유. 0 이면 오늘은 끝이다. */
  remaining: number;
  /** 지금 이 순간 더 보낼 수 있는 양 (시간당 상한까지 반영). */
  allowedNow: number;
  /** 상한 계산의 근거. 화면에 그대로 보여준다. */
  reason: string;
  /**
   * 권장치를 넘었을 때 하고 싶은 말. 적용 여부와 무관하게 항상 채운다 —
   * 막지 않더라도 지금 권장선을 넘고 있다는 사실은 보여야 한다.
   */
  advice: string | null;
  /**
   * 실제로 발송을 세우는 이유. 적용이 꺼져 있으면 언제나 null 이다.
   * 이 값이 있을 때만 sendChunk 가 청크를 자른다.
   */
  blocked: string | null;
  /** 권장 상한을 실제로 적용하는 중인가. */
  enforced: boolean;
  gapMs: number;
}

const NO_SENDER: Omit<Budget, "identifier"> = {
  senderId: null, capToday: 0, sentToday: 0, remaining: 0, allowedNow: 0,
  reason: "", advice: "발신 계정이 등록되지 않았습니다", blocked: null,
  enforced: false, gapMs: 0,
};

/**
 * 메일함·계정에 대응하는 sender 행을 확보한다.
 *
 * /blast 는 mailbox 테이블에서 메일함을 고르는데 상한은 sender 에 있다. 둘을
 * 잇지 않으면 상한이 영원히 적용되지 않는다. 없으면 가장 보수적인 값으로 만든다.
 */
export async function ensureSender(
  channel: string, identifier: string, displayName?: string | null,
): Promise<SenderRow | null> {
  if (!identifier || !(await hasTable("sender"))) return null;

  const found = await one<SenderRow>(SELECT_SENDER, [identifier]);
  if (found) return found;

  // 하드 실링을 램프 꼭대기에 맞춘다. 스키마 기본값 75 를 그대로 두면 램프가
  // 250 까지 올라가도 75 에서 잘리고, 왜 안 오르는지 화면만 봐서는 알 수 없다.
  await run(
    `INSERT INTO sender (channel, identifier, display_name, current_cap, daily_cap, warmup_on)
     VALUES ($1,$2,$3,$4,$5,true)
     ON CONFLICT (identifier) DO NOTHING`,
    [channel, identifier, displayName ?? null, rampCap(channel, 0), maxCap(channel)]);
  const row = (await one<SenderRow>(SELECT_SENDER, [identifier])) ?? null;

  // mailbox 와 sender 를 이어 둔다. 끊어져 있으면 메일함 화면과 상한 화면이 서로
  // 다른 것을 보게 되고, 어느 쪽이 진짜인지 알 수 없어진다.
  if (row && (await hasTable("mailbox"))) {
    await run(
      `UPDATE mailbox SET sender_id=$2 WHERE email=$1 AND sender_id IS NULL`,
      [identifier, row.id]);
  }
  return row;
}

/** 시간당 상한을 보려면 최근 1시간에 몇 건 나갔는지 알아야 한다. */
async function sentLastHour(senderId: string): Promise<number> {
  if (!(await hasColumn("message", "sender_id"))) return 0;
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM message
      WHERE sender_id=$1 AND direction='out'
        AND sent_at > now() - interval '1 hour'`, [senderId]);
  return r?.n ?? 0;
}

/**
 * 지금 이 발신 계정으로 얼마나 보낼 수 있는가.
 *
 * 세 가지가 권장선을 만든다: 하루 상한 · 시간당 상한 · 일시정지 여부.
 * 가장 작은 값이 이긴다.
 *
 * 그 값을 실제로 강제할지는 별개다(ENFORCE_KEY). 기본은 강제하지 않는다 —
 * advice 에만 담고 blocked 는 비운다. 사용 중지·정지처럼 사람이 직접 세워 둔
 * 상태만 적용 여부와 무관하게 막는다.
 */
export async function budget(
  channel: string, identifier: string, displayName?: string | null,
): Promise<Budget> {
  const s = await ensureSender(channel, identifier, displayName);
  if (!s) return { ...NO_SENDER, identifier };

  const rule = ruleFor(channel);
  const enforced = await isEnforced();

  // 아래 둘은 워밍업 권장치가 아니라 사람이 직접 세워 둔 상태다. 가이드로 낮출
  // 성질의 것이 아니므로 적용 여부와 상관없이 막는다.
  if (!s.is_active) {
    return { ...NO_SENDER, senderId: s.id, identifier, gapMs: rule.gapMs, enforced,
             advice: `${identifier} 사용 중지 상태입니다`,
             blocked: `${identifier} 사용 중지 상태입니다` };
  }
  if (s.paused_until && new Date(s.paused_until) > new Date()) {
    const until = String(s.paused_until).slice(0, 16).replace("T", " ");
    const why = `${identifier} 정지 중 (${until}${s.pause_reason ? ` · ${s.pause_reason}` : ""})`;
    return { ...NO_SENDER, senderId: s.id, identifier, gapMs: rule.gapMs, enforced,
             advice: why, blocked: why };
  }

  // 워밍업을 끄면 하드 실링만 남는다 — 끄는 것 자체가 눈에 보이는 결정이어야 한다.
  const ramp = s.warmup_on ? rampCap(channel, s.account_age_d) : s.daily_cap;
  const capToday = Math.min(ramp, s.daily_cap);
  const reason = s.warmup_on
    ? `계정 ${s.account_age_d ?? 0}일 → 권장 상한 ${ramp}건` +
      (s.daily_cap < ramp ? ` (하드 실링 ${s.daily_cap}건이 더 낮음)` : "")
    : `워밍업 해제 · 하드 실링 ${s.daily_cap}건`;

  const sentToday = s.sent_effective;
  const remaining = Math.max(0, capToday - sentToday);

  const hour = await sentLastHour(s.id);
  const allowedNow = Math.max(0, Math.min(remaining, rule.perHour - hour));

  let advice: string | null = null;
  if (capToday === 0) {
    advice = `${identifier} 는 권장 상한이 0 입니다 (${reason})`;
  } else if (remaining === 0) {
    advice = `${identifier} 오늘 권장량 도달 (${sentToday}/${capToday}) — 내일 이어서 보내는 것을 권합니다`;
  } else if (allowedNow === 0) {
    advice = `${identifier} 시간당 권장량 도달 (최근 1시간 ${hour}/${rule.perHour}) — 잠시 뒤 이어서 보내는 것을 권합니다`;
  }

  return { senderId: s.id, identifier, capToday, sentToday, remaining, allowedNow,
           reason, advice, blocked: enforced ? advice : null, enforced,
           gapMs: rule.gapMs };
}

/**
 * 보낸 만큼 깎는다. 날짜가 바뀌었으면 1 부터 다시 센다.
 *
 * 발송 성공 직후에 부른다 — 미리 깎으면 실패한 건까지 상한을 먹는다.
 */
export async function consume(senderId: string, n = 1): Promise<void> {
  if (n <= 0) return;
  await run(
    `UPDATE sender
        SET sent_today = CASE WHEN sent_date = CURRENT_DATE THEN sent_today + $2 ELSE $2 END,
            sent_date  = CURRENT_DATE
      WHERE id = $1`,
    [senderId, n]);
}

/** 모든 발신 계정의 현재 상한. 설정 화면에 그대로 내린다. */
export async function overview(): Promise<(Budget & { channel: string; ageDays: number | null; hardCap: number; warmup: boolean })[]> {
  if (!(await hasTable("sender"))) return [];
  const rows = await all<SenderRow>(
    `SELECT channel, identifier, account_age_d, daily_cap, warmup_on
       FROM sender ORDER BY channel, identifier`);
  const out = [];
  for (const s of rows) {
    const b = await budget(s.channel, s.identifier);
    out.push({ ...b, channel: s.channel, ageDays: s.account_age_d,
               hardCap: s.daily_cap, warmup: s.warmup_on });
  }
  return out;
}

/**
 * 문안이 대량 발송에 안전한지 본다.
 *
 * 같은 문장을 수백 명에게 그대로 보내는 것이 스팸으로 분류되는 가장 빠른 길이다.
 * 막지는 않는다 — 문안 품질은 사람이 판단할 몫이고, 기계가 "이 문장은 스팸"이라고
 * 단정하면 틀렸을 때 되돌릴 방법이 없다. 대신 눈에 보이게 경고한다.
 */
export function diversityWarnings(subject: string | null, body: string): string[] {
  const w: string[] = [];
  const text = `${subject ?? ""}\n${body}`;

  const vars = new Set(text.match(/\{\{\s*([a-z_]+)\s*\}\}/gi) ?? []);
  if (vars.size === 0) {
    w.push("치환 변수가 없습니다 — 전원에게 완전히 동일한 문장이 나갑니다. " +
           "{{name}} 이나 {{handle}} 을 넣어 최소한 수신자를 부르게 하세요.");
  } else if (vars.size === 1) {
    w.push("치환 변수가 1개뿐입니다. 이름만 바뀌는 문장은 여전히 같은 문장으로 묶입니다.");
  }

  if (body.trim().length < 120) {
    w.push("본문이 짧습니다. 링크 위주의 짧은 메시지는 스팸 점수가 높습니다.");
  }

  const links = body.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  if (links.length > 3) {
    w.push(`링크가 ${links.length}개입니다. 3개 이하로 줄이는 것이 안전합니다.`);
  }

  const shorteners = links.filter((u) => /bit\.ly|tinyurl|goo\.gl|t\.co|is\.gd|buly\.kr/i.test(u));
  if (shorteners.length) {
    w.push("단축 URL 이 있습니다. 목적지를 숨기는 링크로 취급되어 필터가 강하게 반응합니다.");
  }

  if (/[A-Z]{6,}/.test(text) || /[!?]{3,}/.test(text)) {
    w.push("대문자 연속이나 느낌표 반복이 있습니다. 전형적인 스팸 표지입니다.");
  }

  const bait = ["무료", "공짜", "당첨", "지금 바로", "클릭", "대박", "최저가", "긴급"];
  const hits = bait.filter((k) => text.includes(k));
  if (hits.length >= 2) {
    w.push(`과장 표현이 여러 개 있습니다 (${hits.join("·")}). 표현을 낮추세요.`);
  }

  return w;
}
