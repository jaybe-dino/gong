import test from "node:test";
import assert from "node:assert/strict";
// 타입 전용 import 는 실행 시 제거된다. 동적 import 로 받은 D 는 값이라 타입에 못 쓴다.
import type { Incoming, MatchResult } from "../src/lib/dedupe.ts";

const H = await import("../src/lib/handle.ts");
const P = await import("../src/lib/parse.ts");
const D = await import("../src/lib/dedupe.ts");
const T = await import("../src/lib/template.ts");
const S = await import("../src/lib/score.ts");
const ST = await import("../src/lib/states.ts");
const G = await import("../src/lib/policy-gate.ts");
const { parseCsv, toObjects } = await import("../src/lib/csv.ts");
const { dealStatus, dday, occupiesSlot } = await import("../src/lib/deals.ts");

// ---------- 핸들 ----------

test("핸들 정규화 — URL · @ · 대소문자를 벗긴다", () => {
  assert.equal(H.normalizeHandle("@Sooyeon.Living"), "sooyeon.living");
  assert.equal(H.normalizeHandle("https://www.instagram.com/mom_dailylog/"), "mom_dailylog");
  assert.equal(H.normalizeHandle("  @haru.trip?utm=1 "), "haru.trip");
  assert.equal(H.normalizeHandle(""), null);
  // 인스타 핸들 규칙에 맞지 않으면 받지 않는다
  assert.equal(H.normalizeHandle("한글핸들"), null);
  assert.equal(H.normalizeHandle("a".repeat(31)), null);
});

test("비교 키는 구분자를 지운다 — 정규화와는 다른 용도다", () => {
  assert.equal(H.comparisonKey("@sooyeon.living"), "sooyeonliving");
  assert.equal(H.comparisonKey("sooyeon_living"), "sooyeonliving");
  assert.notEqual(H.normalizeHandle("sooyeon.living"), H.normalizeHandle("sooyeon_living"));
});

test("맘캘 슬러그는 . 과 _ 를 복원할 수 없다 — 후보만 만들고 경고한다", () => {
  const cands = H.slugCandidates("de-elisa-shop");
  assert.ok(cands.includes("de.elisa.shop"));
  assert.ok(cands.includes("de_elisa_shop"));
  assert.ok(cands.includes("de_elisa.shop"));
  assert.ok(cands.length >= 4, "구분자 조합이 모두 후보여야 한다");
  assert.match(H.slugWarning("de-elisa-shop")!, /매칭 키로 지정/);
  assert.equal(H.slugWarning("jinnykitchen"), null);
});

// ---------- 파서 ----------

test("팔로워 파싱 — 만 단위와 반올림 오차", () => {
  assert.deepEqual(P.parseFollowers("10.8만"), { value: 108000, precision: 500 });
  assert.deepEqual(P.parseFollowers("11만"), { value: 110000, precision: 5000 });
  assert.deepEqual(P.parseFollowers("팔로워10.8만"), { value: 108000, precision: 500 });
  assert.equal(P.parseFollowers("1,204")!.value, 1204);
  assert.equal(P.parseFollowers(""), null);
});

test('건수 파서 — "30일 35건" 에서 35 를 뽑는다 (30은 기간)', () => {
  assert.equal(P.parseCount("30일 35건"), 35);
  assert.equal(P.parseCount("90일 14건"), 14);
  assert.equal(P.parseCount("5"), 5);
  assert.equal(P.parseCount(""), null);
});

test("평균 간격 · 경과일 파싱", () => {
  assert.equal(P.parseFirstInt("평균 11일 간격"), 11);
  assert.equal(P.parseFirstInt("마지막 공구 19일 전"), 19);
});

test("기간 파싱 — 뒤쪽 연도를 앞쪽에서 물려받는다", () => {
  assert.deepEqual(P.parsePeriod("2026-09-01 ~ 09-07"), ["2026-09-01", "2026-09-07"]);
  assert.deepEqual(P.parsePeriod("2026-09-01 ~ 2026-09-07"), ["2026-09-01", "2026-09-07"]);
  assert.deepEqual(P.parsePeriod("상시"), [null, null]);
});

test("카테고리 점유율 파싱", () => {
  assert.deepEqual(P.parseCategoryShare("리빙 61%, 인테리어 22%"), { 리빙: 61, 인테리어: 22 });
  assert.deepEqual(P.parseCategoryShare('{"리빙":61}'), { 리빙: 61 });
  assert.deepEqual(P.parseCategoryShare(""), {});
});

