#!/usr/bin/env node
/**
 * 빌드 산출물 검사: db/*.sql 을 런타임에 읽는 라우트에 그 파일이 실제로 들어갔는지 본다.
 *
 * setup-db.mjs 는 스키마를 파일로 읽는다. Next 의 파일 트레이싱은 .sql 을
 * 따라가지 못해서 next.config.ts 의 outputFileTracingIncludes 에 라우트를
 * 하나하나 적어줘야 한다. 적는 걸 잊으면 배포 후에야
 * "db/001_schema.sql 을 찾을 수 없다" 로 터진다 — 그때는 이미 늦다.
 *
 * 판별: 번들이 파일명을 참조하면서 readFileSync 까지 부르면 실제로 읽는 코드다.
 * (문서 화면처럼 파일명만 글로 적은 번들은 걸러진다.)
 *
 * `npm run build` 다음에 돌린다.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = ".next/server/app";
const SCHEMA = "001_schema.sql";

if (!fs.existsSync(ROOT)) {
  console.error("[check-trace] .next/server/app 이 없다. 먼저 next build 를 돌려라.");
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name === "page.js" || e.name === "route.js") out.push(p);
  }
  return out;
}

const bad = [];
const ok = [];
for (const js of walk(ROOT)) {
  const code = fs.readFileSync(js, "utf8");
  if (!code.includes(SCHEMA) || !code.includes("readFileSync")) continue;
  const route = "/" + (path.relative(ROOT, path.dirname(js)).replace(/\\/g, "/") || "");
  const nft = `${js}.nft.json`;
  const traced = fs.existsSync(nft)
    ? (JSON.parse(fs.readFileSync(nft, "utf8")).files ?? []).some((f) => f.endsWith(`db/${SCHEMA}`))
    : false;
  (traced ? ok : bad).push(route);
}

if (!ok.length && !bad.length) {
  console.error(`[check-trace] db/${SCHEMA} 를 읽는 라우트를 못 찾았다. 검사가 무의미해졌다.`);
  process.exit(1);
}
if (bad.length) {
  console.error(`[check-trace] db/*.sql 이 빠진 라우트: ${bad.join(", ")}`);
  console.error("[check-trace] next.config.ts 의 outputFileTracingIncludes 에 추가해라.");
  process.exit(1);
}
console.log(`[check-trace] ${ok.join(", ")} — db/*.sql 포함됨`);
