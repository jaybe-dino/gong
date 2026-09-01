import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TEST_DB = path.join(process.cwd(), "data", "test-pipeline.db");
process.env.GONG_DB = TEST_DB;
process.env.GONG_TODAY = "2026-09-01";

before(() => {
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(TEST_DB + s, { force: true });
  execFileSync(process.execPath, ["scripts/init-db.mjs", "--force"], {
    env: { ...process.env, GONG_DB: TEST_DB },
    stdio: "pipe",
  });
});

const { one, all } = await import("../src/lib/db.ts");
const { scoreCreator, brandConflict, categoryFit, timingScore, WEIGHTS } = await import("../src/lib/scoring.ts");
const { loadScoringContext } = await import("../src/lib/scoring-context.ts");
const { buildSegment, runGate, DEFAULT_SEGMENT, isSuppressed } = await import("../src/lib/policy.ts");
const { creatorMetrics } = await import("../src/lib/metrics.ts");
const { analyze, applyBatch, saveBatch, inferHandleColumn } = await import("../src/lib/importer.ts");
const { ensureFitCache, defaultCampaign } = await import("../src/lib/fit-cache.ts");

const REF = "2026-09-01";
const byHandle = (h: string) =>
  one<{ id: number }>(`SELECT creator_id AS id FROM social_account WHERE handle = ?`, [h])!.id;

test("시드가 기대한 규모로 들어갔다", () => {
  assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM creator`)!.n, 1742);
  assert.ok(one<{ n: number }>(`SELECT COUNT(*) AS n FROM deal`)!.n > 5000);
  assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM campaign`)!.n, 4);
});

test("카테고리 적합 — 인접 카테고리는 가중치로 부분 인정된다", () => {
  const id = byHandle("livingnote_k");
  const direct = categoryFit(id, "리빙");
  // 리빙 61 + 주방·청소 22×0.7 + 생활/장보기 11×0.6 + 가전 6×0.4
  assert.ok(direct.pct > 61 && direct.pct < 90, `실제 ${direct.pct}`);

  const unrelated = categoryFit(id, "뷰티");
  assert.equal(unrelated.pct, 0);
});

test("브랜드 충돌 — 30일 이내는 제외, 60/90일은 감점", () => {
  const campaign = one<{ id: number; category: string; brand_id: number | null }>(
    `SELECT id, category, brand_id FROM campaign WHERE name='가을 홈웨어 공구'`,
  )!;

  // @sooyeon.living 은 09-02~09-06 라누보 차렵이불 진행 예정 → 캠페인 브랜드와 동일, 30일 이내
  const c = brandConflict(byHandle("sooyeon.living"), campaign, REF);
  assert.ok(c, "충돌이 잡혀야 한다");
  assert.equal(c!.brand, "라누보");
  assert.equal(c!.verdict, "exclude");

  // @mom_dailylog 은 리빙 계열 브랜드 이력이 90일 안에 없다
  assert.equal(brandConflict(byHandle("mom_dailylog"), campaign, REF), null);
});

test("적합도 — 충돌 셀러는 제외된다", () => {
  const campaign = one<{ id: number; category: string; brand_id: number | null }>(
    `SELECT id, category, brand_id FROM campaign WHERE name='가을 홈웨어 공구'`,
  )!;

  // @sooyeon.living — 캠페인 브랜드(라누보)를 30일 이내에 진행 중
  const excluded = scoreCreator(byHandle("sooyeon.living"), campaign, REF);
  assert.equal(excluded.excluded, true);
  assert.equal(excluded.score, 0);
  assert.match(excluded.excludeReason!, /라누보/);

  // @livingnote_k — 08-22 라누보 러그(10일 전) + 09-01 코지홈 커튼(인테리어, 리빙과 인접)
  // 적합도는 높지만 30일 이내 충돌이라 제외된다. 규칙이 일관되게 적용되는지 확인한다.
  const conflicted = scoreCreator(byHandle("livingnote_k"), campaign, REF);
  assert.equal(conflicted.excluded, true, "30일 이내 같은 카테고리 브랜드 이력이면 적합도와 무관하게 제외");
  const cat = conflicted.reasons.find((r) => r.label === "카테고리 적합")!;
  assert.ok(cat.points >= 40, `카테고리 적합 자체는 높아야 한다 (${cat.points})`);
});

