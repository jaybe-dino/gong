import { all, one, run, tx } from "./db";
import { parseCsv, toObjects } from "./csv";
import {
  normName, parseCategoryShare, parseCount, parseDate, parseFirstInt,
  parseFollowers, parsePeriod, parsePrice, parseRelativeTime,
} from "./parse";
import { normalizeHandle, slugWarning } from "./handle";
import { decide, scoreMatch, type Candidate, type Incoming } from "./dedupe";

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
      { column: "account_id", target: "social_account.platform_user_id", note: "핸들 변경 추적의 1순위 키", rule: "keep" },
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

export interface AnalyzedRow {
  line: number;
  raw: Record<string, string>;
  handle: string | null;
  verdict: "new" | "merge" | "review" | "error";
  score: number;
  evidence: string;
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

/** dry-run 분석. 본 테이블은 건드리지 않고 import_batch + merge_candidate 만 만든다. */
export async function analyzeCsv(text: string, source: SourceKey, filename: string, userId: string): Promise<string | null> {
  const { headers, records } = toObjects(parseCsv(text));
  if (!records.length) return null;

  const handleCol = inferHandleColumn(headers, source);
  const existing = await all<Candidate & { creator_id: string }>(
    `SELECT c.id, c.display_name, sa.handle, sa.platform_user_id, c.id AS creator_id,
            (SELECT followers FROM account_snapshot s WHERE s.social_account_id=sa.id ORDER BY s.captured_at DESC LIMIT 1) AS followers
       FROM creator c JOIN social_account sa ON sa.creator_id=c.id WHERE c.merged_into IS NULL`,
  );

  const rows: AnalyzedRow[] = records.map((raw, i) => {
    const line = i + 2;
    const n = normalizeRow(raw, source);

    if (!n.handle) {
      const warn = slugWarning(n.slug);
      return {
        line, raw, handle: null, verdict: "error", score: 0,
        evidence: warn ?? "핸들 없음 — 매칭 키가 없어 저장하지 않습니다",
        candidateId: null, candidateHandle: null,
      };
    }
    if (handleCol && SOURCES[source].forbiddenKeys?.some((f) => f.column === handleCol)) {
      return { line, raw, handle: n.handle, verdict: "error", score: 0,
        evidence: SOURCES[source].forbiddenKeys![0].reason, candidateId: null, candidateHandle: null };
    }

    const incoming: Incoming = {
      handle: n.handle, platformUserId: n.platformUserId, displayName: n.displayName, followers: n.followers, source,
    };
    let best: { cand: Candidate & { creator_id: string }; m: ReturnType<typeof scoreMatch> } | null = null;
    for (const cand of existing) {
      const m = scoreMatch(incoming, cand);
      if (!best || m.score > best.m.score) best = { cand, m };
      if (m.deterministic) break;
    }
    if (!best || best.m.score === 0) {
      return { line, raw, handle: n.handle, verdict: "new", score: 0, evidence: "일치하는 계정 없음 — 신규 등록", candidateId: null, candidateHandle: null };
    }

    // 소스 PK 는 같은데 핸들이 다르면 핸들 변경이다. 자동 병합하지 않고 사람이 본다.
    if (best.m.handleChanged) {
      return { line, raw, handle: n.handle, verdict: "review", score: 0.9,
        evidence: best.m.evidence, candidateId: best.cand.creator_id, candidateHandle: best.cand.handle, handleChanged: true };
    }

    const verdict = decide(best.m.score, best.m.deterministic);
    return {
      line, raw, handle: n.handle,
      verdict: verdict === "new" ? "new" : verdict,
      score: best.m.score, evidence: best.m.evidence,
      candidateId: verdict === "new" ? null : best.cand.creator_id,
      candidateHandle: verdict === "new" ? null : best.cand.handle,
    };
  });

  const counts = {
    read: rows.length,
    neu: rows.filter((r) => r.verdict === "new").length,
    merged: rows.filter((r) => r.verdict === "merge").length,
    review: rows.filter((r) => r.verdict === "review").length,
    error: rows.filter((r) => r.verdict === "error").length,
  };

  const batch = await one<{ id: string }>(
    `INSERT INTO import_batch (source, filename, uploaded_by, rows_read, rows_new, rows_merged, rows_review, rows_error, state, report)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'dry_run',$9) RETURNING id`,
    [source, filename, userId, counts.read, counts.neu, counts.merged, counts.review, counts.error,
     JSON.stringify({ headers, handleColumn: handleCol, rows: rows.slice(0, 2000) })],
  );
  if (!batch) return null;

  for (const r of rows.filter((x) => x.verdict === "review")) {
    await run(
      `INSERT INTO merge_candidate (batch_id, incoming, candidate_id, score, evidence, decision)
       VALUES ($1,$2,$3,$4,$5,'pending')`,
      [batch.id, JSON.stringify({ handle: r.handle, line: r.line, raw: r.raw, handleChanged: r.handleChanged ?? false }),
       r.candidateId, r.score, r.evidence],
    );
  }
  return batch.id;
}

export interface CommitResult { created: number; merged: number; skipped: number }

/**
 * 배치 커밋.
 *
 * 검토 미처리 행은 건드리지 않고 큐에 남긴다. 오류 행은 저장하지 않는다.
 * 커밋 후 이전 스냅샷과 비교해 델타를 뽑는다.
 */
export async function commitBatch(batchId: string, userId: string): Promise<CommitResult> {
  const batch = await one<{ id: string; source: SourceKey; state: string; report: { rows: AnalyzedRow[] } }>(
    `SELECT id, source, state, report FROM import_batch WHERE id=$1`, [batchId],
  );
  if (!batch) throw new Error("배치를 찾을 수 없습니다");
  if (batch.state === "committed") throw new Error("이미 반영된 배치입니다");

  const decisions = Object.fromEntries(
    (await all<{ handle: string; decision: string | null; candidate_id: string | null }>(
      `SELECT incoming->>'handle' AS handle, decision, candidate_id FROM merge_candidate WHERE batch_id=$1`, [batchId],
    )).map((r) => [r.handle, r]),
  );

  let created = 0, merged = 0, skipped = 0;

  for (const r of batch.report.rows ?? []) {
    if (r.verdict === "error" || !r.handle) { skipped++; continue; }
    let target = r.candidateId;
    if (r.verdict === "review") {
      const d = decisions[r.handle];
      if (!d?.decision) { skipped++; continue; }
      if (d.decision === "split") target = null;
      else target = d.candidate_id;
    }

    const n = normalizeRow(r.raw, batch.source);

    await tx(async (c) => {
      let creatorId = target;
      let accountId: string | null = null;

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
        created++;
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
        merged++;
      }

      if (accountId) {
        // 덮어쓰지 않고 스냅샷을 쌓는다.
        await c.query(
          `INSERT INTO account_snapshot (social_account_id, source, followers, followers_precision, following,
             posts_count, last_active_at, deals_30d, deals_90d, avg_interval_days, days_since_last, category_share)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [accountId, batch.source, n.followers, n.followersPrecision, n.following, n.posts,
           n.lastActive, n.deals30, n.deals90, n.avgInterval, n.daysSinceLast, JSON.stringify(n.categoryShare)]);
        if (n.platformUserId) {
          await c.query(
            `INSERT INTO source_ref (entity, entity_id, source, source_pk, source_url)
             VALUES ('creator',$1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [creatorId, batch.source, n.platformUserId, n.sourceUrl]);
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
        const ins = await c.query(
          `INSERT INTO deal (creator_id, social_account_id, brand_id, title, title_norm, category_l1,
             open_date, close_date, is_always_on, price_krw, permalink, is_curated)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT DO NOTHING RETURNING id`,
          [creatorId, accountId, brandId, n.product, normName(n.product), n.category,
           n.openDate, n.closeDate, !n.openDate && !n.closeDate, n.price,
           `https://www.instagram.com/${n.handle}`, n.curated]);
        void ins;
      }
    });
  }

  // 델타 감지는 jobs/detect-changes 가 담당한다. 여기서 또 이벤트를 만들면 중복된다.
  await run(
    `UPDATE import_batch SET state='committed', rows_new=$2, rows_merged=$3 WHERE id=$1`,
    [batchId, created, merged]);

  return { created, merged, skipped };
}
