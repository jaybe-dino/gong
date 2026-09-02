import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";

/**
 * 이 컨테이너에는 Chromium 이 미리 설치돼 있고 (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers),
 * 그 빌드 번호가 npm 의 playwright 버전과 다를 수 있다. 있으면 그 실행 파일을 직접 쓴다.
 */
function chromiumPath(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!fs.existsSync(root)) return undefined;
  for (const dir of fs.readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
    const exe = path.join(root, dir, "chrome-linux", "chrome");
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

/**
 * 브라우저에서 실제로 클릭해 보는 테스트.
 * 서버 액션(폼 제출)이 DB 를 실제로 바꾸는지, 배경이 흰색인지 확인한다.
 *
 * 전용 DB 와 전용 포트를 쓴다. 개발용 data/app.db 는 건드리지 않는다.
 */
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = process.env.TEST_PG_ADMIN ?? "postgres://postgres@127.0.0.1:5433/postgres";
const DB = process.env.E2E_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5433/gong_e2e";

// db.ts 는 모듈 로드 시점에 DATABASE_URL 을 읽는다. 아래 import 보다 먼저 설정해야
// 테스트가 개발용 DB 가 아니라 전용 DB 를 본다.
process.env.DATABASE_URL = DB;

let server: ChildProcess;
let browser: Browser;
let page: Page;

const { one, all, pool } = await import("../src/lib/db.ts");

/** 서버 액션 폼 제출 후 응답과 후속 렌더까지 기다린다. */
async function submit(locator: ReturnType<Page["locator"]>) {
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.status() < 400),
    locator.click(),
  ]);
  await page.waitForLoadState("networkidle");
}

async function assertPortFree() {
  try {
    const r = await fetch(`${BASE}/dashboard`, { signal: AbortSignal.timeout(2000) });
    throw new Error(
      `포트 ${PORT} 에 이미 서버가 떠 있습니다 (status ${r.status}). ` +
        `이전 실행의 next-server 가 남아 있을 수 있습니다: pkill -f next-server`,
    );
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("포트")) throw e;
    // 연결 실패 = 포트가 비어 있다
  }
}

async function waitForServer(timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/dashboard`);
      if (r.ok) return;
    } catch {
      // 아직 안 떴다
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("서버가 뜨지 않았습니다");
}

before(async () => {
  const pg = (await import("pg")).default;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS gong_e2e`);
  await admin.query(`CREATE DATABASE gong_e2e`);
  await admin.end();

  const { execFileSync } = await import("node:child_process");
  const env = { ...process.env, DATABASE_URL: DB };
  execFileSync(process.execPath, ["scripts/setup-db.mjs"], { env, stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/seed.mjs", "--force"], { env, stdio: "pipe" });

  // 포트가 이미 잡혀 있으면 이전 실행의 서버가 살아 있다는 뜻이다.
  // 그 서버는 지워진 DB 파일을 붙들고 있어서, 그대로 두면 테스트가 조용히 잘못된 DB 를 본다.
  await assertPortFree();

  // npx 를 거치면 실제 서버가 손자 프로세스가 되어 kill 이 닿지 않는다.
  // next 바이너리를 직접 띄우고 프로세스 그룹째 정리한다.
  server = spawn(process.execPath, [path.join("node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], {
    env: { ...process.env, DATABASE_URL: DB },
    stdio: "ignore",
    detached: true,
  });
  await waitForServer();

  browser = await chromium.launch({ executablePath: chromiumPath() });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
  await pool().end().catch(() => {});
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      server.kill("SIGKILL");
    }
  }
});

