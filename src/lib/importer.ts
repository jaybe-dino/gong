import { all, db, one, run } from "./db";
import { parseCsv, parseFollowers, parseRelativeTime, toObjects } from "./csv";
import { cleanHandle, handleSimilarity, normHandle } from "./handle";

export type SourceKey = "momcal" | "pang" | "ingong";

export interface SourceProfile {
  key: SourceKey;
  name: string;
  site: string;
  blurb: string;
  /** 이 소스가 제공하는 필드 → 우리 스키마 경로 */
  fields: { column: string; target: string; note?: string; rule?: "auto" | "parse" | "keep" }[];
  /** 매칭 키로 쓰면 안 되는 컬럼과 그 이유 */
  forbiddenKeys?: { column: string; reason: string }[];
}

export const SOURCES: Record<SourceKey, SourceProfile> = {
  momcal: {
    key: "momcal",
    name: "맘캘린더",
    site: "momcalendar.com",
    blurb: "브랜드 마스터 · 셀러 · 반복 제품 · 사람이 검증한 큐레이션 플래그",
    fields: [
      { column: "handle", target: "social_account.handle", note: "상세 페이지의 실제 @핸들", rule: "auto" },
      { column: "seller_name", target: "creator.display_name", rule: "auto" },
      { column: "brand", target: "brand.name", note: "브랜드 사전의 기준 표기", rule: "auto" },
      { column: "curated", target: "creator.curated", note: "사람 검증 플래그", rule: "auto" },
      { column: "slug", target: "source_ref.source_pk", note: "역추적용으로만 보존", rule: "keep" },
      { column: "detail_url", target: "source_ref.source_url", note: "링크백", rule: "keep" },
    ],
    forbiddenKeys: [
      {
        column: "slug",
        reason: "슬러그(de-elisa-shop)는 . 과 _ 를 모두 - 로 치환한 결과라 역변환이 불가능합니다. 상세 페이지에 표기된 실제 @핸들 컬럼을 매칭 키로 지정하세요.",
      },
    ],
  },
  pang: {
    key: "pang",
    name: "공구팡팡",
    site: "09pangpang.com",
    blurb: "팔로워 · 팔로잉 · 게시물 3종 + 가격 + 오픈 시각 + 2단계 카테고리 + 해시태그",
    fields: [
      { column: "handle", target: "social_account.handle", note: "정규화 후 매칭 키", rule: "auto" },
      { column: "display_name", target: "creator.display_name", rule: "auto" },
      { column: "팔로워", target: "account_snapshot.followers", note: '"10.8만" → 108000, 정밀도 플래그 ±500', rule: "parse" },
      { column: "팔로잉", target: "account_snapshot.following", rule: "auto" },
      { column: "게시물", target: "account_snapshot.posts_count", rule: "auto" },
      { column: "마지막활동", target: "account_snapshot.last_active_at", note: '"약 1시간 전" → 절대시각 변환', rule: "parse" },
      { column: "account_id", target: "source_ref.source_pk", note: "역추적용, 매칭 키로는 쓰지 않음", rule: "keep" },
      { column: "profile_url", target: "source_ref.source_url", note: "링크백", rule: "keep" },
    ],
  },
  ingong: {
    key: "ingong",
    name: "인공",
    site: "insta-gong.com",
    blurb: "최근 30·90일 딜 수 · 평균 공구 간격 · 마지막 공구 경과일 · 카테고리 점유율 · 지역",
    fields: [
      { column: "handle", target: "social_account.handle", rule: "auto" },
      { column: "deals_30d", target: "creator_metric.deals_30d", rule: "auto" },
      { column: "deals_90d", target: "creator_metric.deals_90d", rule: "auto" },
      { column: "avg_interval", target: "creator_metric.avg_cadence_days", note: "케이던스 타이밍의 기준값", rule: "auto" },
      { column: "last_deal", target: "creator_metric.last_deal_on", rule: "parse" },
      { column: "region", target: "creator.region", rule: "auto" },
      { column: "source_pk", target: "source_ref.source_pk", note: "핸들 변경 추적에 쓰임", rule: "keep" },
    ],
  },
};

export interface AnalyzedRow {
  line: number;
  raw: Record<string, string>;
  handleNorm: string | null;
  verdict: "new" | "merge" | "review" | "error";
  score: number | null;
  reason: string;
  matchId: number | null;
  matchHandle: string | null;
}

