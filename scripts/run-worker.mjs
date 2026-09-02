#!/usr/bin/env node
/**
 * 워커 러너.
 *
 * Vercel 서버리스에는 상주 프로세스가 없다. 두 가지로 쓴다:
 *   - 로컬/서버:  node scripts/run-worker.mjs          (루프)
 *   - 크론 1회:   node scripts/run-worker.mjs --once   (Vercel Cron 등)
 *
 * 각 잡의 주기는 환경변수로 조정한다.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("../tests/ts-resolve.mjs", pathToFileURL("./scripts/"));

const seq = await import("../src/lib/jobs/sequence-worker.ts");
const inbound = await import("../src/lib/jobs/inbound-sync.ts");
const breaker = await import("../src/lib/jobs/circuit-breaker.ts");
const { pool } = await import("../src/lib/db.ts");

const ONCE = process.argv.includes("--once");
const SEQ_MS = Number(process.env.SEQ_INTERVAL_MS ?? 60_000);
const INBOUND_MS = Number(process.env.INBOUND_INTERVAL_MS ?? 120_000);
const BREAKER_MS = Number(process.env.BREAKER_INTERVAL_MS ?? 300_000);

const log = (name, v) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${name}`, JSON.stringify(v));

async function safe(name, fn) {
  try {
    log(name, await fn());
  } catch (e) {
    console.error(`[${name}] 실패:`, e.message);
  }
}

async function once() {
  // 하루가 바뀌었으면 카운터를 리셋하고 워밍업 램프를 한 칸 올린다.
  await safe("resetDaily", () => breaker.resetDaily());
  await safe("rampUp", () => breaker.rampUp());
  await safe("breaker", () => breaker.tick());
  await safe("inbound", () => inbound.tick());
  await safe("sequence", () => seq.tick());
}

if (ONCE) {
  await once();
  await pool().end();
  process.exit(0);
}

console.log(`[worker] 시작 · 시퀀스 ${SEQ_MS}ms · 수신 ${INBOUND_MS}ms · 브레이커 ${BREAKER_MS}ms`);
await once();
const timers = [
  setInterval(() => safe("sequence", () => seq.tick()), SEQ_MS),
  setInterval(() => safe("inbound", () => inbound.tick()), INBOUND_MS),
  setInterval(() => safe("breaker", () => breaker.tick()), BREAKER_MS),
];
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.log("[worker] 종료");
    timers.forEach(clearInterval);
    await pool().end();
    process.exit(0);
  });
}