describe("아웃리치 콘솔 E2E", () => {
  test("배경은 흰색이고 다크 모드에서도 바뀌지 않는다", async () => {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${BASE}/dashboard`);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.equal(bg, "rgb(255, 255, 255)", `${scheme} 스킴에서 배경이 흰색이 아니다: ${bg}`);
      const ground = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--ground").trim(),
      );
      assert.equal(ground.toUpperCase(), "#FFFFFF");
    }
    await page.emulateMedia({ colorScheme: "light" });
  });

  test("사이드바로 모든 화면을 열 수 있다", async () => {
    const screens: [string, string][] = [
      ["/plan", "설계 개요"],
      ["/feed", "공구 캘린더"],
      ["/watch", "변화 감지"],
      ["/influencers", "인플루언서 DB"],
      ["/deals", "딜 · 브랜드 탐색"],
      ["/import", "데이터 임포트"],
      ["/campaigns", "캠페인"],
      ["/send", "제안 발송"],
      ["/queue", "작업 큐"],
      ["/inbox", "통합 인박스"],
      ["/policy", "채널 정책 · 발신 계정"],
      ["/dashboard", "대시보드"],
    ];
    await page.goto(`${BASE}/dashboard`);
    for (const [href, heading] of screens) {
      await page.locator(`a.navbtn[href="${href}"]`).click();
      await page.waitForURL(`**${href}`);
      await page.waitForFunction(
        (h) => document.querySelector("h1")?.textContent === h,
        heading,
        { timeout: 15000 },
      );
      assert.equal(await page.locator("h1").first().innerText(), heading);
    }
  });

  test("인플루언서 행을 열면 적합도 산정 근거가 보인다", async () => {
    await page.goto(`${BASE}/influencers`);
    await page.locator("tbody tr td a[href*='open=']").first().click();
    await page.waitForSelector(".drawer");
    const text = await page.locator(".drawer").innerText();
    assert.match(text, /적합도 산정/);
    assert.match(text, /카테고리 적합/);
    assert.match(text, /도달 가능성/);
    assert.match(text, /타이밍/);
    assert.match(text, /공구 실적/);
    await page.locator(".drawer").getByText("닫기").click();
    await page.waitForSelector(".drawer", { state: "detached" });
  });

  test("작업 큐 완료 처리가 DB 에 반영된다", async () => {
    await page.goto(`${BASE}/queue`);
    const n = async (sql: string) => Number((await one<{ n: string }>(sql))!.n);
    const before = await n(`SELECT count(*) AS n FROM outreach_task WHERE state IN ('queued','claimed')`);
    const beforeMsg = await n(`SELECT count(*) AS n FROM message WHERE direction='out'`);

    await submit(page.locator("tbody form button[type=submit]").first());

    assert.equal(
      await n(`SELECT count(*) AS n FROM outreach_task WHERE state IN ('queued','claimed')`),
      before - 1, "대기 작업이 하나 줄어야 한다");
    assert.ok(await n(`SELECT count(*) AS n FROM message WHERE direction='out'`) > beforeMsg, "메시지 기록이 남아야 한다");
  });

  test("회신을 '연락 금지'로 분류하면 핸들과 이메일이 모두 영구 차단된다", async () => {
    await page.goto(`${BASE}/inbox?f=unclassified`);
    const first = page.locator("a.ithread").first();
    if (!(await first.count())) return; // 미분류 스레드가 없으면 건너뛴다

    await first.click();
    await page.waitForLoadState("networkidle");
    await page.waitForSelector("select[name=interest]");

    const handle = (await page.locator(".iconv-h a.iglink").first().innerText()).replace(/^@/, "");
    const n = async (sql: string, p: unknown[] = []) => Number((await one<{ n: string }>(sql, p))!.n);
    assert.equal(await n(`SELECT count(*) AS n FROM suppression WHERE identifier_val=$1`, [handle]), 0);

    await page.locator("select[name=interest]").selectOption({ label: "-4 연락 금지 (영구 차단)" });
    await submit(page.getByRole("button", { name: "분류 저장" }));

    assert.equal(await n(`SELECT count(*) AS n FROM suppression WHERE identifier_type='ig_handle' AND identifier_val=$1`, [handle]), 1,
      "핸들이 등재돼야 한다");
    const stage = await one<{ key: string }>(
      `SELECT ps.key FROM campaign_member m JOIN pipeline_stage ps ON ps.id=m.stage_id
         JOIN social_account sa ON sa.creator_id=m.creator_id WHERE sa.handle=$1 LIMIT 1`, [handle]);
    assert.equal(stage!.key, "dropped");
    // 수신거부는 영구여야 한다
    const exp = await one<{ expires_at: string | null }>(
      `SELECT expires_at FROM suppression WHERE identifier_val=$1 LIMIT 1`, [handle]);
    assert.equal(exp!.expires_at, null);
  });

  test("CSV 를 올리면 dry-run 배치가 생기고 본 테이블은 그대로다", async () => {
    const n = async (sql: string) => Number((await one<{ n: string }>(sql))!.n);
    const beforeCreators = await n(`SELECT count(*) AS n FROM creator`);

    await page.goto(`${BASE}/import?step=1`);
    await page.setInputFiles("input[type=file]", "samples/pangpang.csv");
    await submit(page.getByRole("button", { name: /업로드 후 중복 검사/ }));
    await page.waitForURL(/step=3/, { timeout: 30000 });

    const body = await page.locator(".screen").innerText();
    assert.match(body, /읽은 행/);
    assert.match(body, /검토 큐/);
    assert.equal(await n(`SELECT count(*) AS n FROM creator`), beforeCreators, "dry-run 은 본 테이블을 건드리지 않는다");

    const batch = await one<{ state: string; rows_read: number }>(
      `SELECT state, rows_read FROM import_batch ORDER BY created_at DESC LIMIT 1`);
    assert.equal(batch!.state, "dry_run");
    assert.ok(batch!.rows_read > 0);
  });

  test("배치를 커밋하면 크리에이터가 늘고 변화 이벤트가 생긴다", async () => {
    const n = async (sql: string) => Number((await one<{ n: string }>(sql))!.n);
    const before = await n(`SELECT count(*) AS n FROM creator`);

    await submit(page.getByRole("button", { name: /건 반영$/ }));

    // 반영은 여러 요청에 나눠 돈다. 화면의 진행 컴포넌트가 이어 돌리고 끝나면
    // 요약(step=4)으로 넘어간다.
    await page.waitForURL(/step=4/, { timeout: 120000 });
    assert.match(await page.locator(".screen").innerText(), /건 반영 완료/);

    const batch = await one<{ state: string; rows_new: number; rows_merged: number }>(
      `SELECT state, rows_new, rows_merged FROM import_batch ORDER BY created_at DESC LIMIT 1`);
    assert.equal(batch!.state, "committed");
    assert.ok(batch!.rows_new + batch!.rows_merged > 0, "무언가는 반영돼야 한다");
    assert.equal(await n(`SELECT count(*) AS n FROM creator`), before + batch!.rows_new);
  });

  test("제안 발송 — 게이트를 통과한 건만 나가고 막힌 건은 사유가 남는다", async () => {
    await page.goto(`${BASE}/send?step=3`);
    const gate = await page.locator(".gate").innerText();
    assert.match(gate, /수신거부/);
    assert.match(gate, /List-Unsubscribe/);

    const n = async (sql: string) => Number((await one<{ n: string }>(sql))!.n);
    const beforeMsg = await n(`SELECT count(*) AS n FROM message WHERE direction='out'`);
    const beforeBlocks = await n(`SELECT count(*) AS n FROM gate_block`);

    const btn = page.getByRole("button", { name: /건 발송 시작$/ });
    if (!(await btn.count())) return;
    await submit(btn);
    await page.waitForURL(/sent=\d+/, { timeout: 90000 });

    const sent = Number(new URL(page.url()).searchParams.get("sent"));
    const blocked = Number(new URL(page.url()).searchParams.get("blocked"));
    assert.ok(sent > 0, "발송된 건이 있어야 한다");
    assert.equal(await n(`SELECT count(*) AS n FROM message WHERE direction='out'`), beforeMsg + sent);
    if (blocked > 0) {
      assert.equal(await n(`SELECT count(*) AS n FROM gate_block`), beforeBlocks + blocked, "막힌 건은 사유가 남아야 한다");
    }

    // 나간 메일은 예외 없이 (광고) 표기를 갖는다
    const noLabel = await n(`SELECT count(*) AS n FROM message
      WHERE direction='out' AND channel='email' AND subject IS NOT NULL AND subject NOT LIKE '(광고)%'`);
    assert.equal(noLabel, 0, "(광고) 표기 없는 발송이 있으면 안 된다");
  });

  test("공구 캘린더 — 셀러 링크는 인스타그램 원문으로 나간다", async () => {
    await page.goto(`${BASE}/feed`);
    const href = await page.locator("a.drow").first().getAttribute("href");
    assert.ok(href?.startsWith("https://www.instagram.com/"), `인스타 링크여야 한다: ${href}`);
    assert.equal(await page.locator("a.drow").first().getAttribute("target"), "_blank");
    assert.match((await page.locator("a.drow").first().getAttribute("rel")) ?? "", /noopener/);
  });

  test("공구 캘린더 — 캘린더 뷰와 날짜 이동", async () => {
    await page.goto(`${BASE}/feed?view=cal`);
    assert.ok((await page.locator(".cal .cell").count()) > 20, "달력 칸이 그려져야 한다");
    await page.goto(`${BASE}/feed`);
    const tomorrow = new Date(Date.now() + 864e5);
    const p2 = (n: number) => String(n).padStart(2, "0");
    const expected = `${tomorrow.getFullYear()}-${p2(tomorrow.getMonth() + 1)}-${p2(tomorrow.getDate())}`;
    await page.getByLabel("다음").click();
    await page.waitForURL(new RegExp(`d=${expected}`), { timeout: 15000 });
    assert.match(page.url(), new RegExp(`d=${expected}`));
  });

  test("원클릭 수신거부 — GET 은 확인만, POST 가 실제로 차단한다", async () => {
    // 모든 발송 메일이 이 URL 을 List-Unsubscribe 헤더로 달고 나간다. 404 면 §50② 회피가 된다.
    const m = await one<{ token: string; creator_id: string; display_name: string }>(
      `SELECT replace(cm.reply_token,'cm_','') AS token, cm.creator_id, c.display_name
         FROM campaign_member cm JOIN creator c ON c.id = cm.creator_id
        WHERE cm.reply_token IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM suppression s
                           WHERE s.identifier_type='creator_id' AND s.identifier_val = cm.creator_id::text)
        LIMIT 1`);
    assert.ok(m, "수신거부 토큰을 가진 대상이 있어야 한다");

    const n = async (sql: string, p: unknown[] = []) => Number((await one<{ n: string }>(sql, p))!.n);
    const before = await n(`SELECT count(*) AS n FROM suppression WHERE identifier_val=$1::text`, [m!.creator_id]);
    assert.equal(before, 0);

    // GET — 메일 스캐너가 링크를 미리 열어보는 것만으로 해지되면 안 된다
    await page.goto(`${BASE}/u/${m!.token}`);
    assert.match(await page.locator("body").innerText(), /수신거부/);
    assert.equal(
      await n(`SELECT count(*) AS n FROM suppression WHERE identifier_val=$1::text`, [m!.creator_id]),
      0, "GET 만으로는 해지되지 않아야 한다");

    // POST — 버튼을 누르면 전 채널 영구 차단
    await submit(page.getByRole("button", { name: "수신거부하기" }));
    assert.match(await page.locator("body").innerText(), /완료/);

    const kinds = (await all<{ identifier_type: string }>(
      `SELECT identifier_type FROM suppression
        WHERE identifier_val = $1::text
           OR identifier_val IN (SELECT handle FROM social_account WHERE creator_id = $1::uuid)
           OR identifier_val IN (SELECT value_norm FROM contact_point WHERE creator_id = $1::uuid)`,
      [m!.creator_id])).map((r) => r.identifier_type);
    assert.ok(kinds.includes("creator_id"), "전 채널 차단이 등재돼야 한다");

    // 시퀀스가 멈추고 배급된 작업도 회수돼야 한다
    const live = await n(
      `SELECT count(*) AS n FROM campaign_member WHERE creator_id=$1::uuid AND engine_state > 0`, [m!.creator_id]);
    assert.equal(live, 0, "살아 있는 시퀀스가 남으면 안 된다");

    // 다시 열면 이미 완료 상태
    await page.goto(`${BASE}/u/${m!.token}`);
    assert.match(await page.locator("body").innerText(), /완료되었습니다/);
  });

  test("가로 스크롤이 생기지 않는다", async () => {
    for (const p of ["/dashboard", "/influencers", "/feed", "/policy", "/campaigns"]) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(BASE + p);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${p} 에서 가로 스크롤 ${overflow}px`);
    }
  });
});
