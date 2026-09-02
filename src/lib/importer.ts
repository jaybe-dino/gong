import { all, one, run, tx } from "./db";
import { parseCsv, splitRecords, toObjects } from "./csv";
import {
  normName, parseCategoryShare, parseCount, parseDate, parseFirstInt,
  parseFollowers, parsePeriod, parsePrice, parseRelativeTime,
} from "./parse";
import { normalizeHandle, slugWarning } from "./handle";
import { buildIndex, decide, findBest, type Candidate, type Incoming } from "./dedupe";

/**
 * CSV 임포터.
 *
 * 세 소스가 기여하는 고유 필드가 달라 하나로 대체되지 않는다.
 *   momcal   브랜드 마스터 · 큐레이션 플래그
 *   pangpang 팔로워/팔로잉/게시물 3종 · 가격 · 오픈 시각
 *   ingong   30·90일 딜 수 · 평균 간격 · 카테고리 점유율
 *
 * dry-run 으로 분석해 import_batch 에 담고, 사람이 검토 큐를 처리한 뒤에야 커밋한다.
 */

export type SourceKey = "momcal" | "pangpang" | "ingong";

export interface SourceProfile {
  key: SourceKey;
  name: string;
  site: string;
  blurb: string;
  fields: { column: string; target: string; note?: string; rule?: "auto" | "parse" | "keep" }[];
  forbiddenKeys?: { column: string; reason: string }[];
}

export const SOURCES: Record<SourceKey, SourceProfile> = {
  momcal: {
    key: "momcal", name: "맘캘린더", site: "momcalendar.com",
    blurb: "브랜드 마스터 · 셀러 · 반복 제품 · 사람이 검증한 큐레이션 플래그",
    fields: [
      { column: "handle", target: "social_account.handle", note: "상세 페이지의 실제 @핸들", rule: "auto" },
      { column: "seller", target: "creator.display_name", rule: "auto" },
      { column: "brand", target: "brand.name", note: "브랜드 사전의 기준 표기", rule: "auto" },
      { column: "product", target: "deal.title", rule: "auto" },
      { column: "period", target: "deal.open_date / close_date", note: '"2026-09-01 ~ 09-07" 파싱', rule: "parse" },
      { column: "curated", target: "creator.is_curated", note: "사람 검증 플래그", rule: "auto" },
      { column: "slug", target: "source_ref.source_pk", note: "역추적용으로만 보존", rule: "keep" },
      { column: "url", target: "source_ref.source_url", rule: "keep" },
    ],
    forbiddenKeys: [{
      column: "slug",
      reason: "슬러그(de-elisa-shop)는 '.' 과 '_' 를 모두 '-' 로 치환한 결과라 역변환이 불가능합니다. 상세 페이지에 표기된 실제 @핸들 컬럼을 매칭 키로 지정하세요.",
    }],
  },
  pangpang: {
    key: "pangpang", name: "공구팡팡", site: "09pangpang.com",
    blurb: "팔로워 · 팔로잉 · 게시물 3종 + 가격 + 오픈 시각 + 2단계 카테고리 + 해시태그",
    fields: [
      { column: "handle", target: "social_account.handle", note: "정규화 후 매칭 키", rule: "auto" },
      { column: "display_name", target: "creator.display_name", rule: "auto" },
      { column: "팔로워", target: "account_snapshot.followers", note: '"10.8만" → 108000, 정밀도 ±500', rule: "parse" },
      { column: "팔로잉", target: "account_snapshot.following", rule: "auto" },
      { column: "게시물", target: "account_snapshot.posts_count", rule: "auto" },
      { column: "마지막활동", target: "account_snapshot.last_active_at", note: '"약 1시간 전" → 절대시각', rule: "parse" },
      { column: "account_id", target: "source_ref.source_pk", note: "팡팡 안에서의 계정 번호. 같은 소스끼리만 비교한다", rule: "keep" },
      { column: "상품명/가격/오픈일", target: "deal.*", rule: "parse" },
      { column: "profile_url", target: "source_ref.source_url", rule: "keep" },
    ],
  },
  ingong: {
    key: "ingong", name: "인공", site: "insta-gong.com",
    blurb: "최근 30·90일 딜 수 · 평균 공구 간격 · 마지막 공구 경과일 · 카테고리 점유율 · 지역",
    fields: [
      { column: "handle", target: "social_account.handle", rule: "auto" },
      { column: "name", target: "creator.display_name", rule: "auto" },
      { column: "30일", target: "account_snapshot.deals_30d", note: '"30일 35건" → 35 (30은 기간)', rule: "parse" },
      { column: "90일", target: "account_snapshot.deals_90d", rule: "parse" },
      { column: "평균간격", target: "account_snapshot.avg_interval_days", note: "케이던스 타이밍의 기준값", rule: "parse" },
      { column: "마지막공구", target: "account_snapshot.days_since_last", rule: "parse" },
      { column: "카테고리점유율", target: "account_snapshot.category_share", note: '"리빙 61%, ..." → jsonb', rule: "parse" },
      { column: "uuid", target: "source_ref.source_pk", rule: "keep" },
      { column: "region", target: "creator.home_region", rule: "auto" },
    ],
  },
};