test("상대시간 · 가격 파싱", () => {
  const now = new Date("2026-09-01T12:00:00Z");
  assert.equal(P.parseRelativeTime("약 1시간 전", now)!.toISOString(), "2026-09-01T11:00:00.000Z");
  assert.equal(P.parseRelativeTime("방금", now)!.toISOString(), now.toISOString());
  assert.equal(P.parsePrice("89,000원"), 89000);
});

test("부재중 자동응답 판별 — 답장으로 세면 회신율이 부풀고 시퀀스가 잘못 멈춘다", () => {
  assert.equal(P.isAutoReply("자동 회신", "휴가 중입니다"), true);
  assert.equal(P.isAutoReply("Out of Office", null), true);
  assert.equal(P.isAutoReply("RE: 제안", "네 좋습니다! 진행할게요"), false);
});

test("복귀일 추출", () => {
  assert.equal(P.parseReturnDate("9월 8일부터 복귀합니다", new Date("2026-09-01")), "2026-09-08");
  assert.equal(P.parseReturnDate("2026-09-10 복귀"), "2026-09-10");
  assert.equal(P.parseReturnDate("연락 주세요"), null);
});

// ---------- CSV ----------

test("CSV 파서 — 따옴표 안의 쉼표·개행·이스케이프", () => {
  const rows = parseCsv('a,b\n"1,000","줄1\n줄2"\n');
  assert.deepEqual(rows, [["a", "b"], ["1,000", "줄1\n줄2"]]);
  assert.equal(toObjects(rows).records[0].a, "1,000");
  assert.equal(parseCsv('﻿name\n"그는 ""안녕"" 이라 했다"')[1][0], '그는 "안녕" 이라 했다');
});

// ---------- 중복 판정 ----------

test("같은 소스의 PK 가 같으면 핸들이 달라도 같은 사람 — 핸들 변경 신호", () => {
  const m = D.scoreMatch(
    { handle: "joo0.is.happy", sourcePk: "9306", source: "pangpang", displayName: "주영이네" },
    { id: "x", handle: "hi.iamjoo0", source_pks: { pangpang: ["9306"] }, display_name: "주영이네" },
  );
  assert.equal(m.score, 1);
  assert.equal(m.deterministic, true);
  assert.equal(m.handleChanged, true);
});

test("소스가 다르면 PK 번호가 겹쳐도 같은 사람이 아니다", () => {
  // 팡팡의 account_id 9306 과 인공의 uuid 9306 은 서로 무관한 번호다.
  // 예전에는 두 값을 한 칸에 넣고 소스 구분 없이 비교해 엉뚱한 병합이 났다.
  const m = D.scoreMatch(
    { handle: "aaa.bbb", sourcePk: "9306", source: "ingong", displayName: "가나다" },
    { id: "x", handle: "zzz.qqq", source_pks: { pangpang: ["9306"] }, display_name: "하마루" },
  );
  assert.equal(m.deterministic, false);
  assert.equal(m.score, 0, "핸들도 다르니 후보가 아니다");

  const idx = D.buildIndex([
    { id: "p", handle: "zzz.qqq", source_pks: { pangpang: ["9306"] }, display_name: "하마루" },
  ]);
  assert.equal(D.findBest(idx, { handle: "aaa.bbb", sourcePk: "9306", source: "ingong" }), null);
  assert.ok(D.findBest(idx, { handle: "aaa.bbb", sourcePk: "9306", source: "pangpang" }), "같은 소스면 잡는다");
});

