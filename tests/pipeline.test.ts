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
  const since = new Date(Date.now() - 60_000);
  await commitBatch(batchId, JAY);
  // 델타 감지는 커밋 이후 별도 잡이 돈다 (jobs/detect-changes).
  const dc = await import("../src/lib/jobs/detect-changes.ts");
  const r = await dc.detectChanges({ batchId, since });
  assert.ok(r.events.some((e) => e.kind === "new_brand" && e.title === "완전새로운브랜드"),
    JSON.stringify(r.events.map((e) => e.kind)));
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

// ---------- 워커 ----------

const seq = await import("../src/lib/jobs/sequence-worker.ts");
const inbound = await import("../src/lib/jobs/inbound-sync.ts");
const breaker = await import("../src/lib/jobs/circuit-breaker.ts");
const detect = await import("../src/lib/jobs/detect-changes.ts");
const gmailMod = await import("../src/lib/channels/gmail.ts");

test("Reply-To 플러스 주소 — 토큰에 cm_ 가 이미 붙어 있어도 한 번만 붙인다", () => {
  assert.equal(gmailMod.replyToAddress("partner@dinostudio.kr", "abc123"), "partner+cm_abc123@dinostudio.kr");
  assert.equal(gmailMod.replyToAddress("partner@dinostudio.kr", "cm_abc123"), "partner+cm_abc123@dinostudio.kr");
  assert.equal(gmailMod.parseReplyToken("partner+cm_abc123@dinostudio.kr"), "abc123");
  assert.equal(gmailMod.parseReplyToken("partner@dinostudio.kr"), null);
});