const pick = (raw: Record<string, string>, keys: string[]): string | null => {
  for (const k of keys) {
    const found = Object.keys(raw).find((h) => h.toLowerCase() === k.toLowerCase());
    if (found && raw[found]) return raw[found];
  }
  return null;
};

/** 헤더에서 핸들 컬럼을 추론한다. 슬러그류는 후보에서 제외한다. */
export function inferHandleColumn(headers: string[], source: SourceKey): string | null {
  const forbidden = new Set((SOURCES[source].forbiddenKeys ?? []).map((f) => f.column.toLowerCase()));
  const prefer = ["handle", "instagram", "insta", "아이디", "계정"];
  const candidates = headers.filter((h) => !forbidden.has(h.toLowerCase()));
  for (const p of prefer) {
    const hit = candidates.find((h) => h.toLowerCase().includes(p));
    if (hit) return hit;
  }
  return null;
}

/** unmatched = 담기만 하고 아직 대조하지 않은 상태. */
export type RowVerdict = "unmatched" | "new" | "merge" | "review" | "error";

export interface AnalyzedRow {
  line: number;
  raw: Record<string, string>;
  handle: string | null;
  verdict: RowVerdict;
  score: number;
  evidence: string | null;
  candidateId: string | null;
  candidateHandle: string | null;
  handleChanged?: boolean;
}

/** 행 하나를 우리 스키마 조각으로 정규화한다. */
export function normalizeRow(raw: Record<string, string>, source: SourceKey) {
  const handle = normalizeHandle(pick(raw, ["handle", "instagram", "insta", "계정", "아이디"]) ?? "");
  const followers = parseFollowers(pick(raw, ["팔로워", "followers"]));
  const following = parseFollowers(pick(raw, ["팔로잉", "following"]));
  const posts = parseFollowers(pick(raw, ["게시물", "posts", "posts_count"]));
  const lastActive = parseRelativeTime(pick(raw, ["마지막활동", "last_active"]));
  const [openDate, closeDate] = parsePeriod(pick(raw, ["period", "기간"]), new Date().getFullYear());
  return {
    handle,
    displayName: pick(raw, ["display_name", "seller", "name", "이름", "셀러"]),
    platformUserId: pick(raw, ["account_id", "uuid", "source_pk", "id"]),
    slug: pick(raw, ["slug"]),
    region: pick(raw, ["region", "지역"]),
    curated: /^(y|yes|true|1)$/i.test(pick(raw, ["curated", "검증"]) ?? ""),
    followers: followers?.value ?? null,
    followersPrecision: followers?.precision ?? null,
    following: following?.value ?? null,
    posts: posts?.value ?? null,
    lastActive,
    deals30: parseCount(pick(raw, ["30일", "deals_30d"])),
    deals90: parseCount(pick(raw, ["90일", "deals_90d"])),
    avgInterval: parseFirstInt(pick(raw, ["평균간격", "avg_interval"])),
    daysSinceLast: parseFirstInt(pick(raw, ["마지막공구", "last_deal"])),
    categoryShare: parseCategoryShare(pick(raw, ["카테고리점유율", "category_share"])),
    brand: pick(raw, ["brand", "브랜드"]),
    product: pick(raw, ["product", "상품명", "제품"]),
    price: parsePrice(pick(raw, ["가격", "price"])),
    openDate: openDate ?? parseDate(pick(raw, ["오픈일", "open"]), new Date().getFullYear()),
    closeDate,
    category: pick(raw, ["카테고리", "category"]),
    sourceUrl: pick(raw, ["profile_url", "url", "detail_url"]),
    source,
  };
}

