import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.GONG_DB ?? path.join(process.cwd(), "data", "app.db");

let _db: Database.Database | null = null;

/** 프로세스당 하나의 연결을 재사용한다. Next 의 dev HMR 에서도 재생성되지 않도록 전역에 붙인다. */
export function db(): Database.Database {
  const g = globalThis as unknown as { __gongDb?: Database.Database };
  if (g.__gongDb) return g.__gongDb;
  if (_db) return _db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");

  const schema = fs.readFileSync(path.join(process.cwd(), "src", "lib", "schema.sql"), "utf8");
  conn.exec(schema);

  _db = conn;
  g.__gongDb = conn;
  return conn;
}

export function all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return db().prepare(sql).all(...(params as never[])) as T[];
}

export function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
  return db().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(sql: string, params: unknown[] = []) {
  return db().prepare(sql).run(...(params as never[]));
}