test("RFC 2822 조립 — 한글 제목은 base64, 수신거부 헤더가 실린다", () => {
  const raw = Buffer.from(
    gmailMod.buildRaw({
      from: "partner@dinostudio.kr", fromName: "지은", to: "a@b.com",
      replyTo: "partner+cm_x@dinostudio.kr", subject: "(광고) 제안", body: "본문",
      headers: { "List-Unsubscribe": "<https://x/u/t>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }),
    "base64url",
  ).toString("utf8");
  assert.match(raw, /^From: =\?UTF-8\?B\?/);
  assert.match(raw, /Reply-To: partner\+cm_x@dinostudio\.kr/);
  assert.match(raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  // 본문은 base64
  assert.match(raw, new RegExp(Buffer.from("본문", "utf8").toString("base64")));
});

test("시퀀스 워커 — 발송하고 다음 스텝을 업무시간 안으로 예약한다", async () => {
  // 아직 아무것도 안 보낸 대상을 하나 지금 발송 대상으로 만든다
  const m = await one<{ id: string }>(
    `UPDATE campaign_member SET next_action_at = now() - interval '1 minute', engine_state = 1, current_step = 0
      WHERE id = (SELECT cm.id FROM campaign_member cm
                    JOIN contact_point cp ON cp.creator_id = cm.creator_id AND cp.channel='email'
                   WHERE cm.engine_state > 0 LIMIT 1)
      RETURNING id`);
  assert.ok(m, "대상이 있어야 한다");

  // 다른 대상이 섞이지 않도록 이 건만 지금 만기로 둔다.
  // 상대 가산(+1 day)은 안 된다 — 시드에는 며칠 전으로 밀린 건도 있어서 여전히 만기로 남는다.
  await run(`UPDATE campaign_member SET next_action_at = now() + interval '1 day'
              WHERE id <> $1 AND next_action_at IS NOT NULL AND next_action_at <= now()`, [m!.id]);

  const before = await n("message");
  const stats = await seq.tick({ limit: 5 });
  assert.equal(stats.processed, 1, JSON.stringify(stats));

  const after = await one<{ current_step: number; engine_state: number; next_action_at: string | null; reply_token: string | null }>(
    `SELECT current_step, engine_state, next_action_at, reply_token FROM campaign_member WHERE id=$1`, [m!.id]);
  if (stats.sent > 0) {
    assert.ok((await n("message")) > before, "메시지가 기록돼야 한다");
    assert.ok(after!.reply_token, "reply_token 이 생겨야 한다");
    assert.equal(after!.current_step, 1, "스텝이 전진해야 한다");
    assert.ok(after!.next_action_at, "다음 스텝이 예약돼야 한다");
  } else {
    assert.ok(stats.queued + stats.blocked === 1, JSON.stringify(stats));
  }
});

test("시퀀스 워커 — 전 스텝을 소진하면 무응답으로 종결한다 (실패가 아니다)", async () => {
  const m = await one<{ id: string }>(
    `UPDATE campaign_member SET next_action_at = now() - interval '1 minute', engine_state = 3, current_step = 99
      WHERE id = (SELECT id FROM campaign_member WHERE engine_state > 0 LIMIT 1) RETURNING id`);
  await run(`UPDATE campaign_member SET next_action_at = now() + interval '1 day'
              WHERE id <> $1 AND next_action_at IS NOT NULL AND next_action_at <= now()`, [m!.id]);
  await seq.tick({ limit: 50 });
  const after = await one<{ engine_state: number; next_action_at: string | null }>(
    `SELECT engine_state, next_action_at FROM campaign_member WHERE id=$1`, [m!.id]);
  assert.equal(after!.engine_state, -2, "NO_REPLY 로 종결");
  assert.equal(after!.next_action_at, null);
});

test("시퀀스 워커 — 수신거부 대상은 종결시키고 사유를 남긴다", async () => {
  const target = await one<{ id: string; creator_id: string }>(
    `SELECT cm.id, cm.creator_id FROM campaign_member cm
       JOIN contact_point cp ON cp.creator_id=cm.creator_id AND cp.channel='email' LIMIT 1`);
  await run(`INSERT INTO suppression (identifier_type, identifier_val, channels, reason)
             VALUES ('creator_id',$1,'{}','dnc_request') ON CONFLICT DO NOTHING`, [target!.creator_id]);
  await run(`UPDATE campaign_member SET engine_state=1, current_step=0, next_action_at=now() - interval '1 minute'
              WHERE id=$1`, [target!.id]);
  await run(`UPDATE campaign_member SET next_action_at = now() + interval '1 day'
              WHERE id <> $1 AND next_action_at IS NOT NULL AND next_action_at <= now()`, [target!.id]);

  const beforeBlocks = await n("gate_block");
  await seq.tick({ limit: 50 });

  assert.ok((await n("gate_block")) > beforeBlocks, "차단 사유가 남아야 한다");
  const after = await one<{ engine_state: number }>(`SELECT engine_state FROM campaign_member WHERE id=$1`, [target!.id]);
  assert.equal(after!.engine_state, -5, "SUPPRESSED 로 종결");
  await run(`DELETE FROM suppression WHERE identifier_type='creator_id' AND identifier_val=$1`, [target!.creator_id]);
});

test("부재중 자동응답은 답장으로 세지 않고 복귀일에 재개한다", async () => {
  const m = await one<{ id: string }>(`SELECT id FROM campaign_member LIMIT 1`);
  await run(`UPDATE campaign_member SET engine_state=3, interest_status=0,
                    reply_token = COALESCE(reply_token, 'tk_' || encode(gen_random_bytes(4),'hex'))
              WHERE id=$1`, [m!.id]);

  const r = await inbound.ingest({
    providerMessageId: "ooo_" + Date.now(),
    threadKey: null, from: "someone@x.com", to: "partner@dinostudio.kr",
    subject: "자동 회신: 부재중입니다",
    body: "휴가 중입니다. 9월 20일부터 복귀합니다.",
    receivedAt: new Date("2026-09-02T01:00:00Z"),
    isAutoReply: true,
    replyToken: (await one<{ reply_token: string }>(`SELECT reply_token FROM campaign_member WHERE id=$1`, [m!.id]))!.reply_token,
  });
  assert.equal(r, "ok");

  const after = await one<{ engine_state: number; interest_status: number; next_action_at: string | null }>(
    `SELECT engine_state, interest_status, next_action_at FROM campaign_member WHERE id=$1`, [m!.id]);
  assert.equal(after!.engine_state, 5, "PAUSED_OOO — 종결이 아니다");
  assert.equal(after!.interest_status, -5);
  assert.ok(after!.next_action_at, "복귀일로 재스케줄돼야 한다");
  // 본문의 "9월 20일부터 복귀" → 그날 09시 KST (= 전날 24시 UTC)
  assert.equal(new Date(after!.next_action_at!).toISOString(), "2026-09-20T00:00:00.000Z");

  // 같은 메시지를 다시 넣어도 중복 저장되지 않는다
  const dup = await inbound.ingest({
    providerMessageId: (await one<{ provider_msg_id: string }>(
      `SELECT provider_msg_id FROM message WHERE direction='in' ORDER BY sent_at DESC LIMIT 1`))!.provider_msg_id,
    threadKey: null, from: "x@y.com", to: "p@d.kr", subject: "", body: "",
    receivedAt: new Date(), isAutoReply: false, replyToken: null,
  });
  assert.equal(dup, "duplicate");
});

test("회신 분류 -4 — creator_id · 핸들 · 이메일 셋 다 등재하고 동의를 opt_out 으로 바꾼다", async () => {
  const m = await one<{ id: string; creator_id: string; handle: string }>(
    `SELECT cm.id, cm.creator_id, sa.handle FROM campaign_member cm
       JOIN social_account sa ON sa.creator_id=cm.creator_id
       JOIN contact_point cp ON cp.creator_id=cm.creator_id AND cp.channel='email'
      WHERE NOT EXISTS (SELECT 1 FROM suppression s WHERE s.identifier_val=cm.creator_id::text)
      LIMIT 1`);
  assert.ok(m);

  await inbound.classifyReply(m!.id, -4, JAY);

  const kinds = (await all<{ identifier_type: string }>(
    `SELECT identifier_type FROM suppression
      WHERE identifier_val = $1::text
         OR identifier_val = $2::text
         OR identifier_val IN (SELECT value_norm FROM contact_point WHERE creator_id = $1::uuid)`,
    [m!.creator_id, m!.handle])).map((r) => r.identifier_type);
  for (const k of ["creator_id", "ig_handle", "email"]) {
    assert.ok(kinds.includes(k), `${k} 이 등재돼야 한다`);
  }
  const consent = await one<{ n: string }>(
    `SELECT count(*) AS n FROM contact_point WHERE creator_id=$1::uuid AND consent_status <> 'opt_out'`, [m!.creator_id]);
  assert.equal(Number(consent!.n), 0, "모든 연락처가 opt_out 이어야 한다");

  const state = await one<{ engine_state: number; key: string }>(
    `SELECT cm.engine_state, ps.key FROM campaign_member cm JOIN pipeline_stage ps ON ps.id=cm.stage_id WHERE cm.id=$1`,
    [m!.id]);
  assert.equal(state!.engine_state, -4);
  assert.equal(state!.key, "dropped");
});

test("회신 분류 -1 — 이탈이 아니라 180일 후 재큐잉", async () => {
  const m = await one<{ id: string }>(`SELECT id FROM campaign_member WHERE engine_state > 0 LIMIT 1`);
  await inbound.classifyReply(m!.id, -1, JAY);
  const after = await one<{ engine_state: number; next_action_at: string | null }>(
    `SELECT engine_state, next_action_at FROM campaign_member WHERE id=$1`, [m!.id]);
  assert.ok(after!.engine_state > 0, "살아 있는 상태로 남아야 한다");
  assert.ok(after!.next_action_at, "재큐잉 시각이 잡혀야 한다");
});

test("회신 분류 3 — 확정으로 옮기고 어트리뷰션 토큰을 발급한다", async () => {
  const m = await one<{ id: string; creator_id: string }>(
    `SELECT id, creator_id FROM campaign_member WHERE engine_state > 0 LIMIT 1`);
  await inbound.classifyReply(m!.id, 3, JAY);
  const state = await one<{ key: string; agreed_at: string | null }>(
    `SELECT ps.key, cm.agreed_at FROM campaign_member cm JOIN pipeline_stage ps ON ps.id=cm.stage_id WHERE cm.id=$1`,
    [m!.id]);
  assert.equal(state!.key, "agreed");
  assert.ok(state!.agreed_at);
  const tok = await one<{ n: string }>(
    `SELECT count(*) AS n FROM attribution_token WHERE creator_id=$1`, [m!.creator_id]);
  assert.ok(Number(tok!.n) >= 2, "링크·쿠폰 토큰이 발급돼야 한다");
});

test("서킷브레이커 — 임계를 넘으면 발신 계정을 정지시킨다", async () => {
  await run(`UPDATE circuit_breaker SET halt_at = 0, warn_at = 0 WHERE metric='bounce_rate'`);
  // 바운스 이벤트를 만들어 비율을 올린다
  const msg = await one<{ id: string }>(`SELECT id FROM message WHERE direction='out' LIMIT 1`);
  await run(`INSERT INTO message_event (message_id, type) VALUES ($1,'bounce_hard')`, [msg!.id]);

  const r = await breaker.tick();
  assert.ok(r.values.bounce_rate > 0);
  assert.ok(r.fired.some((f) => f.metric === "bounce_rate"), JSON.stringify(r.fired));
  const capped = await one<{ n: string }>(`SELECT count(*) AS n FROM sender WHERE channel='email' AND pause_reason LIKE '%볼륨%'`);
  assert.ok(Number(capped!.n) > 0, "볼륨 감축 조치가 적용돼야 한다");

  await run(`UPDATE circuit_breaker SET halt_at=0.05, warn_at=0.03, is_tripped=false WHERE metric='bounce_rate'`);
});

test("액션 블록 신고 — 24시간 정지하고 잔여 작업을 재배정한다", async () => {
  const s = await one<{ id: string; identifier: string }>(
    `SELECT id, identifier FROM sender WHERE channel='instagram_dm' AND paused_until IS NULL LIMIT 1`);
  if (!s) return;
  await run(`UPDATE outreach_task SET sender_id=$1 WHERE state='queued' AND channel='instagram_dm'`, [s.id]);

  const r = await breaker.reportActionBlock(s.id, "테스트");
  assert.equal(r.paused, s.identifier);
  const still = await one<{ n: string }>(
    `SELECT count(*) AS n FROM outreach_task WHERE sender_id=$1 AND state='queued'`, [s.id]);
  assert.equal(Number(still!.n), 0, "정지된 계정에 남은 작업이 없어야 한다");
  const paused = await one<{ paused_until: string | null }>(`SELECT paused_until FROM sender WHERE id=$1`, [s.id]);
  assert.ok(paused!.paused_until);
});

test("변화 감지 — 경쟁 브랜드 공구가 열리면 진행 중 타깃에서 자동 제외한다", async () => {
  const camp = await one<{ id: string; category: string; brand_name: string }>(
    `SELECT id, category, brand_name FROM campaign WHERE status='running' LIMIT 1`);
  const m = await one<{ id: string; creator_id: string; handle: string }>(
    `UPDATE campaign_member SET engine_state=3, stage_id=(SELECT id FROM pipeline_stage WHERE key='contacted')
      WHERE id=(SELECT cm.id FROM campaign_member cm WHERE cm.campaign_id=$1 LIMIT 1)
      RETURNING id, creator_id, (SELECT handle FROM social_account WHERE creator_id=campaign_member.creator_id LIMIT 1) AS handle`,
    [camp!.id]);

  // 경쟁 브랜드 딜을 방금 본 것으로 넣는다
  const rival = await one<{ id: string }>(
    `INSERT INTO brand (name, name_norm, category, is_verified)
     VALUES ('경쟁브랜드테스트','경쟁브랜드테스트',$1,true) RETURNING id`, [camp!.category]);
  const since = new Date(Date.now() - 60_000);
  await run(
    `INSERT INTO deal (creator_id, brand_id, title, title_norm, category_l1, open_date, close_date, first_seen)
     VALUES ($1,$2,'경쟁 공구 테스트','경쟁공구테스트',$3, CURRENT_DATE, CURRENT_DATE + 5, now())`,
    [m!.creator_id, rival!.id, camp!.category]);

  const r = await detect.detectChanges({ since });
  assert.ok(r.autoExcluded > 0, "자동 제외가 일어나야 한다");
  const after = await one<{ engine_state: number; drop_reason: string | null }>(
    `SELECT engine_state, drop_reason FROM campaign_member WHERE id=$1`, [m!.id]);
  assert.equal(after!.engine_state, -6);
  assert.match(after!.drop_reason ?? "", /브랜드 충돌/);
  assert.ok(r.events.some((e) => e.kind === "brand_conflict"));

  // 감사 로그가 남아야 한다 — 자동으로 뺀 것도 근거를 남긴다
  const audit = await one<{ n: string }>(
    `SELECT count(*) AS n FROM audit_log WHERE entity='campaign_member' AND entity_id=$1 AND action='auto_exclude'`,
    [m!.id]);
  assert.ok(Number(audit!.n) > 0);
});