/** 미리보기로 화면에 내려보내는 행 수. 전체는 import_row 테이블에 담는다. */
export const PREVIEW_ROWS = 200;

/** 한 요청에서 커밋할 기본 행 수. 서버리스 실행 시간 제한 안에 끝나야 한다. */
export const COMMIT_CHUNK = 3000;

/** 다중 행 INSERT. 파라미터 상한(65535)을 넘지 않게 잘라 넣는다. */
async function insertRows(batchId: string, rows: AnalyzedRow[]) {
  const cols = ["batch_id", "line", "handle", "verdict", "score", "evidence",
                "candidate_id", "candidate_handle", "handle_changed", "raw"];
  const per = cols.length;
  const chunk = Math.max(1, Math.floor(60000 / per));
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const values: string[] = [];
    const params: unknown[] = [];
    slice.forEach((r, ri) => {
      values.push(`(${cols.map((_, ci) => `$${ri * per + ci + 1}`).join(",")})`);
      params.push(batchId, r.line, r.handle, r.verdict, r.score, r.evidence,
        r.candidateId, r.candidateHandle, r.handleChanged ?? false, JSON.stringify(r.raw));
    });
    await run(
      `INSERT INTO import_row (${cols.join(",")}) VALUES ${values.join(",")}
       ON CONFLICT (batch_id, line) DO NOTHING`,
      params,
    );
  }
}

/** 한 요청에서 대조할 기본 행 수. */
export const MATCH_CHUNK = 5000;

/**
 * 판정 결과를 한 문장으로 반영한다.
 *
 * 행마다 UPDATE 를 날리면 5,000행에 왕복이 5,000번이다 — 측정으로 청크당 6초가
 * 여기에 들어갔다. VALUES 로 묶어 한 번에 갱신한다.
 */
async function bulkUpdateVerdicts(
  rows: (Omit<AnalyzedRow, "line" | "raw"> & { id: string })[],
) {
  if (!rows.length) return;
  const per = 8;
  const chunk = Math.max(1, Math.floor(60000 / per));
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const values: string[] = [];
    const params: unknown[] = [];
    slice.forEach((r, ri) => {
      const b = ri * per;
      values.push(
        `($${b + 1}::bigint,$${b + 2}::text,$${b + 3}::text,$${b + 4}::numeric,` +
          `$${b + 5}::text,$${b + 6}::uuid,$${b + 7}::text,$${b + 8}::boolean)`,
      );
      params.push(r.id, r.handle, r.verdict, r.score, r.evidence,
        r.candidateId, r.candidateHandle, r.handleChanged ?? false);
    });
    await run(
      `UPDATE import_row r SET
         handle = v.handle, verdict = v.verdict, score = v.score, evidence = v.evidence,
         candidate_id = v.candidate_id, candidate_handle = v.candidate_handle,
         handle_changed = v.handle_changed
       FROM (VALUES ${values.join(",")})
         AS v(id, handle, verdict, score, evidence, candidate_id, candidate_handle, handle_changed)
       WHERE r.id = v.id`,
      params,
    );
  }
}

/**
 * 1단계-a: 배치를 열기만 한다.
 *
 * 큰 파일은 한 요청에 못 올린다. Next 서버 액션의 기본 본문 한도가 1 MB 이고
 * Vercel 은 요청 본문을 4.5 MB 로 막는다. 1.9만 행 CSV 가 2.8 MB 였다 —
 * 컬럼이 조금만 늘어도 넘는다. 그래서 화면이 파일을 잘라서 여러 번 올린다.
 */
