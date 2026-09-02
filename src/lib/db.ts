import { Pool, type PoolClient, type QueryResultRow } from "pg";

/**
 * Postgres 접속.
 *
 * Vercel 서버리스는 인스턴스가 자주 뜨고 지므로 풀을 작게 잡고 전역에 붙여 재사용한다.
 * Neon / Vercel Postgres 는 풀러 엔드포인트(-pooler)를 쓰는 것을 권한다.
 */
const CONNECTION =
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL ??
  "postgres://postgres@127.0.0.1:5433/gong";

function needsSsl(url: string) {
  if (/sslmode=disable/.test(url)) return false;
  if (/sslmode=require|neon\.tech|vercel-storage|supabase|amazonaws/.test(url)) return true;
  return !/localhost|127\.0\.0\.1/.test(url);
}

export function pool(): Pool {
  const g = globalThis as unknown as { __gongPool?: Pool };
  if (g.__gongPool) return g.__gongPool;
  const p = new Pool({
    connectionString: CONNECTION,
    max: Number(process.env.PGPOOL_MAX ?? 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl: needsSsl(CONNECTION) ? { rejectUnauthorized: false } : undefined,
  });
  p.on("error", (err) => console.error("[pg] idle client error", err.message));
  g.__gongPool = p;
  return p;
}

/** 여러 행. */
export async function all<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool().query<T>(text, params as never[]);
  return res.rows;
}

/** 첫 행 또는 undefined. */
export async function one<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const res = await pool().query<T>(text, params as never[]);
  return res.rows[0];
}

/** 반환값이 필요 없는 실행. 영향받은 행 수를 돌려준다. */
export async function run(text: string, params: unknown[] = []): Promise<number> {
  const res = await pool().query(text, params as never[]);
  return res.rowCount ?? 0;
}

/** 스칼라 하나. */
export async function scalar<T>(text: string, params: unknown[] = []): Promise<T | null> {
  const res = await pool().query(text, params as never[]);
  if (!res.rows.length) return null;
  return Object.values(res.rows[0])[0] as T;
}

/**
 * 트랜잭션. 콜백이 던지면 롤백한다.
 * 발송·임포트 반영처럼 중간에 끊기면 안 되는 작업에만 쓴다.
 */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** 트랜잭션 안에서 쓰는 헬퍼. */
export async function txAll<T extends QueryResultRow = QueryResultRow>(
  c: PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await c.query<T>(text, params as never[])).rows;
}
export async function txOne<T extends QueryResultRow = QueryResultRow>(
  c: PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await c.query<T>(text, params as never[])).rows[0];
}