test("구두점만 다르면 병합 후보, 표시명이 다르면 검토로 내려간다", () => {
  const same = D.scoreMatch(
    { handle: "livingnote.k", displayName: "리빙노트", followers: 62000 },
    { id: "y", handle: "livingnote_k", display_name: "리빙노트", followers: 62000 },
  );
  assert.equal(D.decide(same.score, same.deterministic), "merge");

  // 구두점이 다르면 서로 다른 계정일 수 있다 — 표시명까지 다르면 사람이 본다.
  const diff = D.scoreMatch(
    { handle: "livingnote.k", displayName: "전혀다른이름", followers: 62000 },
    { id: "y", handle: "livingnote_k", display_name: "리빙노트", followers: 62000 },
  );
  assert.equal(D.decide(diff.score, diff.deterministic), "review");

  // 핸들이 완전히 같으면 같은 계정이다 — 같은 플랫폼에서 핸들은 고유하다.
  // 표시명이 달라도 병합하고, 그 사실만 근거에 남긴다. 실제 데이터에서 이걸
  // 검토 큐로 보냈더니 한 번의 임포트에 772건이 쌓였다 — 그러면 아무도 안 본다.
  const renamed = D.scoreMatch(
    { handle: "livingnote.k", displayName: "전혀다른이름", followers: 62000 },
    { id: "y", handle: "livingnote.k", display_name: "리빙노트", followers: 62000 },
  );
  assert.equal(D.decide(renamed.score, renamed.deterministic), "merge");
  assert.equal(renamed.nameChanged, true);
  assert.match(renamed.evidence, /표시명 변경/);
});

test("전혀 다른 핸들은 신규", () => {
  const m = D.scoreMatch({ handle: "nara_home" }, { id: "x", handle: "beauty_log_h" });
  assert.equal(D.decide(m.score, m.deterministic), "new");
});

test("필드 서바이버십 — 소스마다 믿을 필드가 다르다", () => {
  assert.equal(D.survive("followers", [
    { source: "ingong", value: 60000 }, { source: "pangpang", value: 62000 },
  ]), 62000, "팔로워는 공구팡팡");
  assert.equal(D.survive("avg_interval_days", [
    { source: "pangpang", value: 12 }, { source: "ingong", value: 9 },
  ]), 9, "케이던스는 인공");
  assert.equal(D.survive("is_curated", [
    { source: "pangpang", value: false }, { source: "momcal", value: true },
  ]), true, "큐레이션은 맘캘린더");
  assert.equal(D.survive("followers", [{ source: "pangpang", value: null }]), null);
});

// ---------- 적합도 ----------

test("적합도 — 팔로워는 점수 축이 아니다", () => {
  const base = { deals30d: 6, credibility: 80, engagementRate: 0.03, categoryShare: { 리빙: 60 }, reach: "email" as const, emailVerified: true };
  const small = S.fitScore({ ...base }, { category: "리빙" });
  const huge = S.fitScore({ ...base }, { category: "리빙" });
  assert.equal(small.score, huge.score, "팔로워는 입력에 아예 없다");
  assert.equal(small.breakdown.activity, 40, "30일 6건이면 실적 만점");
  assert.equal(small.breakdown.category, 20, "완전일치 20");
  assert.equal(small.breakdown.reach, 15, "이메일 검증 15");
});

test("적합도 — 진성 팔로워 50% 미만이면 품질 점수 0", () => {
  const r = S.fitScore(
    { deals30d: 3, credibility: 42, engagementRate: 0.06, categoryShare: { 리빙: 60 }, reach: "email" },
    { category: "리빙" },
  );
  assert.equal(r.breakdown.quality, 0);
  assert.match(r.notes.join(" "), /진성 팔로워 42%/);
});

test("적합도 — 마지막 공구 120일 초과면 실적 절반", () => {
  const fresh = S.fitScore({ deals30d: 6, daysSinceLast: 10 }, {});
  const stale = S.fitScore({ deals30d: 6, daysSinceLast: 200 }, {});
  assert.equal(fresh.breakdown.activity, 40);
  assert.equal(stale.breakdown.activity, 20);
  assert.match(stale.notes.join(" "), /50% 감쇠/);
});

test("적합도 — 브랜드 충돌 30일 이내는 점수와 무관하게 제외", () => {
  const excl = S.fitScore({ deals30d: 6, brandConflictDays: 12, brandConflictName: "라누보" }, { category: "리빙" });
  assert.equal(excl.excluded, true);
  assert.equal(excl.score, 0);
  assert.match(excl.reason!, /라누보 12일 전/);

  assert.equal(S.fitScore({ deals30d: 6, brandConflictDays: 47 }, {}).breakdown.penalty, -15);
  assert.equal(S.fitScore({ deals30d: 6, brandConflictDays: 88 }, {}).breakdown.penalty, -5);
  assert.equal(S.fitScore({ deals30d: 6, brandConflictDays: 120 }, {}).breakdown.penalty, 0);
});

