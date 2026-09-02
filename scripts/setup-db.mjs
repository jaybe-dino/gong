#!/usr/bin/env node
// 스키마 + 정책 시드 적용. --drop 이면 public 스키마를 통째로 다시 만든다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "postgres://postgres@127.0.0.1:5433/gong";
const ssl = /neon\.tech|vercel-storage|supabase|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined;

const client = new pg.Client({ connectionString: url, ssl });
await client.connect();

if (process.argv.includes("--drop")) {
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  console.log("[setup-db] public 스키마 재생성");
}

for (const file of ["001_schema.sql", "002_seed_policy.sql"]) {
  const sql = fs.readFileSync(path.join(root, "db", file), "utf8");
  await client.query(sql);
  console.log(`[setup-db] ${file} 적용`);
}

const { rows } = await client.query(
  `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`,
);
console.log(`[setup-db] 테이블 ${rows[0].n}개`);
await client.end();
