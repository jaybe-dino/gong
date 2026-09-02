#!/usr/bin/env node
// 스키마 + 정책 시드 적용. drop 이면 public 스키마를 통째로 다시 만든다.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

export const SQL_FILES = ["001_schema.sql", "002_seed_policy.sql"];

/**
 * db/*.sql 을 찾는다. 로컬 CLI 는 이 파일 기준 상위, 서버는 process.cwd() 가 앱 루트다.
 * 번들러를 거치면 import.meta.dirname 이 없어지므로 있을 때만 후보에 넣는다.
 */
export function sqlDir() {
  const bases = [process.cwd()];
  if (import.meta.dirname) bases.push(path.resolve(import.meta.dirname, ".."));
  for (const base of bases) {
    const dir = path.join(base, "db");
    if (fs.existsSync(path.join(dir, SQL_FILES[0]))) return dir;
  }
  throw new Error(`db/${SQL_FILES[0]} 을 찾을 수 없다 (탐색: ${bases.join(", ")})`);
}

const TABLE_COUNT = `SELECT count(*)::int AS n FROM information_schema.tables
                     WHERE table_schema='public' AND table_type='BASE TABLE'`;

/**
 * 스키마와 정책 시드를 적용한다. CLI(`npm run db:setup`)와 초기화 라우트가 같이 쓴다.
 *
 * 001_schema.sql 은 재실행 안전하지 않다(CREATE TABLE 에 IF NOT EXISTS 를 쓰지 않는다 —
 * 제약과 인덱스까지 조건부로 만들면 스키마가 읽기 어려워진다). 그래서 이미 테이블이 있는
 * DB 에서는 아무것도 하지 않고 물러난다. 갈아엎으려면 drop 을 명시해야 한다.
 */
export async function setupDb(opts = {}) {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "postgres://postgres@127.0.0.1:5433/gong";
  const ssl = /neon\.tech|vercel-storage|supabase|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined;
  const client = new pg.Client({ connectionString: url, ssl });
  await client.connect();
  try {
    if (opts.drop) {
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    } else {
      const before = (await client.query(TABLE_COUNT)).rows[0].n;
      if (before > 0) return { skipped: true, tables: before };
    }
    const dir = sqlDir();
    for (const file of SQL_FILES) {
      await client.query(fs.readFileSync(path.join(dir, file), "utf8"));
    }
    const { rows } = await client.query(TABLE_COUNT);
    return { dropped: Boolean(opts.drop), applied: SQL_FILES, tables: rows[0].n };
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await setupDb({ drop: process.argv.includes("--drop") });
  if (r.skipped) {
    console.log(`[setup-db] 이미 스키마가 있다 (테이블 ${r.tables}개). --drop 으로 재생성.`);
  } else {
    if (r.dropped) console.log("[setup-db] public 스키마 재생성");
    for (const f of r.applied) console.log(`[setup-db] ${f} 적용`);
    console.log(`[setup-db] 테이블 ${r.tables}개`);
  }
}
