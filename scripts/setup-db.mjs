#!/usr/bin/env node
// 스키마 적용. 001·002 는 빈 DB 에만, 003 부터는 마이그레이션으로 항상 적용한다.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

/** 빈 DB 에만 적용하는 기준 스키마. 재실행 안전하지 않다. */
export const BASE_FILES = ["001_schema.sql", "002_seed_policy.sql"];

/**
 * db/*.sql 을 찾는다. 로컬 CLI 는 이 파일 기준 상위, 서버는 process.cwd() 가 앱 루트다.
 * 번들러를 거치면 import.meta.dirname 이 없어지므로 있을 때만 후보에 넣는다.
 */
export function sqlDir() {
  const bases = [process.cwd()];
  if (import.meta.dirname) bases.push(path.resolve(import.meta.dirname, ".."));
  for (const base of bases) {
    const dir = path.join(base, "db");
    if (fs.existsSync(path.join(dir, BASE_FILES[0]))) return dir;
  }
  throw new Error(`db/${BASE_FILES[0]} 을 찾을 수 없다 (탐색: ${bases.join(", ")})`);
}

/** 003 이상. 번호 순으로 정렬해 돌린다. */
export function migrationFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) >= 3)
    .sort();
}

const TABLE_COUNT = `SELECT count(*)::int AS n FROM information_schema.tables
                     WHERE table_schema='public' AND table_type='BASE TABLE'`;

/**
 * 스키마를 적용한다. CLI(`npm run db:setup`)·초기화 화면·API 가 같이 쓴다.
 *
 * 001_schema.sql 은 재실행 안전하지 않다 (CREATE TABLE 에 IF NOT EXISTS 를 쓰지 않는다 —
 * 제약과 인덱스까지 조건부로 만들면 스키마가 읽기 어려워진다). 그래서 이미 테이블이
 * 있는 DB 에서는 기준 스키마를 건너뛰고 마이그레이션만 올린다. 갈아엎으려면 drop 을
 * 명시해야 한다.
 *
 * 마이그레이션은 schema_migration 에 기록해 두 번 돌지 않게 한다. 파일 자체도
 * 멱등하게 쓰지만, 기록이 있으면 무엇이 적용됐는지 눈으로 확인할 수 있다.
 */
export async function setupDb(opts = {}) {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "postgres://postgres@127.0.0.1:5433/gong";
  const ssl = /neon\.tech|vercel-storage|supabase|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined;
  const client = new pg.Client({ connectionString: url, ssl });
  await client.connect();
  try {
    const dir = sqlDir();
    const out = { dropped: Boolean(opts.drop), base: [], migrations: [], tables: 0 };

    if (opts.drop) await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const hadTables = !opts.drop && (await client.query(TABLE_COUNT)).rows[0].n > 0;

    if (!hadTables) {
      for (const f of BASE_FILES) {
        await client.query(fs.readFileSync(path.join(dir, f), "utf8"));
        out.base.push(f);
      }
    }

    // 마이그레이션 추적 테이블은 003 안에 있지만, 그 003 을 돌리려면 먼저 있어야 한다.
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migration (
         filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set(
      (await client.query("SELECT filename FROM schema_migration")).rows.map((r) => r.filename),
    );
    for (const f of migrationFiles(dir)) {
      if (done.has(f)) continue;
      await client.query(fs.readFileSync(path.join(dir, f), "utf8"));
      await client.query("INSERT INTO schema_migration (filename) VALUES ($1) ON CONFLICT DO NOTHING", [f]);
      out.migrations.push(f);
    }

    out.tables = (await client.query(TABLE_COUNT)).rows[0].n;
    out.skippedBase = hadTables;
    return out;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await setupDb({ drop: process.argv.includes("--drop") });
  if (r.dropped) console.log("[setup-db] public 스키마 재생성");
  if (r.skippedBase) console.log("[setup-db] 기준 스키마는 이미 있다 — 건너뜀");
  for (const f of r.base) console.log(`[setup-db] ${f} 적용`);
  for (const f of r.migrations) console.log(`[setup-db] ${f} 마이그레이션 적용`);
  if (!r.base.length && !r.migrations.length) console.log("[setup-db] 새로 적용할 것 없음");
  console.log(`[setup-db] 테이블 ${r.tables}개`);
}