export async function beginStage(
  source: SourceKey,
  filename: string,
  userId: string,
  headerLine: string,
): Promise<string | null> {
  const headers = (parseCsv(headerLine)[0] ?? []).map((h) => h.trim());
  if (!headers.length) return null;
  const handleCol = inferHandleColumn(headers, source);
  const batch = await one<{ id: string }>(
    `INSERT INTO import_batch (source, filename, uploaded_by, rows_read, state, report)
     VALUES ($1,$2,$3,0,'staging',$4) RETURNING id`,
    [source, filename, userId, JSON.stringify({ headers, handleColumn: handleCol })],
  );
  return batch?.id ?? null;
}

/**
 * 1단계-b: 레코드 한 덩이를 담는다. 대조는 하지 않는다.
 *
 * startLine 은 파일에서의 실제 행 번호다(헤더가 1행). 청크마다 다시 세면
 * 번호가 겹쳐서 UNIQUE (batch_id, line) 에 걸린다.
 */
export async function stageRows(
  batchId: string,
  headerLine: string,
  records: string[],
  startLine: number,
): Promise<number> {
  if (!records.length) return 0;
  const { records: objs } = toObjects(parseCsv([headerLine, ...records].join("\n")));
  await insertRows(
    batchId,
    objs.map((raw, i) => ({
      line: startLine + i, raw, handle: null, verdict: "unmatched" as const,
      score: 0, evidence: null, candidateId: null, candidateHandle: null,
    })),
  );
  return objs.length;
}

/** 1단계-c: 담기 종료. 읽은 행 수를 확정한다. */
export async function endStage(batchId: string): Promise<number> {
  const r = await one<{ n: number }>(
    `UPDATE import_batch b SET rows_read = (SELECT count(*) FROM import_row WHERE batch_id=b.id)
      WHERE b.id=$1 RETURNING rows_read AS n`,
    [batchId],
  );
  return r?.n ?? 0;
}

/**
 * 담기 전체를 한 번에. CLI·테스트·작은 파일용 편의 함수다.
 * 화면은 청크로 나눠 beginStage → stageRows(반복) → endStage 를 부른다.
 */
export async function stageCsv(text: string, source: SourceKey, filename: string, userId: string): Promise<string | null> {
  const recs = splitRecords(text);
  if (recs.length < 2) return null;
  const [headerLine, ...rows] = recs;
  const batchId = await beginStage(source, filename, userId, headerLine);
  if (!batchId) return null;
  await stageRows(batchId, headerLine, rows, 2);
  await endStage(batchId);
  return batchId;
}

export interface MatchResultCounts {
  matched: number;
  remaining: number;
  done: boolean;
}

/**
 * 2단계: 담긴 행을 기존 모집단과 대조한다. 최대 limit 행씩.
 *
 * 후보 인덱스는 호출마다 다시 만든다. 1.9만 명 로드 + 인덱스 구축이 1초 정도라
 * 청크 몇 번에 나눠도 부담이 크지 않다. 대신 전수 비교(측정 121초)를 없앴다.
 */
