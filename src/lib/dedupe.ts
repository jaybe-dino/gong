/**
 * 크리에이터 중복 판정.
 *
 * 결정론 매칭 우선순위
 *   1. (source, source_pk) — 있으면 무조건 이것. 반드시 같은 소스끼리만 비교한다.
 *      팡팡의 account_id 9306 과 인공의 uuid 9306 은 다른 사람이다. 예전에는 두 값을
 *      social_account.platform_user_id 한 칸에 같이 넣고 소스 구분 없이 비교해서,
 *      번호가 겹치면 엉뚱한 사람으로 병합됐다 (샘플 데이터에서 실제로 발생).
 *   2. 정규화된 handle 완전 일치
 *   3. 구분자 제거 비교 키 일치 (@sooyeon.living vs @sooyeon_living)
 *   4. 퍼지 점수
 *
 * 점수 정책: ≥0.95 자동 병합 / 0.80~0.95 검토 큐 / 미만 신규
 */

import { comparisonKey, normalizeHandle } from "./handle";
import { normName } from "./parse";

export const AUTO_MERGE = 0.95;
export const REVIEW_MIN = 0.8;

/** 레벤슈타인 유사도 0~1 */
export function similarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return 1 - prev[n] / Math.max(m, n);
}

export interface Incoming {
  handle?: string | null;
  /** 그 소스 사이트 안에서의 식별자. 소스가 다르면 비교하지 않는다. */
  sourcePk?: string | null;
  displayName?: string | null;
  followers?: number | null;
  source?: string;
}

export interface Candidate {
  id: string;
  handle: string;
  /** { pangpang: "9306", ingong: "uuid…" } — source_ref 에서 모은다. */
  source_pks?: Record<string, string> | null;
  display_name?: string | null;
  followers?: number | null;
}

export interface MatchResult {
  score: number;
  evidence: string;
  deterministic: boolean;
  handleChanged?: boolean;
}

export function scoreMatch(incoming: Incoming, cand: Candidate): MatchResult {
  const ev: string[] = [];

  // 1. 같은 소스의 PK 동일 — 핸들이 달라도 같은 사람. 핸들 변경 신호.
  const candPk = incoming.source ? cand.source_pks?.[incoming.source] : undefined;
  if (incoming.sourcePk && candPk && String(incoming.sourcePk) === String(candPk)) {
    const changed = normalizeHandle(incoming.handle) !== normalizeHandle(cand.handle);
    ev.push(changed ? "소스 PK 동일 · 핸들 변경 추정" : "소스 PK 동일");
    return { score: 1, evidence: ev.join(" · "), deterministic: true, handleChanged: changed };
  }

  const hi = normalizeHandle(incoming.handle);
  const hc = normalizeHandle(cand.handle);

  // 2. 핸들 완전 일치
  if (hi && hc && hi === hc) {
    // 핸들이 같아도 표시명이 크게 다르면 사람이 봐야 한다 (동명이인 · 계정 양도)
    const ni = normName(incoming.displayName);
    const nc = normName(cand.display_name);
    if (ni && nc && ni !== nc && similarity(ni, nc) <= 0.7) {
      return { score: 0.94, evidence: "핸들 완전 일치 · 표시명 불일치 · 동명이인 가능", deterministic: false };
    }
    return { score: 1, evidence: "핸들 완전 일치", deterministic: true };
  }

  let score = 0;

  // 3. 구분자만 다름
  if (hi && hc && comparisonKey(hi) === comparisonKey(hc)) {
    score = 0.9;
    ev.push("구두점 차이만");
  } else if (hi && hc) {
    const s = similarity(hi, hc);
    if (s < 0.6) return { score: 0, evidence: "핸들 불일치", deterministic: false };
    score = 0.55 + s * 0.3;
    ev.push(`핸들 유사 ${s.toFixed(2)}`);
  } else {
    return { score: 0, evidence: "핸들 없음", deterministic: false };
  }

  // 표시명 보정
  const ni = normName(incoming.displayName);
  const nc = normName(cand.display_name);
  if (ni && nc) {
    if (ni === nc) {
      score += 0.06;
      ev.push("표시명 동일");
    } else if (similarity(ni, nc) > 0.7) {
      score += 0.03;
      ev.push("표시명 유사");
    } else {
      score -= 0.08;
      ev.push("표시명 불일치 · 동명이인 가능");
    }
  }

  // 팔로워 보정 — 차이가 크면 다른 사람일 확률이 높다
  const fi = incoming.followers;
  const fc = cand.followers;
  if (fi && fc) {
    const diff = Math.abs(fi - fc) / Math.max(fi, fc);
    if (diff <= 0.05) {
      score += 0.05;
      ev.push(`팔로워 오차 ${(diff * 100).toFixed(0)}%`);
    } else if (diff >= 0.35) {
      score -= 0.1;
      ev.push(`팔로워 차 ${(diff * 100).toFixed(0)}%`);
    }
  }

  score = Math.max(0, Math.min(1, score));
  return { score: Number(score.toFixed(2)), evidence: ev.join(" · "), deterministic: false };
}