test("적합도 — 슬롯 3건 이상이면 감점, suppression 이면 즉시 제외", () => {
  assert.equal(S.fitScore({ deals30d: 3, activeSlots: 3 }, {}).breakdown.penalty, -8);
  const sup = S.fitScore({ deals30d: 6, suppressed: true }, {});
  assert.equal(sup.excluded, true);
  assert.equal(sup.reason, "suppression 등재");
});

test("카테고리 — 인접은 부분 인정", () => {
  const direct = S.fitScore({ categoryShare: { 리빙: 40 } }, { category: "리빙" });
  const adj = S.fitScore({ categoryShare: { 인테리어: 40 } }, { category: "리빙" });
  const none = S.fitScore({ categoryShare: { 뷰티: 40 } }, { category: "리빙" });
  assert.equal(direct.breakdown.category, 20);
  assert.equal(adj.breakdown.category, 12);
  assert.equal(none.breakdown.category, 0);
});

test("타이밍 — 0.8~2.2 배가 적기", () => {
  assert.equal(S.timing({ avgIntervalDays: 10, daysSinceLast: 10 }).ready, true);
  assert.equal(S.timing({ avgIntervalDays: 10, daysSinceLast: 8 }).ready, true);
  assert.equal(S.timing({ avgIntervalDays: 10, daysSinceLast: 5 }).ready, false);
  assert.equal(S.timing({ avgIntervalDays: 10, daysSinceLast: 5 }).daysToWait, 3);
  assert.match(S.timing({ avgIntervalDays: 10, daysSinceLast: 30 }).label, /휴면/);
  assert.equal(S.timing({ avgIntervalDays: null, daysSinceLast: 5 }).ready, false);
});

test("티어는 분류 축", () => {
  assert.equal(S.tierOf(5000), "nano");
  assert.equal(S.tierOf(62000), "micro");
  assert.equal(S.tierOf(200000), "mid");
  assert.equal(S.tierOf(900000), "macro");
  assert.equal(S.tierOf(62000, true), "agency");
});

// ---------- 상태 3축 ----------

test("자동화는 종결 상태에서 되돌아가지 않는다", () => {
  assert.equal(ST.canTransition(ST.ENGINE.IN_SEQUENCE, ST.ENGINE.REPLIED), true);
  assert.equal(ST.canTransition(ST.ENGINE.REPLIED, ST.ENGINE.IN_SEQUENCE), false);
  assert.equal(ST.canTransition(ST.ENGINE.REPLIED, ST.ENGINE.IN_SEQUENCE, { manual: true }), true);
  assert.equal(ST.isTerminal(ST.ENGINE.OPTED_OUT), true);
  assert.equal(ST.isLive(ST.ENGINE.PAUSED_OOO), true);
});

test("회신 분류의 부수효과", () => {
  assert.deepEqual(ST.interestEffects(ST.INTEREST.SCHEDULED), { stage: "agreed", issueToken: true });
  assert.equal(ST.interestEffects(ST.INTEREST.LATER).requeueAfterDays, 180, "지금은 아님은 이탈이 아니다");
  assert.equal(ST.interestEffects(ST.INTEREST.DO_NOT_CONTACT).suppress?.permanent, true);
  assert.equal(ST.interestEffects(ST.INTEREST.OOO).engineState, ST.ENGINE.PAUSED_OOO);
  assert.equal(ST.interestEffects(ST.INTEREST.WRONG_CONTACT).needsNewContact, true);
});

// ---------- 템플릿 ----------

const POLICY = { requires_ad_label: true, requires_optout: true };
const SENDER = {
  orgName: "Dinostudio (주)", address: "partner@dinostudio.kr", phone: "02-000-0000",
  postalAddress: "서울시 성동구", unsubUrl: "https://x.kr/u/abc", unsubMailto: "unsub@dinostudio.kr",
};