export async function matchBatch(batchId: string, opts: { limit?: number } = {}): Promise<MatchResultCounts> {
  const limit = opts.limit ?? MATCH_CHUNK;
  const batch = await one<{ source: SourceKey; report: { handleColumn: string | null } }>(
    `SELECT source, report FROM import_batch WHERE id=$1`, [batchId],
  );
  if (!batch) throw new Error("배치를 찾을 수 없습니다");

  const todo = await all<{ id: string; raw: Record<string, string> }>(
    `SELECT id, raw FROM import_row WHERE batch_id=$1 AND verdict='unmatched' ORDER BY line LIMIT $2`,
    [batchId, limit],
  );

  if (todo.length) {
    const existing = await all<Candidate & { creator_id: string }>(
      `SELECT c.id, c.display_name, sa.handle, c.id AS creator_id,
              (SELECT followers FROM account_snapshot s WHERE s.social_account_id=sa.id ORDER BY s.captured_at DESC LIMIT 1) AS followers,
              -- 소스별로 PK 를 배열로 모은다. jsonb_object_agg 에 (source, pk) 를 그대로
              -- 넣으면 같은 소스의 PK 가 여러 개일 때 하나만 남고 나머지가 조용히 버려진다.
              (SELECT jsonb_object_agg(g.source, g.pks) FROM (
                 SELECT sr.source, jsonb_agg(DISTINCT sr.source_pk) AS pks
                   FROM source_ref sr
                  WHERE sr.entity='creator' AND sr.entity_id=c.id
                  GROUP BY sr.source) g) AS source_pks
         FROM creator c JOIN social_account sa ON sa.creator_id=c.id WHERE c.merged_into IS NULL`,
    );
    const index = buildIndex(existing);
    const handleCol = batch.report?.handleColumn ?? null;
    const forbiddenHandleCol =
      handleCol !== null && (SOURCES[batch.source].forbiddenKeys ?? []).some((f) => f.column === handleCol);

    const verdicts = todo.map((row) => ({
      id: row.id,
      ...classifyRow(row.raw, batch.source, index, forbiddenHandleCol),
    }));
    await bulkUpdateVerdicts(verdicts);
  }

  const remaining = (await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM import_row WHERE batch_id=$1 AND verdict='unmatched'`, [batchId],
  ))!.n;
  const done = remaining === 0;

  if (done) await finishMatching(batchId);
  return { matched: todo.length, remaining, done };
}

/** 대조가 끝나면 집계와 검토 큐를 만든다. */
async function finishMatching(batchId: string) {
  await run(
    `INSERT INTO merge_candidate (batch_id, import_row_id, incoming, candidate_id, score, evidence, decision)
     SELECT r.batch_id, r.id,
            jsonb_build_object('handle', r.handle, 'line', r.line, 'raw', r.raw, 'handleChanged', r.handle_changed),
            r.candidate_id, r.score, r.evidence, 'pending'
       FROM import_row r
      WHERE r.batch_id=$1 AND r.verdict='review'
        AND NOT EXISTS (SELECT 1 FROM merge_candidate mc WHERE mc.import_row_id = r.id)`,
    [batchId],
  );
  await run(
    `UPDATE import_batch b SET
       state='dry_run',
       rows_new    = (SELECT count(*) FROM import_row WHERE batch_id=b.id AND verdict='new'),
       rows_merged = (SELECT count(*) FROM import_row WHERE batch_id=b.id AND verdict='merge'),
       rows_review = (SELECT count(*) FROM import_row WHERE batch_id=b.id AND verdict='review'),
       rows_error  = (SELECT count(*) FROM import_row WHERE batch_id=b.id AND verdict='error'),
       report = b.report || jsonb_build_object('preview', (
         SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM (
           SELECT line, handle, verdict, score, evidence, candidate_handle AS "candidateHandle", raw
             FROM import_row WHERE batch_id=b.id ORDER BY line LIMIT $2) x))
     WHERE b.id=$1`,
    [batchId, PREVIEW_ROWS],
  );
}

/** 행 하나의 판정. 대조 로직은 여기 한 곳에만 둔다. */
function classifyRow(
  raw: Record<string, string>,
  source: SourceKey,
  index: ReturnType<typeof buildIndex<Candidate & { creator_id: string }>>,
  forbiddenHandleCol: boolean,
): Omit<AnalyzedRow, "line" | "raw"> {
  const n = normalizeRow(raw, source);

  if (!n.handle) {
    const warn = slugWarning(n.slug);
    return {
      handle: null, verdict: "error", score: 0,
      evidence: warn ?? "핸들 없음 — 매칭 키가 없어 저장하지 않습니다",
      candidateId: null, candidateHandle: null,
    };
  }
  if (forbiddenHandleCol) {
    return { handle: n.handle, verdict: "error", score: 0,
      evidence: SOURCES[source].forbiddenKeys![0].reason, candidateId: null, candidateHandle: null };
  }

  const incoming: Incoming = {
    handle: n.handle, sourcePk: n.platformUserId, displayName: n.displayName, followers: n.followers, source,
  };
  const best = findBest(index, incoming);
  if (!best) {
    return { handle: n.handle, verdict: "new", score: 0, evidence: "일치하는 계정 없음 — 신규 등록", candidateId: null, candidateHandle: null };
  }

  // 소스 PK 는 같은데 핸들이 다르면 핸들 변경이다. 자동 병합하지 않고 사람이 본다.
  if (best.m.handleChanged) {
    return { handle: n.handle, verdict: "review", score: 0.9,
      evidence: best.m.evidence, candidateId: best.cand.creator_id, candidateHandle: best.cand.handle, handleChanged: true };
  }

  const verdict = decide(best.m.score, best.m.deterministic);
  return {
    handle: n.handle, verdict, score: best.m.score, evidence: best.m.evidence,
    candidateId: verdict === "new" ? null : best.cand.creator_id,
    candidateHandle: verdict === "new" ? null : best.cand.handle,
  };
}

/**
 * 담기 + 대조를 끝까지. CLI·테스트·소규모 파일용 편의 함수다.
 *
 * 화면은 이걸 쓰지 않는다 — 큰 파일에서 한 요청이 시간 제한에 걸린다.
 * 대신 stageCsv 로 담고 matchBatch 를 남은 게 없을 때까지 부른다.
 */
export async function analyzeCsv(text: string, source: SourceKey, filename: string, userId: string): Promise<string | null> {
  const batchId = await stageCsv(text, source, filename, userId);
  if (!batchId) return null;
  for (let guard = 0; guard < 1000; guard++) {
    const r = await matchBatch(batchId);
    if (r.done) return batchId;
  }
  throw new Error("대조가 끝나지 않습니다");
}

export interface CommitResult {
  created: number;
  merged: number;
  skipped: number;
  /** 결정을 기다리는 검토 행. 사람이 처리하면 다시 pending 으로 돌아온다. */
  deferred: number;
  /** 아직 남은 행. 0 이면 끝났다. */
  remaining: number;
  done: boolean;
}

/**
 * 배치 커밋. 한 번에 최대 opts.limit 행만 처리하고 남은 수를 돌려준다.
 *
 * 서버리스 함수에는 실행 시간 제한이 있다. 1.9만 행을 한 요청에 다 넣으려면
 * 약 53초가 걸려서(실측 2.8ms/행) 제한에 붙는다. 그래서 행마다 상태를 두고
 * 여러 요청에 나눠 처리한다 — 중간에 끊겨도 처리한 행은 남는다.
 *
 * 검토 미결정 행은 deferred 로 빼둔다. pending 에 남겨두면 남은 수가 줄지 않아
 * 호출자가 무한히 돈다. 사람이 결정하면 reopenDecided() 가 pending 으로 되돌린다.
 * 오류 행은 저장하지 않는다.
 */
export async function commitBatch(
  batchId: string,
  userId: string,
  opts: { limit?: number } = {},
): Promise<CommitResult> {
  const limit = opts.limit ?? COMMIT_CHUNK;
  const batch = await one<{ id: string; source: SourceKey; state: string }>(
    `SELECT id, source, state FROM import_batch WHERE id=$1`, [batchId],
  );
  if (!batch) throw new Error("배치를 찾을 수 없습니다");
  if (batch.state === "discarded") throw new Error("폐기된 배치입니다");

  const pending = await all<{
    id: string; line: number; handle: string | null; verdict: string;
    candidate_id: string | null; raw: Record<string, string>;
    decision: string | null; decided_candidate: string | null;
  }>(
    `SELECT r.id, r.line, r.handle, r.verdict, r.candidate_id, r.raw,
            mc.decision, mc.candidate_id AS decided_candidate
       FROM import_row r
       LEFT JOIN merge_candidate mc ON mc.import_row_id = r.id
      WHERE r.batch_id=$1 AND r.state='pending'
      ORDER BY r.line
      LIMIT $2`,
    [batchId, limit],
  );

  let created = 0, merged = 0, skipped = 0, deferred = 0;

  for (const r of pending) {
    if (r.verdict === "error" || !r.handle) {
      await run(`UPDATE import_row SET state='skipped', applied_at=now() WHERE id=$1`, [r.id]);
      skipped++;
      continue;
    }

    let target = r.candidate_id;
    if (r.verdict === "review") {
      if (!r.decision || r.decision === "pending") {
        await run(`UPDATE import_row SET state='deferred' WHERE id=$1`, [r.id]);
        deferred++;
        continue;
      }
      target = r.decision === "split" ? null : r.decided_candidate;
    }

    const n = normalizeRow(r.raw, batch.source);
    try {
      const { outcome, creatorId } = await applyRow(n, target, userId, batch.source);
      if (outcome === "created") created++;
      else merged++;
      await run(
        `UPDATE import_row SET state='applied', applied_at=now(), error=NULL, applied_creator_id=$2 WHERE id=$1`,
        [r.id, creatorId],
      );
    } catch (e) {
      // 한 행이 터져도 배치를 멈추지 않는다. 사유를 남기고 넘어간다.
      await run(`UPDATE import_row SET state='skipped', applied_at=now(), error=$2 WHERE id=$1`,
        [r.id, (e as Error).message.slice(0, 500)]);
      skipped++;
    }
  }

  const remaining = (await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM import_row WHERE batch_id=$1 AND state='pending'`, [batchId],
  ))!.n;
  const done = remaining === 0;

  // 누적값을 다시 세어 기록한다. 여러 번 호출되므로 더하면 어긋난다.
  await run(
    `UPDATE import_batch SET
       state = CASE WHEN $2 THEN 'committed' ELSE 'committing' END,
       rows_new    = (SELECT count(*) FROM import_row WHERE batch_id=$1 AND state='applied' AND verdict='new'),
       rows_merged = (SELECT count(*) FROM import_row WHERE batch_id=$1 AND state='applied' AND verdict<>'new'),
       rows_review = (SELECT count(*) FROM import_row WHERE batch_id=$1 AND verdict='review'),
       rows_error  = (SELECT count(*) FROM import_row WHERE batch_id=$1 AND state='skipped')
     WHERE id=$1`,
    [batchId, done],
  );

  return { created, merged, skipped, deferred, remaining, done };
}