test("적합도 — 충돌 없는 적기 셀러는 타이밍 가점을 받는다", () => {
  const campaign = one<{ id: number; category: string; brand_id: number | null }>(
    `SELECT id, category, brand_id FROM campaign WHERE name='가을 홈웨어 공구'`,
  )!;

  // @mom_dailylog — 리빙 계열 브랜드 충돌 없음, 평균 11일 간격에 마지막 19일 전
  const ripe = scoreCreator(byHandle("mom_dailylog"), campaign, REF);
  assert.equal(ripe.excluded, false);
  const timing = ripe.reasons.find((r) => r.label === "케이던스 타이밍")!;
  assert.ok(timing.points > 0, "적기 구간이면 타이밍 가점이 붙는다");
  assert.match(timing.detail, /적기/);
  assert.ok(ripe.reasons.some((r) => r.label === "연락 경로" && r.points === 8), "이메일 보유 가점");
  assert.ok(ripe.score > 0);
});

test("배점 합은 정확히 100 — 상위권이 100 으로 뭉치지 않는다", () => {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);

  // 타이밍은 경과일/평균간격 1.0 에서 만점, 양쪽으로 감소한다.
  assert.equal(timingScore(1.0), WEIGHTS.timing);
  assert.equal(timingScore(null), 0);
  assert.equal(timingScore(0.5), 0, "공구를 막 끝냈으면 타이밍 점수 없음");
  assert.equal(timingScore(2.3), 0, "평균 간격의 2.3배면 휴면으로 본다");
  assert.ok(timingScore(0.8) < timingScore(1.0));
  assert.ok(timingScore(1.5) < timingScore(1.0));

  const campaign = defaultCampaign();
  ensureFitCache(campaign, REF);
  const scores = all<{ score: number }>(
    `SELECT score FROM fit_cache WHERE campaign_id=? AND excluded=0`, [campaign.id],
  ).map((r) => r.score);
  const perfect = scores.filter((s) => s === 100).length;
  assert.ok(perfect <= 1, `100점이 ${perfect}명 — 상한 포화`);
  assert.ok(new Set(scores).size > 30, "점수가 충분히 흩어져야 한다");
});

test("연락 금지는 점수 이전에 제외된다", () => {
  const campaign = defaultCampaign();
  const blocked = scoreCreator(byHandle("babyroom_diary"), campaign, REF);
  assert.equal(blocked.excluded, true);
  assert.equal(blocked.excludeReason, "연락 금지 등록");
  assert.ok(isSuppressed(byHandle("babyroom_diary")));
});

test("벌크 컨텍스트는 개별 쿼리와 같은 점수를 낸다", () => {
  const campaign = defaultCampaign();
  const ctx = loadScoringContext(REF);
  for (const h of ["livingnote_k", "mom_dailylog", "jinny_kitchen", "nara_home", "sooyeon.living", "babyroom_diary"]) {
    const id = byHandle(h);
    const a = scoreCreator(id, campaign, REF);
    const b = scoreCreator(id, campaign, REF, ctx);
    assert.equal(b.score, a.score, `${h} 점수 불일치`);
    assert.equal(b.excluded, a.excluded, `${h} 제외 여부 불일치`);
  }
});

test("케이던스 지표 — 임포트 값이 기준, 슬롯은 관측값", () => {
  const m = creatorMetrics(byHandle("livingnote_k"), REF);
  assert.equal(m.basis, "imported");
  assert.equal(m.cadence, 9);
  assert.equal(m.lastDealDays, 10);
  assert.ok(m.slots >= 1, "진행중·예정 공구가 있어야 한다");
});

test("세그먼트 퍼널은 단조 감소하고 수신거부를 반드시 걷어낸다", () => {
  const campaign = defaultCampaign();
  const seg = buildSegment(campaign, DEFAULT_SEGMENT, REF);

  const counts = seg.funnel.map((f) => f.count);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] <= counts[i - 1], `퍼널이 증가했다: ${JSON.stringify(counts)}`);
  }
  assert.ok(seg.final.length > 0, "최종 대상이 있어야 한다");

  // 최종 대상 중 수신거부·제외 대상이 남아 있으면 안 된다.
  for (const c of seg.final) {
    assert.equal(isSuppressed(c.creatorId), null, `@${c.handle} 이 수신거부인데 남아 있다`);
    assert.equal(c.fit.excluded, false, `@${c.handle} 이 제외 대상인데 남아 있다`);
    assert.ok(c.contact, `@${c.handle} 에 연락처가 없다`);
  }
});

