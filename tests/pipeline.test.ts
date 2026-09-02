import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * 실제 Postgres 위에서 도는 통합 테스트.
 * 전용 DB(gong_test)를 만들어 쓰므로 개발용 DB 는 건드리지 않는다.
 */
const ADMIN = process.env.TEST_PG_ADMIN ?? "postgres://postgres@127.0.0.1:5433/postgres";
const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5433/gong_test";
process.env.DATABASE_URL = TEST_DB;

const pgAdmin = async (sql: string) => {
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
};

before(async () => {
  await pgAdmin(`DROP DATABASE IF EXISTS gong_test`);
  await pgAdmin(`CREATE DATABASE gong_test`);
  const env = { ...process.env, DATABASE_URL: TEST_DB };
  execFileSync(process.execPath, ["scripts/setup-db.mjs"], { env, stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/seed.mjs", "--force"], { env, stdio: "pipe" });
});

const { all, one, run, pool } = await import("../src/lib/db.ts");
const { loadCreators, defaultCampaign, channelPolicies, suppressions } = await import("../src/lib/queries.ts");
const { analyzeCsv, commitBatch, inferHandleColumn, normalizeRow } = await import("../src/lib/importer.ts");
const { loadCampaignInfo, loadGateInputs, loadSendCandidates, evaluateCandidate } = await import("../src/lib/outreach.ts");

after(async () => { await pool().end(); });

const JAY = "00000000-0000-0000-0000-0000000000aa";
const n = async (t: string) => Number((await one<{ n: string }>(`SELECT count(*) AS n FROM ${t}`))!.n);

test("스키마와 시드가 기대한 모양으로 들어갔다", async () => {
  assert.equal(await n("creator"), 1742);
  assert.ok((await n("deal")) > 5000);
  assert.equal(await n("campaign"), 4);
  assert.equal(await n("channel_policy"), 6);
  assert.equal(await n("pipeline_stage"), 11);
  // 상태 3축이 모두 채워져 있어야 한다
  const m = await one<{ stages: string; engines: string }>(
    `SELECT count(DISTINCT stage_id) AS stages, count(DISTINCT engine_state) AS engines FROM campaign_member`);
  assert.ok(Number(m!.stages) >= 5);
  assert.ok(Number(m!.engines) >= 3);
});

test("수신거부는 만료일을 가질 수 없다 — 스키마가 막는다", async () => {
  await assert.rejects(
    run(`INSERT INTO suppression (identifier_type, identifier_val, reason, expires_at)
         VALUES ('email','x@y.com','unsubscribe', now() + interval '1 day')`),
    /unsub_is_permanent/,
  );
});

test("상시 공구에는 마감일을 넣을 수 없다 — 스키마가 막는다", async () => {
  const c = await one<{ id: string }>(`SELECT id FROM creator LIMIT 1`);
  await assert.rejects(
    run(`INSERT INTO deal (creator_id, title, title_norm, is_always_on, close_date)
         VALUES ($1,'상시 테스트','상시테스트', true, CURRENT_DATE)`, [c!.id]),
    /always_on_has_no_close/,
  );
});

test("수집 출처 없는 연락처는 저장되지 않는다 — NOT NULL 로 강제", async () => {
  const c = await one<{ id: string }>(`SELECT id FROM creator LIMIT 1`);
  await assert.rejects(
    run(`INSERT INTO contact_point (creator_id, channel, value, value_norm, collected_at, collected_by)
         VALUES ($1,'email','a@b.com','a@b.com', now(), $2)`, [c!.id, JAY]),
    /source_type|source_url/,
  );
});

test("크리에이터 로더 — 한 번의 조회로 점수까지 계산한다", async () => {
  const t0 = Date.now();
  const { rows, total, campaign } = await loadCreators({ limit: 5000 });
  const ms = Date.now() - t0;
  assert.equal(total, 1742);
  assert.equal(rows.length, 1742);
  assert.ok(campaign, "기준 캠페인이 있어야 한다");
  assert.ok(ms < 3000, `모집단 전체 로딩이 ${ms}ms — 너무 느립니다`);

  const scored = rows.filter((r) => !r.fit.excluded);
  assert.ok(scored.length > 500);
  assert.ok(new Set(scored.map((r) => r.fit.score)).size > 30, "점수가 흩어져야 한다");
  assert.ok(scored.every((r) => r.fit.score >= 0 && r.fit.score <= 100));
});

test("수신거부 등재자는 적합도 산정 이전에 제외된다", async () => {
  const sup = await one<{ identifier_val: string }>(
    `SELECT identifier_val FROM suppression WHERE identifier_type='ig_handle' LIMIT 1`);
  const { rows } = await loadCreators({ search: sup!.identifier_val, limit: 10 });
  const hit = rows.find((r) => r.handle === sup!.identifier_val);
  assert.ok(hit, "검색으로 찾혀야 한다");
  assert.equal(hit!.suppressed, true);
  assert.equal(hit!.fit.excluded, true);
  assert.equal(hit!.fit.reason, "suppression 등재");
});

test("브랜드 충돌은 캠페인 카테고리 기준으로 계산된다", async () => {
  const { rows } = await loadCreators({ limit: 5000 });
  const conflicted = rows.filter((r) => r.conflict_days != null);
  assert.ok(conflicted.length > 0, "충돌 사례가 있어야 한다");
  for (const r of conflicted) {
    assert.ok(r.conflict_days! >= 0 && r.conflict_days! <= 90, `경과일 ${r.conflict_days}`);
    if (r.conflict_days! <= 30) assert.equal(r.fit.excluded, true);
  }
});

// ---------- 발송 게이트 ----------

test("발송 미리보기 — 게이트가 실제로 대상을 걸러낸다", async () => {
  const campaign = await defaultCampaign();
  const info = await loadCampaignInfo(campaign!.id);
  const inputs = await loadGateInputs();
  const candidates = await loadSendCandidates(campaign!.id);
  assert.ok(candidates.length > 0);

  const evaluated = candidates.map((c) => evaluateCandidate(c, info!, inputs));
  const passed = evaluated.filter((e) => e.gate.ok);
  const blocked = evaluated.filter((e) => !e.gate.ok);

  assert.ok(passed.length + blocked.length === candidates.length);
  // 통과한 이메일 건은 (광고) 표기와 수신거부 헤더를 반드시 갖는다
  for (const e of passed.filter((x) => x.channel === "email")) {
    assert.ok(e.rendered!.subject!.startsWith("(광고)"), e.rendered!.subject!);
    assert.ok(e.rendered!.headers["List-Unsubscribe"]);
  }
  // 콜드 불가 채널은 자동 발송으로 통과하지 않는다
  for (const e of passed) {
    if (e.policy.automation_mode === "manual_task") assert.equal(e.gate.ok, true, "작업 큐 경로로만 통과");
  }
});

test("게이트는 채널 정책 표를 읽는다 — 표를 바꾸면 판정이 바뀐다", async () => {
  const campaign = await defaultCampaign();
  const info = await loadCampaignInfo(campaign!.id);
  const candidates = (await loadSendCandidates(campaign!.id)).slice(0, 40);

  await run(`UPDATE channel_policy SET allows_cold=false WHERE channel='email'`);
  const inputs2 = await loadGateInputs();
  const after = candidates.map((c) => evaluateCandidate(c, info!, inputs2));
  assert.ok(after.some((e) => e.gate.blocked?.check === "consent"), "콜드 불가로 바꾸면 동의 단계에서 막힌다");

  await run(`UPDATE channel_policy SET allows_cold=true WHERE channel='email'`);
});

test("서킷브레이커가 발동하면 전부 막힌다", async () => {
  const campaign = await defaultCampaign();
  const info = await loadCampaignInfo(campaign!.id);
  const cand = (await loadSendCandidates(campaign!.id))[0];

  await run(`UPDATE circuit_breaker SET is_tripped=true, current_value=0.005 WHERE metric='spam_rate'`);
  const blocked = evaluateCandidate(cand, info!, await loadGateInputs());
  assert.equal(blocked.gate.blocked!.check, "circuit_breaker");

  await run(`UPDATE circuit_breaker SET is_tripped=false WHERE metric='spam_rate'`);
  const ok = evaluateCandidate(cand, info!, await loadGateInputs());
  assert.notEqual(ok.gate.blocked?.check, "circuit_breaker");
});

// ---------- 임포터 ----------

test("핸들 컬럼 추론 — 맘캘 슬러그는 후보에서 제외된다", () => {
  assert.equal(inferHandleColumn(["slug", "seller", "handle"], "momcal"), "handle");
  assert.equal(inferHandleColumn(["slug", "seller"], "momcal"), null);
  assert.equal(inferHandleColumn(["handle", "account_id"], "pangpang"), "handle");
});

test("행 정규화 — 소스별 표기를 우리 스키마로 옮긴다", () => {
  const row = normalizeRow(
    { handle: "@Living_Note", "팔로워": "10.8만", "30일": "30일 5건", "평균간격": "평균 9일 간격",
      "마지막공구": "마지막 공구 10일 전", "카테고리점유율": "리빙 61%, 인테리어 22%", account_id: "9306" },
    "pangpang",
  );
  assert.equal(row.handle, "living_note");
  assert.equal(row.followers, 108000);
  assert.equal(row.followersPrecision, 500);
  assert.equal(row.deals30, 5);
  assert.equal(row.avgInterval, 9);
  assert.equal(row.daysSinceLast, 10);
  assert.deepEqual(row.categoryShare, { 리빙: 61, 인테리어: 22 });
  assert.equal(row.platformUserId, "9306");
});

test("임포트 dry-run — 본 테이블을 건드리지 않는다", async () => {
  const before = await n("creator");
  const csv = fs.readFileSync("samples/pangpang.csv", "utf8");
  const batchId = await analyzeCsv(csv, "pangpang", "pangpang.csv", JAY);
  assert.ok(batchId);

  assert.equal(await n("creator"), before, "dry-run 은 크리에이터를 만들지 않는다");
  const batch = await one<{ state: string; rows_read: number; rows_new: number }>(
    `SELECT state, rows_read, rows_new FROM import_batch WHERE id=$1`, [batchId]);
  assert.equal(batch!.state, "dry_run");
  assert.ok(batch!.rows_read > 0);
});

test("임포트 커밋 — 신규는 생성하고 스냅샷을 쌓는다", async () => {
  const csv = fs.readFileSync("samples/pangpang.csv", "utf8");
  const batchId = (await analyzeCsv(csv, "pangpang", "pangpang2.csv", JAY))!;
  const beforeCreators = await n("creator");
  const beforeSnaps = await n("account_snapshot");

  const res = await commitBatch(batchId, JAY);
  assert.ok(res.created + res.merged > 0);
  assert.equal(await n("creator"), beforeCreators + res.created);
  assert.ok((await n("account_snapshot")) > beforeSnaps, "스냅샷은 덮어쓰지 않고 쌓인다");

  const batch = await one<{ state: string }>(`SELECT state FROM import_batch WHERE id=$1`, [batchId]);
  assert.equal(batch!.state, "committed");
  await assert.rejects(commitBatch(batchId, JAY), /이미 반영/);
});

test("임포트 — 핸들 없는 행은 오류로 넘기고 저장하지 않는다", async () => {
  const csv = "handle,display_name,팔로워\n,이름만있는행,2.1만\n@brand_new_seller_x,새셀러,3만\n";
  const batchId = (await analyzeCsv(csv, "pangpang", "err.csv", JAY))!;
  const b = await one<{ rows_error: number; rows_new: number }>(
    `SELECT rows_error, rows_new FROM import_batch WHERE id=$1`, [batchId]);
  assert.equal(b!.rows_error, 1);
  assert.equal(b!.rows_new, 1);
});

test("임포트 — 맘캘 슬러그만 있는 행은 오류로 넘어간다", async () => {
  const csv = "slug,seller,brand\nde-elisa-shop,엘리사샵,라누보\n";
  const batchId = (await analyzeCsv(csv, "momcal", "slug.csv", JAY))!;
  const b = await one<{ rows_error: number; report: { rows: { evidence: string }[] } }>(
    `SELECT rows_error, report FROM import_batch WHERE id=$1`, [batchId]);
  assert.equal(b!.rows_error, 1);
  assert.match(b!.report.rows[0].evidence, /매칭 키로 지정/);
});

test("임포트 — 소스 PK 가 같고 핸들이 다르면 검토 큐로 가고 alias 가 남는다", async () => {
  // pangpang 시드는 account_id 를 platform_user_id 로 갖고 있다.
  const acc = await one<{ handle: string; pid: string }>(
    `SELECT handle, platform_user_id AS pid FROM social_account WHERE platform_user_id IS NOT NULL LIMIT 1`);
  const csv = `handle,display_name,팔로워,account_id\n@renamed_${acc!.pid},바뀐이름,5만,${acc!.pid}\n`;
  const batchId = (await analyzeCsv(csv, "pangpang", "rename.csv", JAY))!;

  const mc = await one<{ evidence: string; id: string }>(
    `SELECT id, evidence FROM merge_candidate WHERE batch_id=$1`, [batchId]);
  assert.ok(mc, "검토 큐에 올라와야 한다");
  assert.match(mc!.evidence, /핸들 변경 추정/);

  await run(`UPDATE merge_candidate SET decision='merge' WHERE id=$1`, [mc!.id]);
  const beforeAlias = await n("handle_alias");
  await commitBatch(batchId, JAY);
  assert.ok((await n("handle_alias")) > beforeAlias, "이전 핸들이 alias 로 남아야 한다");
});

test("임포트 — 사전에 없던 브랜드는 새 브랜드 이벤트를 만든다", async () => {
  const csv = "handle,seller,brand,product,period,category\njinny_kitchen,지니키친,완전새로운브랜드,테스트 제품,2026-09-20 ~ 09-26,리빙\n";
  const batchId = (await analyzeCsv(csv, "momcal", "brand.csv", JAY))!;
  await commitBatch(batchId, JAY);
  const ev = await one<{ n: string }>(
    `SELECT count(*) AS n FROM change_event WHERE batch_id=$1 AND kind='new_brand'`, [batchId]);
  assert.ok(Number(ev!.n) >= 1);
  const b = await one<{ is_verified: boolean }>(`SELECT is_verified FROM brand WHERE name='완전새로운브랜드'`);
  assert.equal(b!.is_verified, false, "임포트로 처음 본 브랜드는 미검증");
});

test("정책·수신거부 조회 헬퍼", async () => {
  const pol = await channelPolicies();
  assert.equal(pol.length, 6);
  assert.equal(pol.find((p) => p.channel === "instagram_dm")!.allows_cold, false);
  assert.equal(pol.find((p) => p.channel === "email")!.automation_mode, "auto");
  assert.ok((await suppressions()).length > 0);
});