/** 사람이 결정한 검토 행을 다시 커밋 대기로 돌린다. */
export async function reopenDecided(batchId: string): Promise<number> {
  const r = await one<{ n: number }>(
    `WITH moved AS (
       UPDATE import_row r SET state='pending'
        WHERE r.batch_id=$1 AND r.state='deferred'
          AND EXISTS (SELECT 1 FROM merge_candidate mc
                       WHERE mc.import_row_id=r.id AND mc.decision IS NOT NULL AND mc.decision <> 'pending')
       RETURNING 1)
     SELECT count(*)::int AS n FROM moved`,
    [batchId],
  );
  return r?.n ?? 0;
}

/** 배치 진행 상황. 화면이 폴링한다. */
export async function batchProgress(batchId: string) {
  return await one<{
    total: number; pending: number; applied: number; skipped: number; deferred: number; state: string;
  }>(
    `SELECT b.state,
            count(r.*)::int                                        AS total,
            count(r.*) FILTER (WHERE r.state='pending')::int       AS pending,
            count(r.*) FILTER (WHERE r.state='applied')::int       AS applied,
            count(r.*) FILTER (WHERE r.state='skipped')::int       AS skipped,
            count(r.*) FILTER (WHERE r.state='deferred')::int      AS deferred
       FROM import_batch b LEFT JOIN import_row r ON r.batch_id=b.id
      WHERE b.id=$1 GROUP BY b.state`,
    [batchId],
  );
}