test("세그먼트는 쿨다운 내 재접촉을 막는다", () => {
  const campaign = defaultCampaign();
  const seg = buildSegment(campaign, DEFAULT_SEGMENT, REF);
  for (const c of seg.final) {
    const last = one<{ sent_at: string; channel: string }>(
      `SELECT sent_at, channel FROM outreach_log WHERE creator_id=? ORDER BY sent_at DESC LIMIT 1`,
      [c.creatorId],
    );
    if (!last) continue;
    const days = Math.round((Date.parse(REF) - Date.parse(last.sent_at.slice(0, 10))) / 86400000);
    const limit = last.channel === "email" ? DEFAULT_SEGMENT.cooldownEmailDays : DEFAULT_SEGMENT.cooldownDmDays;
    assert.ok(days >= limit, `@${c.handle} 쿨다운 ${days}일 < ${limit}일`);
  }
});

test("정책 게이트 — 8단계가 모두 평가된다", () => {
  const campaign = defaultCampaign();
  const seg = buildSegment(campaign, DEFAULT_SEGMENT, REF);
  const gate = runGate(seg, "email");
  assert.ok(gate.checks.length >= 8, `게이트 항목 ${gate.checks.length}개`);
  assert.ok(gate.capacity > 0, "가용 발송량이 있어야 한다");
  assert.ok(gate.days >= 1);
});

test("정책 게이트 — 콜드 불가 채널은 통과하지 못한다", () => {
  const campaign = defaultCampaign();
  const seg = buildSegment(campaign, DEFAULT_SEGMENT, REF);
  const gate = runGate(seg, "ig_dm");
  const cold = gate.checks.find((c) => c.label.includes("콜드 허용"))!;
  assert.equal(cold.pass, false, "인스타 DM 은 콜드 발송이 불가해야 한다");
  assert.equal(gate.allPass, false);
});

test("적합도 캐시는 전원을 채우고 직접 계산과 일치한다", () => {
  const campaign = defaultCampaign();
  ensureFitCache(campaign, REF);
  const cached = one<{ n: number }>(`SELECT COUNT(*) AS n FROM fit_cache WHERE campaign_id=? AND computed_at=?`, [campaign.id, REF])!.n;
  assert.equal(cached, 1742);

  const sample = all<{ creator_id: number; score: number }>(
    `SELECT creator_id, score FROM fit_cache WHERE campaign_id=? ORDER BY creator_id LIMIT 25`, [campaign.id],
  );
  for (const row of sample) {
    assert.equal(scoreCreator(row.creator_id, campaign, REF).score, row.score);
  }
});

// ---------- 임포터 ----------

test("핸들 컬럼 추론 — 맘캘 슬러그는 후보에서 제외한다", () => {
  assert.equal(inferHandleColumn(["slug", "seller_name", "handle"], "momcal"), "handle");
  // 슬러그만 있으면 매칭 키를 찾지 못한다 (그래야 한다)
  assert.equal(inferHandleColumn(["slug", "seller_name"], "momcal"), null);
});

test("임포트 분석 — 신규 / 병합 / 검토 / 오류로 나뉜다", () => {
  const csv = fs.readFileSync("samples/09pangpang_sample.csv", "utf8");
  const a = analyze(csv, "pang", "09pangpang_sample.csv");

  assert.equal(a.counts.rows, 8);
  assert.equal(a.counts.errors, 1, "핸들 없는 행 1건은 오류");

  const row = (h: string) => a.rows.find((r) => r.raw.handle === h)!;

  // 구두점만 다르고 표시명이 같으면 자동 병합
  assert.equal(row("@sooyeon_living").verdict, "merge");
  assert.equal(row("livingnote.k").verdict, "merge");

  // 정규화 후 핸들은 같지만 표시명이 다르면 사람이 판단해야 한다 (동명이인 가능)
  const dup = row("momdailylog");
  assert.equal(dup.verdict, "review");
  assert.match(dup.reason, /표시명 불일치/);

  // 일치하는 계정이 없으면 신규
  assert.equal(row("@newseller_home").verdict, "new");
  assert.equal(row("@table_of_bom").verdict, "new");
  assert.equal(row("@hi.iamjoo0").verdict, "new");

  // 오류 행은 핸들이 비어 있다
  const err = a.rows.find((r) => r.verdict === "error")!;
  assert.match(err.reason, /핸들 없음/);
});