test("(광고) 표기와 수신거부는 렌더러가 붙인다 — 템플릿에서 지울 수 없다", () => {
  const r = T.render({ subject: "{{name}}님 제안", body: "본문", is_ad_content: true }, { name: "리빙노트" }, POLICY, SENDER);
  assert.ok(r.subject!.startsWith("(광고) "));
  assert.match(r.body, /수신을 원하지 않으시면/);
  assert.equal(r.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("광고 표기 변칙은 렌더러가 거부한다", () => {
  assert.throws(() => T.render({ body: "(광/고) 제안", is_ad_content: true }, {}, POLICY, SENDER), /변칙/);
  assert.throws(() => T.render({ body: "[AD] 제안", is_ad_content: true }, {}, POLICY, SENDER), /변칙/);
  assert.equal(T.hasBannedAdLabel("(광고) 정상"), false);
});

test("치환되지 않은 변수는 경고로 남는다", () => {
  const r = T.render({ body: "{{name}}님 {{unknown}}", is_ad_content: false }, { name: "A" }, null, SENDER);
  assert.match(r.warnings.join(" "), /unknown/);
});

test("spintax 는 수신자마다 다른 문장을 만든다", () => {
  const first = T.spin("{{RANDOM|안녕하세요|반갑습니다}}!", () => 0);
  const second = T.spin("{{RANDOM|안녕하세요|반갑습니다}}!", () => 0.9);
  assert.equal(first, "안녕하세요!");
  assert.equal(second, "반갑습니다!");
});

// ---------- 게이트 ----------

const EMAIL_POLICY = {
  channel: "email", allows_cold: true, automation_mode: "auto" as const, night_block: false,
  night_from_hour: 21, night_to_hour: 8, requires_ad_label: true, requires_optout: true,
  default_daily_cap: 75, cooldown_days: 90,
};
const DM_POLICY = { ...EMAIL_POLICY, channel: "instagram_dm", allows_cold: false, automation_mode: "manual_task" as const, night_block: true, requires_ad_label: false, requires_optout: false };
const OK_CTX = {
  channel: "email", policy: EMAIL_POLICY,
  contact: { value_norm: "a@b.com", consent_status: "implied_public", channel: "email" },
  creator: { id: "c1" }, handle: "living_note", suppressions: [],
  sender: { id: "s1", identifier: "partner@", sent_today: 10, current_cap: 75, paused_until: null },
  lastContactAt: null, template: { is_ad_content: true },
  rendered: { subject: "(광고) 제안", body: "본문", headers: { "List-Unsubscribe": "<x>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } },
  breakers: [], now: new Date("2026-09-01T05:00:00Z"),
};

test("게이트 — 정상 조건은 8단계를 모두 통과한다", () => {
  const r = G.evaluate(OK_CTX);
  assert.equal(r.ok, true, r.blocked?.detail);
  assert.ok(r.passed.length >= 8, `통과 ${r.passed.length}단계`);
});

test("게이트 — suppression 조회에 실패해도 차단한다 (fail-closed)", () => {
  const r = G.evaluate({ ...OK_CTX, suppressions: null });
  assert.equal(r.ok, false);
  assert.equal(r.blocked!.check, "suppression");
  assert.match(r.blocked!.detail, /조회 실패/);
});

test("게이트 — 수신거부 등재자는 막힌다", () => {
  const r = G.evaluate({
    ...OK_CTX,
    suppressions: [{ identifier_type: "ig_handle", identifier_val: "living_note", channels: [], reason: "dnc_request" }],
  });
  assert.equal(r.blocked!.check, "suppression");
});

test("게이트 — 도메인 차단도 잡는다", () => {
  const r = G.evaluate({
    ...OK_CTX,
    suppressions: [{ identifier_type: "email_domain", identifier_val: "b.com", channels: [], reason: "unsubscribe" }],
  });
  assert.equal(r.blocked!.check, "suppression");
});

test("게이트 — 콜드 불가 채널은 자동 발송으로 통과할 수 없다", () => {
  const r = G.evaluate({ ...OK_CTX, channel: "instagram_dm", policy: DM_POLICY, mode: "auto" });
  assert.equal(r.ok, false);
  assert.equal(r.blocked!.check, "channel_cold");
  // 작업 큐 경로로는 통과한다 — 큐가 존재하는 이유다
  const manual = G.evaluate({ ...OK_CTX, channel: "instagram_dm", policy: DM_POLICY, mode: "manual" });
  assert.equal(manual.ok, true, manual.blocked?.detail);
});

test("게이트 — 발신 계정 상한과 쿨다운", () => {
  const capped = G.evaluate({ ...OK_CTX, sender: { ...OK_CTX.sender, sent_today: 75, current_cap: 75 } });
  assert.equal(capped.blocked!.check, "sender_cap");

  const cooled = G.evaluate({ ...OK_CTX, lastContactAt: "2026-08-20" });
  assert.equal(cooled.blocked!.check, "cooldown");
  assert.match(cooled.blocked!.detail, /쿨다운 90일/);
});

test("게이트 — (광고) 표기와 수신거부 헤더가 없으면 막힌다", () => {
  const noAd = G.evaluate({ ...OK_CTX, rendered: { ...OK_CTX.rendered, subject: "제안드립니다" } });
  assert.equal(noAd.blocked!.check, "ad_label");

  const noUnsub = G.evaluate({ ...OK_CTX, rendered: { ...OK_CTX.rendered, headers: {} } });
  assert.equal(noUnsub.blocked!.check, "unsubscribe");
});

test("게이트 — 서킷브레이커가 최우선으로 막는다", () => {
  const r = G.evaluate({ ...OK_CTX, breakers: [{ metric: "spam_rate", is_tripped: true, action: "halt_all_sending" }] });
  assert.equal(r.blocked!.check, "circuit_breaker");
});

test("야간 차단은 KST 기준이고 이메일은 대상이 아니다", () => {
  // 2026-09-01T13:00Z = 22시 KST
  const night = new Date("2026-09-01T13:00:00Z");
  assert.equal(G.hourInKST(night), 22);
  const dm = G.evaluate({ ...OK_CTX, channel: "instagram_dm", policy: { ...DM_POLICY, automation_mode: "auto" }, mode: "auto", now: night });
  assert.ok(["channel_cold", "consent", "night_window"].includes(dm.blocked!.check));
  const email = G.evaluate({ ...OK_CTX, now: night });
  assert.equal(email.ok, true, "이메일은 야간 제한 대상이 아니다");
});

test("업무시간 슬롯 — 주말과 야간은 다음 평일 09시로 밀린다", () => {
  const sat = new Date("2026-09-05T02:00:00Z"); // 토 11시 KST
  const slot = G.nextBusinessSlot(sat);
  assert.equal(G.inBusinessWindow(slot), true);
});

// ---------- 딜 상태 ----------

test("상시 공구는 D-DAY 집계와 슬롯 계산에서 빠진다", () => {
  const always = { starts_on: null, ends_on: null, is_always_on: 1 };
  assert.equal(dealStatus(always, "2026-09-01"), "always");
  assert.equal(dday(always, "2026-09-01").label, "상시");
  assert.equal(occupiesSlot(always, "2026-09-01"), false);

  const live = { starts_on: "2026-09-01", ends_on: "2026-09-07", is_always_on: 0 };
  assert.equal(occupiesSlot(live, "2026-09-03"), true);
  assert.equal(dday(live, "2026-09-07").label, "오늘 마감");
  assert.equal(dday(live, "2026-09-04").label, "D-3");
});

// ---------- 중복 판정 인덱스 ----------

/** 결정론 난수. 테스트가 돌 때마다 다른 모집단을 보면 실패를 재현할 수 없다. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function population(n: number, seed = 7) {
  const r = prng(seed);
  const p = (a: string[]) => a[Math.floor(r() * a.length)];
  const A = ["sooyeon", "mom", "baby", "living", "kitchen", "haru", "jinny", "nara", "dabin", "hyun"];
  const B = ["living", "diary", "note", "room", "table", "log", "pick", "shop", "market"];
  const out = [];
  for (let i = 0; i < n; i++) {
    const h = `${p(A)}${p([".", "_", ""])}${p(B)}${i}`;
    out.push({
      id: `c${i}`,
      handle: h,
      source_pks: { pangpang: [String(900000 + i)] },
      display_name: `${p(A)}맘`,
      followers: Math.floor(r() * 300000) + 3000,
    });
  }
  return out;
}

/** 인덱스 도입 전의 방식 — 후보 전체를 훑는다. */
function bruteForce(cands: ReturnType<typeof population>, incoming: Incoming) {
  let best: { cand: (typeof cands)[number]; m: MatchResult } | null = null;
  for (const cand of cands) {
    const m = D.scoreMatch(incoming, cand);
    if (!best || m.score > best.m.score) best = { cand, m };
    if (m.deterministic) break;
  }
  return best && best.m.score > 0 ? best : null;
}

test("중복 판정 인덱스 — 전수 비교와 같은 판정을 낸다", () => {
  const cands = population(2000);
  const idx = D.buildIndex(cands);
  const r = prng(99);

  const probes: Incoming[] = [];
  for (let i = 0; i < 400; i++) {
    const c = cands[Math.floor(r() * cands.length)];
    const kind = Math.floor(r() * 5);
    if (kind === 0) {
      // 소스 PK 동일 · 핸들 변경
      probes.push({ sourcePk: c.source_pks.pangpang[0], source: "pangpang", handle: `${c.handle}_new`, displayName: c.display_name, followers: c.followers });
    } else if (kind === 1) {
      probes.push({ handle: c.handle, displayName: c.display_name, followers: c.followers });
    } else if (kind === 2) {
      // 구분자만 다름
      probes.push({ handle: c.handle.replace(/[._]/g, (m) => (m === "." ? "_" : ".")), displayName: c.display_name, followers: c.followers });
    } else if (kind === 3) {
      // 오타 — 1~4글자. 유사도 0.6~0.95 구간을 훑어 트라이그램 하한이 진짜 후보를
      // 버리지 않는지 본다.
      const edits = 1 + Math.floor(r() * 4);
      let h = c.handle;
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(r() * h.length);
        h = h.slice(0, at) + "xqzv"[e % 4] + h.slice(at + 1);
      }
      probes.push({ handle: h, displayName: c.display_name, followers: c.followers });
    } else {
      probes.push({ handle: `zzz_unrelated_${i}`, displayName: "무관한맘", followers: 12345 });
    }
  }

  let matched = 0;
  for (const p of probes) {
    const fast = D.findBest(idx, p);
    const slow = bruteForce(cands, p);
    const fv = fast ? D.decide(fast.m.score, fast.m.deterministic) : "new";
    const sv = slow ? D.decide(slow.m.score, slow.m.deterministic) : "new";
    assert.equal(fv, sv, `판정 불일치: ${p.handle} — 인덱스 ${fv} vs 전수 ${sv}`);
    if (fast && slow) {
      assert.equal(fast.m.score, slow.m.score, `점수 불일치: ${p.handle}`);
      assert.equal(fast.m.handleChanged ?? false, slow.m.handleChanged ?? false, `핸들변경 플래그 불일치: ${p.handle}`);
    }
    if (fv !== "new") matched++;
  }
  assert.ok(matched > 200, `매칭이 너무 적다 (${matched}건) — 테스트가 무의미해졌다`);
});

test("중복 판정 인덱스 — 전수 비교보다 확연히 빠르다", () => {
  const cands = population(3000, 21);
  const idx = D.buildIndex(cands);
  const probes = population(300, 55).map((c) => ({ handle: c.handle, displayName: c.display_name, followers: c.followers }));

  let t = Date.now();
  for (const p of probes) D.findBest(idx, p);
  const fast = Date.now() - t;

  t = Date.now();
  for (const p of probes) bruteForce(cands, p);
  const slow = Date.now() - t;

  assert.ok(fast * 5 < slow, `인덱스 ${fast}ms vs 전수 ${slow}ms — 기대한 만큼 빠르지 않다`);
});

test("CSV 레코드 분할 — 따옴표 안의 개행은 자르지 않는다", async () => {
  const { splitRecords } = await import("../src/lib/csv.ts");
  const recs = splitRecords('a,b\n1,"줄1\n줄2"\n2,평범\n');
  assert.equal(recs.length, 3, JSON.stringify(recs));
  assert.equal(recs[1], '1,"줄1\n줄2"');
  // 이스케이프된 따옴표가 상태를 뒤집지 않아야 한다
  assert.equal(splitRecords('h\n"그는 ""안녕"" 이라 했다"\n뒤행').length, 3);
});

test("한 소스에 PK 가 여러 개면 어느 쪽으로 들어와도 같은 사람이다", () => {
  // 사이트가 계정 번호를 바꾸거나 두 크리에이터를 병합하면 PK 가 여럿 남는다.
  // 소스별로 하나만 들고 있으면 옛 PK 로 들어온 행이 신규가 돼서 같은 사람이 두 번 생긴다.
  const cand = { id: "c", handle: "livingnote.k", source_pks: { pangpang: ["500001", "9501"] }, display_name: "리빙노트" };
  const idx = D.buildIndex([cand]);
  for (const pk of ["500001", "9501"]) {
    const hit = D.findBest(idx, { handle: "renamed_x", sourcePk: pk, source: "pangpang", displayName: "리빙노트" });
    assert.ok(hit, `PK ${pk} 로 찾아야 한다`);
    assert.equal(hit!.m.deterministic, true);
    assert.equal(hit!.m.handleChanged, true);
  }
  assert.equal(D.findBest(idx, { handle: "renamed_x", sourcePk: "777", source: "pangpang" }), null,
    "없는 PK 는 매칭되지 않는다");
});

// ---------- 인증 ----------

test("APP_PASSWORD 앞뒤 공백은 무시한다", async () => {
  const A = await import("../src/lib/auth.ts");
  const prev = process.env.APP_PASSWORD;
  try {
    // 대시보드에 붙여넣을 때 줄바꿈이 같이 들어가는 일이 흔하다. 그러면 정확히
    // 입력해도 "맞지 않습니다" 가 뜨고, 무엇이 다른지 화면에 보이지 않는다.
    process.env.APP_PASSWORD = "dibo1234\n";
    assert.equal(A.authConfigured(), true);
    assert.equal(A.secretHadWhitespace(), true);
    const tok = await A.login("dibo1234");
    assert.ok(tok, "공백이 붙어 있어도 로그인돼야 한다");
    assert.equal(await A.verify(tok), true);
    assert.equal(await A.login("dibo123"), null, "다른 값은 거부");

    // 공백만 든 값은 미설정으로 본다 — 그 값으로 로그인되면 사실상 무인증이다.
    process.env.APP_PASSWORD = "   ";
    assert.equal(A.authConfigured(), false);
    assert.equal(await A.login("   "), null);
  } finally {
    if (prev === undefined) delete process.env.APP_PASSWORD;
    else process.env.APP_PASSWORD = prev;
  }
});

test("세션 토큰 — 위조와 만료를 거부한다", async () => {
  const A = await import("../src/lib/auth.ts");
  const prev = process.env.APP_PASSWORD;
  try {
    process.env.APP_PASSWORD = "pw-abc";
    const tok = (await A.login("pw-abc"))!;
    assert.equal(await A.verify(tok), true);
    assert.equal(await A.verify(tok.replace(/\.(.*)$/, ".forged")), false, "서명 위조 거부");
    assert.equal(await A.verify("1.abc"), false, "만료 거부");
    assert.equal(await A.verify(""), false);
    assert.equal(await A.verify(null), false);

    // 비밀번호가 바뀌면 기존 세션도 무효가 돼야 한다.
    process.env.APP_PASSWORD = "pw-xyz";
    assert.equal(await A.verify(tok), false, "비밀번호 변경 후 기존 토큰 무효");
  } finally {
    if (prev === undefined) delete process.env.APP_PASSWORD;
    else process.env.APP_PASSWORD = prev;
  }
});

test("수신거부 경로는 로그인 없이 열려 있어야 한다", async () => {
  const A = await import("../src/lib/auth.ts");
  // 발송 메일의 List-Unsubscribe 링크다. 막으면 수신거부가 동작하지 않아
  // 법정 의무를 위반한다.
  assert.equal(A.isPublicPath("/u/abc123"), true);
  assert.equal(A.isPublicPath("/login"), true);
  assert.equal(A.isPublicPath("/api/cron/worker"), true);
  assert.equal(A.isPublicPath("/api/admin/setup"), true);
  // 나머지는 전부 막혀야 한다.
  for (const p of ["/dashboard", "/influencers", "/import", "/policy", "/settings", "/api/template/creators"]) {
    assert.equal(A.isPublicPath(p), false, p);
  }
});

test("DNS 점검 — 조회 실패를 '없음' 으로 보고하지 않는다", async () => {
  const { checkDomain } = await import("../src/lib/jobs/dns-check.ts");
  // 없는 도메인은 확실히 missing 이다.
  const r = await checkDomain("존재하지않는도메인입니다123456.kr");
  assert.equal(r.ok, false);
  for (const c of r.checks) {
    assert.ok(["missing", "unknown"].includes(c.status), `${c.key}=${c.status}`);
  }
  // 상태가 unknown 이면 ok 로 올라가지 않는다 — 모르는 것을 됐다고 하면 안 된다.
  assert.equal(r.checks.some((c) => c.status === "ok"), false);
});