type Normalized = ReturnType<typeof normalizeRow>;

/** 행 하나를 본 테이블에 반영한다. 트랜잭션 하나. */
async function applyRow(
  n: Normalized,
  target: string | null,
  userId: string,
  source: SourceKey,
): Promise<{ outcome: "created" | "merged"; creatorId: string }> {
  return await tx(async (c) => {
    let creatorId = target;
    let accountId: string | null = null;
    let outcome: "created" | "merged" = "merged";

    if (!creatorId) {
      const cr = (await c.query(
        `INSERT INTO creator (display_name, tier, home_region, is_curated, owner_user_id)
         VALUES ($1,'micro',$2,$3,$4) RETURNING id`,
        [n.displayName ?? n.handle, n.region, n.curated, userId])).rows[0];
      creatorId = cr.id as string;
      const acc = (await c.query(
        `INSERT INTO social_account (creator_id, platform, platform_user_id, handle, handle_raw, profile_url)
         VALUES ($1,'instagram',$2,$3,$4,$5)
         ON CONFLICT (platform, handle) DO UPDATE SET handle_raw=EXCLUDED.handle_raw
         RETURNING id`,
        [creatorId, n.platformUserId, n.handle, `@${n.handle}`, n.sourceUrl ?? `https://www.instagram.com/${n.handle}`])).rows[0];
      accountId = acc.id as string;
      outcome = "created";
    } else {
      const acc = (await c.query(`SELECT id, handle FROM social_account WHERE creator_id=$1 LIMIT 1`, [creatorId])).rows[0];
      accountId = acc?.id ?? null;
      // 핸들이 바뀌었으면 alias 이력에 남기고 현재 핸들을 갱신한다.
      if (acc && acc.handle !== n.handle) {
        await c.query(
          `INSERT INTO handle_alias (social_account_id, handle) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [acc.id, acc.handle]);
        await c.query(`UPDATE social_account SET handle=$2, profile_url=$3 WHERE id=$1`,
          [acc.id, n.handle, `https://www.instagram.com/${n.handle}`]);
      }
      if (n.curated) await c.query(`UPDATE creator SET is_curated=true WHERE id=$1`, [creatorId]);
    }

    if (accountId) {
      // 덮어쓰지 않고 스냅샷을 쌓는다.
      await c.query(
        `INSERT INTO account_snapshot (social_account_id, source, followers, followers_precision, following,
           posts_count, last_active_at, deals_30d, deals_90d, avg_interval_days, days_since_last, category_share)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [accountId, source, n.followers, n.followersPrecision, n.following, n.posts,
         n.lastActive, n.deals30, n.deals90, n.avgInterval, n.daysSinceLast, JSON.stringify(n.categoryShare)]);
      if (n.platformUserId) {
        await c.query(
          `INSERT INTO source_ref (entity, entity_id, source, source_pk, source_url)
           VALUES ('creator',$1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [creatorId, source, n.platformUserId, n.sourceUrl]);
      }
    }

    // 브랜드 · 딜
    let brandId: string | null = null;
    if (n.brand) {
      const bn = normName(n.brand);
      const existing = (await c.query(`SELECT id FROM brand WHERE name_norm=$1`, [bn])).rows[0];
      if (existing) {
        brandId = existing.id;
        await c.query(`UPDATE brand SET last_seen=now() WHERE id=$1`, [brandId]);
      } else {
        const nb = (await c.query(
          `INSERT INTO brand (name, name_norm, category, is_verified) VALUES ($1,$2,$3,false) RETURNING id`,
          [n.brand, bn, n.category])).rows[0];
        brandId = nb.id;
      }
    }
    if (n.product && creatorId) {
      await c.query(
        `INSERT INTO deal (creator_id, social_account_id, brand_id, title, title_norm, category_l1,
           open_date, close_date, is_always_on, price_krw, permalink, is_curated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING`,
        [creatorId, accountId, brandId, n.product, normName(n.product), n.category,
         n.openDate, n.closeDate, !n.openDate && !n.closeDate, n.price,
         `https://www.instagram.com/${n.handle}`, n.curated]);
    }

    return { outcome, creatorId: creatorId! };
  });
}