test("임포트 — 유사도가 임계 위여도 감점 후 내려가면 별개 계정으로 본다", () => {
  const csv = fs.readFileSync("samples/09pangpang_sample.csv", "utf8");
  const a = analyze(csv, "pang", "s.csv");
  const olive = a.rows.find((r) => r.raw.handle === "@olive_market_kr")!;
  // 유사한 핸들이 모집단에 있지만 표시명 불일치 + 팔로워 격차로 0.80 아래로 떨어진다.
  assert.equal(olive.verdict, "new");
  assert.ok(olive.score! < 0.8, `점수 ${olive.score}`);
  assert.equal(olive.matchId, null, "별개 계정으로 봤으면 매칭 후보를 들고 있으면 안 된다");
});

test("임포트 반영 — 신규는 생성, 병합은 스냅샷만 추가, 검토는 남는다", () => {
  const csv = fs.readFileSync("samples/09pangpang_sample.csv", "utf8");
  const a = analyze(csv, "pang", "09pangpang_sample.csv");
  const before = one<{ n: number }>(`SELECT COUNT(*) AS n FROM creator`)!.n;
  const beforeSnap = one<{ n: number }>(`SELECT COUNT(*) AS n FROM account_snapshot`)!.n;

  const batchId = saveBatch(a, "2026-09-01 12:00");
  const res = applyBatch(batchId, "2026-09-01 12:00");

  assert.equal(res.created, a.counts.created);
  assert.equal(res.updated, a.counts.updated);
  assert.equal(res.skipped, a.counts.errors + a.counts.review);

  assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM creator`)!.n, before + res.created);
  assert.ok(one<{ n: number }>(`SELECT COUNT(*) AS n FROM account_snapshot`)!.n > beforeSnap);

  // 병합된 계정은 새로 만들어지지 않고 스냅샷만 쌓인다
  const snaps = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM account_snapshot WHERE account_id=(SELECT id FROM social_account WHERE handle='livingnote_k')`,
  )!.n;
  assert.ok(snaps >= 2, `스냅샷이 누적돼야 한다 (현재 ${snaps})`);

  // 같은 배치를 두 번 반영할 수 없다
  assert.throws(() => applyBatch(batchId, "2026-09-01 12:01"), /이미 반영/);
});

test("임포트 — 팔로워 정밀도 플래그가 스냅샷에 남는다", () => {
  const row = one<{ followers: number; precision: number }>(
    `SELECT followers, precision FROM account_snapshot
      WHERE account_id=(SELECT id FROM social_account WHERE handle='olive_market_kr')
      ORDER BY id DESC LIMIT 1`,
  );
  assert.ok(row, "새로 만든 계정의 스냅샷이 있어야 한다");
  assert.equal(row!.followers, 77000);
  assert.equal(row!.precision, 500);
});

test("임포트 — 소스 PK 가 같고 핸들이 다르면 핸들 변경으로 검토 큐에 넣는다", () => {
  // 방금 반영한 배치로 @hi.iamjoo0 이 source_pk 9306 과 함께 등록됐다.
  // 같은 PK 로 다른 핸들이 들어오면 핸들 변경으로 보고 검토 큐에 올려야 한다.
  const csv = "handle,display_name,팔로워,account_id\n@joo0.is.happy,주영이네,4.9만,9306\n";
  const a = analyze(csv, "pang", "renamed.csv");
  const r = a.rows[0];
  assert.equal(r.verdict, "review");
  assert.match(r.reason, /핸들 변경 추정/);
  assert.equal(r.matchHandle, "hi.iamjoo0");
});