export interface Analysis {
  source: SourceKey;
  filename: string;
  headers: string[];
  rows: AnalyzedRow[];
  counts: { rows: number; created: number; updated: number; review: number; errors: number };
}

/** 헤더 이름에서 핸들 컬럼을 추론한다. 슬러그류는 후보에서 제외한다. */
export function inferHandleColumn(headers: string[], source: SourceKey): string | null {
  const forbidden = new Set((SOURCES[source].forbiddenKeys ?? []).map((f) => f.column.toLowerCase()));
  const prefer = ["handle", "instagram", "insta", "@", "아이디", "계정"];
  const candidates = headers.filter((h) => !forbidden.has(h.toLowerCase()));
  for (const p of prefer) {
    const hit = candidates.find((h) => h.toLowerCase().includes(p));
    if (hit) return hit;
  }
  return null;
}

/**
 * 임포트 분석.
 *
 * 아직 아무것도 쓰지 않는다. 신규 / 자동 병합 / 검토 필요 / 오류로 분류만 하고,
 * 사람이 검토 큐를 처리한 뒤에야 applyImport 로 반영한다.
 *
 * 점수 기준
 *   ≥ 0.95  자동 병합
 *   0.80 ~ 0.95  검토 필요 (사람이 판단)
 *   < 0.80  신규
 */
export function analyze(csvText: string, source: SourceKey, filename: string): Analysis {
  const { headers, records } = toObjects(parseCsv(csvText));
  const handleCol = inferHandleColumn(headers, source);
  const nameCol = headers.find((h) => /name|이름|셀러/i.test(h)) ?? null;

  const existing = all<{ id: number; handle: string; handle_norm: string; display_name: string }>(
    `SELECT a.id, a.handle, a.handle_norm, c.display_name
       FROM social_account a JOIN creator c ON c.id = a.creator_id`,
  );

  const rows: AnalyzedRow[] = records.map((raw, i) => {
    const line = i + 2; // 헤더가 1행
    const rawHandle = handleCol ? raw[handleCol] : "";
    const norm = normHandle(rawHandle ?? "");

    if (!norm) {
      return {
        line,
        raw,
        handleNorm: null,
        verdict: "error",
        score: null,
        reason: "핸들 없음 — 매칭 키가 없어 저장하지 않습니다",
        matchId: null,
        matchHandle: null,
      };
    }

    // 소스 PK 가 같은데 핸들이 다르면 핸들 변경으로 본다. 유사도보다 강한 근거다.
    const pkCol = headers.find((h) => /^(account_id|source_pk|id)$/i.test(h));
    if (pkCol && raw[pkCol]) {
      const byPk = one<{ entity_id: number; handle: string; handle_norm: string }>(
        `SELECT sr.entity_id, a.handle, a.handle_norm
           FROM source_ref sr JOIN social_account a ON a.id = sr.entity_id
          WHERE sr.entity_type='account' AND sr.source = ? AND sr.source_pk = ?`,
        [source, raw[pkCol]],
      );
      if (byPk && byPk.handle_norm !== norm) {
        return {
          line,
          raw,
          handleNorm: norm,
          verdict: "review",
          score: 0.88,
          reason: `핸들 변경 추정 — 소스 PK 동일(${raw[pkCol]})`,
          matchId: byPk.entity_id,
          matchHandle: byPk.handle,
        };
      }
      if (byPk) {
        return { line, raw, handleNorm: norm, verdict: "merge", score: 1, reason: "소스 PK · 핸들 모두 일치", matchId: byPk.entity_id, matchHandle: byPk.handle };
      }
    }

    let best: { id: number; handle: string; name: string; score: number } | null = null;
    for (const e of existing) {
      const s = handleSimilarity(norm, e.handle_norm);
      if (!best || s > best.score) best = { id: e.id, handle: e.handle, name: e.display_name, score: s };
    }

    const bestScore = best === null ? 0 : best.score;
    if (best === null || bestScore < 0.8) {
      return { line, raw, handleNorm: norm, verdict: "new", score: bestScore, reason: "일치하는 계정 없음 — 신규 등록", matchId: null, matchHandle: null };
    }

    const incomingName = nameCol ? raw[nameCol] : "";
    const nameSame = incomingName && best.name && incomingName.trim() === best.name.trim();
    const followers = parseFollowers(raw["팔로워"] ?? raw["followers"] ?? "");
    const known = one<{ followers: number | null }>(
      `SELECT followers FROM account_snapshot WHERE account_id = ? ORDER BY observed_at DESC LIMIT 1`,
      [best.id],
    );
    let folDelta: number | null = null;
    if (followers.value != null && known?.followers) folDelta = Math.abs(followers.value - known.followers) / known.followers;

    const bits: string[] = [];
    if (normHandle(best.handle) === norm) bits.push("정규화 후 핸들 동일");
    else bits.push("핸들 유사");
    if (nameSame) bits.push("표시명 동일");
    else if (incomingName) bits.push("표시명 불일치");
    if (folDelta != null) bits.push(`팔로워 차 ${Math.round(folDelta * 100)}%`);

    let score = best.score;
    if (nameSame) score = Math.min(1, score + 0.05);
    if (incomingName && !nameSame) score -= 0.06;
    if (folDelta != null && folDelta > 0.35) score -= 0.08;

    if (score >= 0.95) {
      return { line, raw, handleNorm: norm, verdict: "merge", score, reason: bits.join(" + "), matchId: best.id, matchHandle: best.handle };
    }
    // 감점 후 임계 아래로 내려가면 같은 사람으로 보지 않는다. 검토 큐에 올리면
    // 사람이 판단할 근거가 없는 건을 떠넘기는 셈이 된다.
    if (score < 0.8) {
      return {
        line, raw, handleNorm: norm, verdict: "new", score,
        reason: `${bits.join(" + ")} — 임계 미만이라 별개 계정으로 봅니다`,
        matchId: null, matchHandle: null,
      };
    }
    return {
      line,
      raw,
      handleNorm: norm,
      verdict: "review",
      score,
      reason: bits.join(" + ") + (folDelta != null && folDelta > 0.35 ? " — 동명이인 가능" : ""),
      matchId: best.id,
      matchHandle: best.handle,
    };
  });

  const counts = {
    rows: rows.length,
    created: rows.filter((r) => r.verdict === "new").length,
    updated: rows.filter((r) => r.verdict === "merge").length,
    review: rows.filter((r) => r.verdict === "review").length,
    errors: rows.filter((r) => r.verdict === "error").length,
  };

  return { source, filename, headers, rows, counts };
}

