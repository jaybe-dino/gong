import { all, one } from "./db";

/**
 * 스키마 상태 점검.
 *
 * 마이그레이션을 안 돌린 배포에서 화면이 500 으로 죽고 있었다. 새 테이블
 * (creator_fit · creator_health)을 참조하는 조회가 실패하면 페이지 전체가
 * 렌더링되지 않는다 — 사용자는 "페이지가 안 나온다" 만 보고, 무엇을 해야 하는지
 * 알 수 없다.
 *
 * 없으면 그 기능만 빠지고 화면은 뜨게 한다. 그리고 무엇이 빠졌는지 알려준다.
 */

/** 이 코드가 기대하는 마이그레이션. 파일을 추가하면 여기도 추가한다. */
export const EXPECTED_MIGRATIONS = [
  "003_import_rows.sql",
  "004_creator_fit.sql",
  "005_creator_health.sql",
  "006_dino_dataset.sql",
  "007_app_settings.sql",
];

const tableCache = new Map<string, boolean>();

/**
 * 테이블 존재 확인. 한 번 확인하면 캐시한다.
 *
 * false 를 캐시하는 게 맞는가: 마이그레이션을 적용하면 배포가 새로 뜨거나
 * 함수 인스턴스가 교체되므로 캐시도 사라진다. 요청마다 to_regclass 를 던지는
 * 비용을 매 화면에 얹는 것보다 낫다.
 */
export async function hasTable(name: string): Promise<boolean> {
  const hit = tableCache.get(name);
  if (hit !== undefined) return hit;
  try {
    const r = await one<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    const ok = Boolean(r?.ok);
    tableCache.set(name, ok);
    return ok;
  } catch {
    return false;
  }
}

const colCache = new Map<string, boolean>();

/**
 * 컬럼 존재 확인.
 *
 * 테이블만 보면 부족하다. 마이그레이션이 기존 테이블에 컬럼을 더하는 경우가
 * 있어서(006 이 creator 에 outreach_tier 를 더한다), 테이블은 있는데 컬럼이 없어
 * 화면이 죽는다 — 실제로 "column c.outreach_tier does not exist" 로 죽었다.
 */
export async function hasColumn(table: string, column: string): Promise<boolean> {
  const key = `${table}.${column}`;
  const hit = colCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const r = await one<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_name=$2) AS ok`,
      [table, column]);
    const ok = Boolean(r?.ok);
    colCache.set(key, ok);
    return ok;
  } catch {
    return false;
  }
}

/** 캐시를 버린다. 마이그레이션 적용 직후에 부른다. */
export function invalidateSchemaCache() {
  tableCache.clear();
  colCache.clear();
}

export interface SchemaState {
  applied: string[];
  pending: string[];
  ready: boolean;
}

/** 적용된 마이그레이션과 아직 안 된 것. /setup 화면이 보여준다. */
export async function schemaState(): Promise<SchemaState> {
  if (!(await hasTable("schema_migration"))) {
    return { applied: [], pending: EXPECTED_MIGRATIONS, ready: false };
  }
  const rows = await all<{ filename: string }>(`SELECT filename FROM schema_migration`);
  const applied = new Set(rows.map((r) => r.filename));
  const pending = EXPECTED_MIGRATIONS.filter((m) => !applied.has(m));
  return { applied: [...applied].sort(), pending, ready: pending.length === 0 };
}