/**
 * 후보 인덱스.
 *
 * 전수 비교는 O(n·m) 이다. 1.9만 행을 1.9만 명과 맞추면 3.6억 회 — 측정값 121초였고
 * 모집단이 커지면 더 길어진다. 서버리스 함수의 실행 시간 제한을 넘는다.
 *
 * 그래서 결정론 키는 해시로 바로 찾고, 퍼지 후보만 트라이그램 겹침으로 좁힌다.
 * scoreMatch 는 핸들 유사도가 0.6 미만이면 0 을 주고 끝낸다 — 0.6 이상이면
 * 트라이그램이 상당히 겹치므로, 겹침이 없는 후보를 버려도 판정이 달라지지 않는다.
 */
export interface CandidateIndex<C extends Candidate> {
  list: C[];
  byPk: Map<string, C[]>;
  byHandle: Map<string, C[]>;
  byCmp: Map<string, C[]>;
  byTrigram: Map<string, number[]>;
}

/** 퍼지 후보로 점수를 매길 최대 개수. 겹침이 많은 순으로 자른다. */
export const FUZZY_CANDIDATES = 40;

/**
 * 겹침 비율로 후보를 자르지 않는다.
 *
 * 유사도 0.6 이면 편집 거리가 길이의 40% 까지 허용되고, 편집 하나가 트라이그램
 * 3개를 깨뜨릴 수 있다. 길이 13 짜리 핸들이면 이론상 겹침이 0 까지 내려간다 —
 * 비율 하한을 두면 진짜 후보를 버린다. 테스트(전수 비교 동등성)가 이걸 잡았다.
 *
 * 대신 상위 K 선별을 정렬 없이 한다. 겹침 수는 트라이그램 개수 이하의 작은
 * 정수라 버킷으로 세면 선형이다.
 */

function trigrams(key: string | null): string[] {
  if (!key) return [];
  const padded = `  ${key} `;
  const out: string[] = [];
  for (let i = 0; i + 3 <= padded.length; i++) out.push(padded.slice(i, i + 3));
  return out;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const cur = m.get(k);
  if (cur) cur.push(v);
  else m.set(k, [v]);
}

export function buildIndex<C extends Candidate>(candidates: C[]): CandidateIndex<C> {
  const idx: CandidateIndex<C> = {
    list: candidates,
    byPk: new Map(),
    byHandle: new Map(),
    byCmp: new Map(),
    byTrigram: new Map(),
  };
  candidates.forEach((c, i) => {
    // 소스별로 키를 나눈다. "pangpang:9306" 과 "ingong:9306" 은 다른 버킷이다.
    for (const [src, pk] of Object.entries(c.source_pks ?? {})) {
      if (pk) push(idx.byPk, `${src}:${pk}`, c);
    }
    const h = normalizeHandle(c.handle);
    if (!h) return;
    push(idx.byHandle, h, c);
    const key = comparisonKey(h);
    if (!key) return;
    push(idx.byCmp, key, c);
    for (const g of new Set(trigrams(key))) push(idx.byTrigram, g, i);
  });
  return idx;
}

export interface BestMatch<C extends Candidate> {
  cand: C;
  m: MatchResult;
}

/**
 * 인덱스에서 가장 잘 맞는 후보 하나. 없으면 null.
 *
 * 단계별로 끊는다. 결정론 키(소스 PK · 핸들 완전 일치)가 맞으면 점수 1.0 이라
 * 더 나은 후보가 존재할 수 없으므로 즉시 반환하고 퍼지 후보를 아예 만들지 않는다.
 * 같은 파일을 다시 올리는 흔한 경우가 이 경로로 빠진다 — 트라이그램 겹침 집계는
 * 행당 수십~수백 후보를 훑기 때문에 이 단축이 크다.
 */