/** 분석 결과를 배치로 저장한다. 아직 본 테이블은 건드리지 않는다. */
export function saveBatch(a: Analysis, now: string): number {
  const info = run(
    `INSERT INTO import_batch (source, filename, rows, created, updated, review, errors, status, created_at, mapping)
     VALUES (?,?,?,?,?,?,?, 'analyzed', ?, ?)`,
    [a.source, a.filename, a.counts.rows, a.counts.created, a.counts.updated, a.counts.review, a.counts.errors, now, JSON.stringify(SOURCES[a.source].fields)],
  );
  const batchId = Number(info.lastInsertRowid);
  const stmt = db().prepare(
    `INSERT INTO import_row (batch_id, line_no, raw, handle_norm, verdict, score, reason, match_id)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const tx = db().transaction((rows: AnalyzedRow[]) => {
    for (const r of rows) {
      stmt.run(batchId, r.line, JSON.stringify(r.raw), r.handleNorm, r.verdict, r.score, r.reason, r.matchId);
    }
  });
  tx(a.rows);
  return batchId;
}

/**
 * 배치 반영.
 *
 * 검토 필요(review) 행은 사람이 결정하기 전까지 건드리지 않고 큐에 남긴다.
 * 오류 행은 저장하지 않는다.
 */
export function applyBatch(batchId: number, now: string): { created: number; updated: number; skipped: number } {
  const batch = one<{ source: SourceKey; status: string }>(`SELECT source, status FROM import_batch WHERE id = ?`, [batchId]);
  if (!batch) throw new Error(`import batch ${batchId} 없음`);
  if (batch.status === "applied") throw new Error("이미 반영된 배치입니다");

  const rows = all<{ id: number; raw: string; handle_norm: string | null; verdict: string; match_id: number | null; decision: string | null }>(
    `SELECT id, raw, handle_norm, verdict, match_id, decision FROM import_row WHERE batch_id = ?`,
    [batchId],
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;

  const tx = db().transaction(() => {
    for (const r of rows) {
      const raw = JSON.parse(r.raw) as Record<string, string>;
      const effective = r.decision === "merge" ? "merge" : r.decision === "split" ? "new" : r.verdict;

      if (effective === "error" || effective === "review" || !r.handle_norm) {
        skipped++;
        continue;
      }
      if (effective === "merge" && r.match_id) {
        writeSnapshot(r.match_id, raw, batch.source, now);
        updated++;
      } else {
        const accountId = createCreatorFromRow(raw, batch.source, now);
        writeSnapshot(accountId, raw, batch.source, now);
        created++;
      }
    }
    run(`UPDATE import_batch SET status='applied', applied_at=?, created=?, updated=? WHERE id=?`, [now, created, updated, batchId]);
  });
  tx();

  return { created, updated, skipped };
}

function pick(raw: Record<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const found = Object.keys(raw).find((h) => h.toLowerCase() === k.toLowerCase());
    if (found && raw[found]) return raw[found];
  }
  return null;
}

function createCreatorFromRow(raw: Record<string, string>, source: SourceKey, now: string): number {
  const handleRaw = pick(raw, ["handle", "instagram", "insta", "계정", "아이디"]) ?? "";
  const handle = cleanHandle(handleRaw);
  const norm = normHandle(handleRaw);
  const name = pick(raw, ["display_name", "seller_name", "name", "이름", "셀러명"]) ?? handle;
  const region = pick(raw, ["region", "지역"]);
  const curated = pick(raw, ["curated", "검증"]) ? 1 : 0;

  const info = run(`INSERT INTO creator (display_name, tier, region, curated, created_at) VALUES (?,?,?,?,?)`, [
    name,
    "micro",
    region,
    curated,
    now,
  ]);
  const creatorId = Number(info.lastInsertRowid);
  const acc = run(`INSERT INTO social_account (creator_id, platform, handle, handle_norm, is_primary) VALUES (?, 'instagram', ?, ?, 1)`, [
    creatorId,
    handle,
    norm,
  ]);
  const accountId = Number(acc.lastInsertRowid);

  const pk = pick(raw, ["account_id", "source_pk", "id"]);
  const url = pick(raw, ["profile_url", "detail_url", "url"]);
  run(`INSERT OR IGNORE INTO source_ref (entity_type, entity_id, source, source_pk, source_url, observed_at) VALUES ('creator',?,?,?,?,?)`, [
    creatorId,
    source,
    pk,
    url,
    now,
  ]);
  run(`INSERT OR IGNORE INTO source_ref (entity_type, entity_id, source, source_pk, source_url, observed_at) VALUES ('account',?,?,?,?,?)`, [
    accountId,
    source,
    pk,
    url,
    now,
  ]);
  return accountId;
}

/** 덮어쓰지 않고 스냅샷을 하나 더 쌓는다. */
function writeSnapshot(accountId: number, raw: Record<string, string>, source: SourceKey, now: string) {
  const fol = parseFollowers(pick(raw, ["팔로워", "followers"]) ?? "");
  const following = parseFollowers(pick(raw, ["팔로잉", "following"]) ?? "");
  const posts = parseFollowers(pick(raw, ["게시물", "posts", "posts_count"]) ?? "");
  const lastActive = parseRelativeTime(pick(raw, ["마지막활동", "last_active"]) ?? "");

  if (fol.value == null && following.value == null && posts.value == null && !lastActive) return;

  run(
    `INSERT INTO account_snapshot (account_id, observed_at, followers, following, posts_count, last_active_at, precision, source)
     VALUES (?,?,?,?,?,?,?,?)`,
    [accountId, now, fol.value, following.value, posts.value, lastActive, fol.precision, source],
  );

  const creator = one<{ creator_id: number }>(`SELECT creator_id FROM social_account WHERE id = ?`, [accountId]);
  if (!creator) return;

  const d30 = pick(raw, ["deals_30d"]);
  const d90 = pick(raw, ["deals_90d"]);
  const cad = pick(raw, ["avg_interval", "avg_cadence_days"]);
  const last = pick(raw, ["last_deal", "last_deal_on"]);
  if (d30 || d90 || cad || last) {
    run(
      `INSERT INTO creator_metric (creator_id, deals_30d, deals_90d, avg_cadence_days, last_deal_on, source, computed_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(creator_id) DO UPDATE SET
         deals_30d=excluded.deals_30d, deals_90d=excluded.deals_90d,
         avg_cadence_days=excluded.avg_cadence_days, last_deal_on=excluded.last_deal_on,
         source=excluded.source, computed_at=excluded.computed_at`,
      [creator.creator_id, d30 ? Number(d30) : null, d90 ? Number(d90) : null, cad ? Number(cad) : null, last, source, now],
    );
  }
}
