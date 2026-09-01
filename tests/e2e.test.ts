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
const DB = path.join(process.cwd(), "data", "test-e2e.db");

// db.ts 는 모듈 로드 시점에 GONG_DB 를 읽는다. 아래 import 보다 먼저 설정해야
// 테스트가 개발용 data/app.db 가 아니라 전용 DB 를 본다.
process.env.GONG_DB = DB;
process.env.GONG_TODAY = "2026-09-01";

let server: ChildProcess;
let browser: Browser;
let page: Page;

const { one } = await import("../src/lib/db.ts");

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
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(DB + s, { force: true });
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, ["scripts/init-db.mjs", "--force"], { env: { ...process.env, GONG_DB: DB }, stdio: "pipe" });

  // 포트가 이미 잡혀 있으면 이전 실행의 서버가 살아 있다는 뜻이다.
  // 그 서버는 지워진 DB 파일을 붙들고 있어서, 그대로 두면 테스트가 조용히 잘못된 DB 를 본다.
  await assertPortFree();

  // npx 를 거치면 실제 서버가 손자 프로세스가 되어 kill 이 닿지 않는다.
  // next 바이너리를 직접 띄우고 프로세스 그룹째 정리한다.
  server = spawn(process.execPath, [path.join("node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], {
    env: { ...process.env, GONG_DB: DB, GONG_TODAY: "2026-09-01" },
    stdio: "ignore",
    detached: true,
  });
  await waitForServer();

  browser = await chromium.launch({ executablePath: chromiumPath() });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
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
    assert.match(text, /케이던스 타이밍|타이밍/);
    await page.locator(".drawer").getByText("닫기").click();
    await page.waitForSelector(".drawer", { state: "detached" });
  });

  test("작업 큐 완료 처리가 DB 에 반영된다", async () => {
    await page.goto(`${BASE}/queue`);
    const before = one<{ n: number }>(`SELECT COUNT(*) AS n FROM task WHERE status='pending'`)!.n;
    const beforeLogs = one<{ n: number }>(`SELECT COUNT(*) AS n FROM outreach_log`)!.n;

    await submit(page.locator("tbody form button[type=submit]").first());

    const after = one<{ n: number }>(`SELECT COUNT(*) AS n FROM task WHERE status='pending'`)!.n;
    assert.equal(after, before - 1, "대기 작업이 하나 줄어야 한다");
    assert.ok(one<{ n: number }>(`SELECT COUNT(*) AS n FROM outreach_log`)!.n > beforeLogs, "발송 기록이 남아야 한다");
  });

  test("회신을 '연락 금지'로 분류하면 수신거부에 영구 등록된다", async () => {
    await page.goto(`${BASE}/inbox`);
    // 아직 분류되지 않은 스레드(심플데일리)를 고른다
    await page.locator("a.ithread", { hasText: "심플데일리" }).first().click();
    await page.waitForLoadState("networkidle");
    await page.waitForSelector("select[name=classification]");

    const handle = "simple_daily_k";
    assert.equal(
      one<{ n: number }>(`SELECT COUNT(*) AS n FROM suppression WHERE identifier=?`, [`@${handle}`])!.n,
      0,
      "사전 조건: 아직 차단되지 않은 상태",
    );

    await page.locator("select[name=classification]").selectOption({ label: "-4 연락 금지 (영구 차단)" });
    await submit(page.getByRole("button", { name: "분류 저장" }));

    assert.equal(
      one<{ n: number }>(`SELECT COUNT(*) AS n FROM suppression WHERE identifier=?`, [`@${handle}`])!.n,
      1,
      "핸들이 수신거부 목록에 등록돼야 한다",
    );
    const stage = one<{ stage: string }>(
      `SELECT stage FROM campaign_target WHERE creator_id=(SELECT creator_id FROM social_account WHERE handle=?)`,
      [handle],
    );
    if (stage) assert.equal(stage.stage, "dropped");
  });

  test("CSV 를 올리면 파싱·중복 검사를 거쳐 검토 큐가 생긴다", async () => {
    await page.goto(`${BASE}/import?step=1`);
    await page.setInputFiles("input[type=file]", "samples/09pangpang_sample.csv");
    await submit(page.getByRole("button", { name: "업로드 후 중복 검사" }));
    await page.waitForURL(/step=3/, { timeout: 30000 });

    assert.match(page.url(), /step=3&batch=\d+/, `업로드 후 3단계로 가야 한다: ${page.url()}`);
    const body = await page.locator(".screen").innerText();
    assert.match(body, /읽은 행/);
    assert.match(body, /검토 큐/);

    const batch = one<{ id: number; rows: number; errors: number }>(
      `SELECT id, rows, errors FROM import_batch ORDER BY id DESC LIMIT 1`,
    )!;
    assert.equal(batch.rows, 8);
    assert.equal(batch.errors, 1);
  });

  test("검토 행을 병합 처리하고 배치를 반영하면 크리에이터가 늘어난다", async () => {
    const before = one<{ n: number }>(`SELECT COUNT(*) AS n FROM creator`)!.n;

    const mergeBtn = page.getByRole("button", { name: "병합" }).first();
    if (await mergeBtn.count()) {
      await submit(mergeBtn);
    }

    await submit(page.getByRole("button", { name: /건 반영$/ }));
    await page.waitForURL(/step=4/, { timeout: 30000 });

    assert.match(page.url(), /step=4/);
    assert.match(await page.locator(".screen").innerText(), /건 반영 완료/);
    assert.ok(one<{ n: number }>(`SELECT COUNT(*) AS n FROM creator`)!.n > before, "신규 크리에이터가 들어와야 한다");
    assert.equal(one<{ status: string }>(`SELECT status FROM import_batch ORDER BY id DESC LIMIT 1`)!.status, "applied");
  });

  test("제안 발송 — 게이트를 통과하면 발송 기록과 작업 큐가 생성된다", async () => {
    await page.goto(`${BASE}/send?step=3`);
    const gate = await page.locator(".gate").innerText();
    assert.match(gate, /수신거부/);
    assert.match(gate, /List-Unsubscribe/);

    const beforeRuns = one<{ n: number }>(`SELECT COUNT(*) AS n FROM send_run`)!.n;
    const beforeLogs = one<{ n: number }>(`SELECT COUNT(*) AS n FROM outreach_log`)!.n;

    const btn = page.getByRole("button", { name: /건 발송 시작$/ });
    assert.equal(await btn.count(), 1, "발송 버튼이 있어야 한다");
    await submit(btn);
    await page.waitForURL(/sent=\d+/, { timeout: 60000 });

    assert.match(page.url(), /sent=\d+/);
    assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM send_run`)!.n, beforeRuns + 1);
    assert.ok(one<{ n: number }>(`SELECT COUNT(*) AS n FROM outreach_log`)!.n > beforeLogs);
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
    await page.getByLabel("다음").click();
    await page.waitForLoadState("networkidle");
    assert.match(page.url(), /d=2026-09-02/);
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