export function findBest<C extends Candidate>(
  idx: CandidateIndex<C>,
  incoming: Incoming,
): BestMatch<C> | null {
  const seen = new Set<C>();
  // 클로저 안에서 대입하므로 지역 변수로 두면 TS 가 흐름을 못 따라간다.
  const acc: { best: BestMatch<C> | null } = { best: null };
  const done = () => (acc.best && acc.best.m.score > 0 ? acc.best : null);

  /** 후보들을 점수 매긴다. 결정론이 나오면 그 즉시 알린다. */
  const consider = (cs: C[] | undefined): BestMatch<C> | null => {
    if (!cs) return null;
    for (const cand of cs) {
      if (seen.has(cand)) continue;
      seen.add(cand);
      const m = scoreMatch(incoming, cand);
      if (m.deterministic) return { cand, m };
      if (!acc.best || m.score > acc.best.m.score) acc.best = { cand, m };
    }
    return null;
  };

  if (incoming.sourcePk && incoming.source) {
    const hit = consider(idx.byPk.get(`${incoming.source}:${incoming.sourcePk}`));
    if (hit) return hit;
  }

  const h = normalizeHandle(incoming.handle);
  if (!h) return done();

  const exact = consider(idx.byHandle.get(h));
  if (exact) return exact;

  const key = comparisonKey(h);
  if (!key) return done();

  const punct = consider(idx.byCmp.get(key));
  if (punct) return punct;

  // 여기까지 왔으면 결정론 키가 없다. 트라이그램 겹침 상위 후보만 점수를 매긴다.
  const grams = new Set(trigrams(key));
  const overlap = new Map<number, number>();
  for (const g of grams) {
    const ids = idx.byTrigram.get(g);
    if (!ids) continue;
    for (const i of ids) overlap.set(i, (overlap.get(i) ?? 0) + 1);
  }
  // 겹침 수별 버킷 → 많은 쪽부터 K 개. 전체 정렬을 피한다.
  const buckets: number[][] = [];
  for (const [i, n] of overlap) (buckets[n] ??= []).push(i);
  const top: C[] = [];
  for (let n = buckets.length - 1; n >= 1 && top.length < FUZZY_CANDIDATES; n--) {
    for (const i of buckets[n] ?? []) {
      top.push(idx.list[i]);
      if (top.length >= FUZZY_CANDIDATES) break;
    }
  }
  const fuzzy = consider(top);
  if (fuzzy) return fuzzy;

  return done();
}

export type Verdict = "merge" | "review" | "new";

export function decide(score: number, deterministic = false): Verdict {
  if (deterministic || score >= AUTO_MERGE) return "merge";
  if (score >= REVIEW_MIN) return "review";
  return "new";
}

/**
 * 필드 서바이버십 — 같은 필드를 여러 소스가 줄 때 누구를 믿을지.
 *   팔로워/팔로잉/게시물     → pangpang (유일하게 3종 다 제공)
 *   30·90일 딜 수, 평균 간격 → ingong (직접 계산 없이 제공)
 *   브랜드/큐레이션          → momcal (유일한 정규화 브랜드 엔티티)
 */
export const FIELD_PRIORITY: Record<string, string[]> = {
  followers: ["pangpang", "ingong", "momcal", "manual"],
  following: ["pangpang", "manual"],
  posts_count: ["pangpang", "manual"],
  last_active_at: ["pangpang", "ingong", "manual"],
  deals_30d: ["ingong", "manual"],
  deals_90d: ["ingong", "manual"],
  avg_interval_days: ["ingong", "manual"],
  days_since_last: ["ingong", "manual"],
  category_share: ["ingong", "pangpang", "manual"],
  is_curated: ["momcal", "manual"],
  price_krw: ["pangpang", "manual"],
  open_at: ["pangpang", "momcal", "ingong"],
  brand: ["momcal", "pangpang", "ingong"],
};

export interface FieldCandidate<T> {
  source: string;
  value: T | null | undefined;
  observedAt?: string | Date | null;
}

export function survive<T>(field: string, candidates: FieldCandidate<T>[]): T | null {
  const order = FIELD_PRIORITY[field] ?? ["manual"];
  const usable = candidates.filter((c) => c.value !== null && c.value !== undefined && (c.value as unknown) !== "");
  if (!usable.length) return null;
  usable.sort((a, b) => {
    const ra = order.indexOf(a.source);
    const rb = order.indexOf(b.source);
    const pa = ra < 0 ? 99 : ra;
    const pb = rb < 0 ? 99 : rb;
    if (pa !== pb) return pa - pb;
    return new Date(b.observedAt ?? 0).getTime() - new Date(a.observedAt ?? 0).getTime();
  });
  return usable[0].value as T;
}
