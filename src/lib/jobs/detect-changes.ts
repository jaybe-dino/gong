import { all, one, run } from "../db";
import { normName } from "../parse";
import { timing } from "../score";
import * as notify from "./notify";

/**
 * 변화 감지 — "자동 수집"이 아니라 "업로드된 스냅샷 사이의 차이 감지".
 *
 * 델타를 뽑는 데서 끝내지 않고 그대로 아웃리치 동작으로 연결한다.
 * 경쟁 브랜드 공구가 열리면 진행 중 캠페인 타깃에서 자동으로 뺀다 — 사람이 눈치채기 전에.
 */

export interface ChangeEvent {
  kind: string;
  title: string;
  detail?: string | null;
  handle?: string | null;
  severity?: "info" | "warn" | "alert";
  entity?: string | null;
  entityId?: string | null;
  payload?: Record<string, unknown>;
}

async function push(events: ChangeEvent[], batchId: string | null, e: ChangeEvent) {
  await run(
    `INSERT INTO change_event (batch_id, kind, entity, entity_id, handle, title, detail, payload, severity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [batchId, e.kind, e.entity ?? null, e.entityId ?? null, e.handle ?? null,
     e.title, e.detail ?? null, JSON.stringify(e.payload ?? {}), e.severity ?? "info"],
  );
  events.push(e);
}

export interface DetectResult {
  events: ChangeEvent[];
  autoExcluded: number;
}

/**
 * @param since 이 시각 이후에 처음 본 것만 델타로 본다. 보통 임포트 배치의 observed_at.
 */
export async function detectChanges(
  { batchId = null, since }: { batchId?: string | null; since: Date | string },
): Promise<DetectResult> {
  const events: ChangeEvent[] = [];
  let autoExcluded = 0;

  const watch = await all<{ kind: string; target: string; condition: string; threshold: number | null }>(
    `SELECT kind, target, condition, threshold FROM watchlist WHERE is_active`,
  );
  const watchBrand = new Set(watch.filter((w) => w.kind === "brand").map((w) => normName(w.target)));
  const watchSeller = new Set(watch.filter((w) => w.kind === "seller").map((w) => w.target.replace(/^@/, "")));
  const watchKeyword = watch.filter((w) => w.kind === "keyword").map((w) => w.target);
  const surgeRules = watch.filter((w) => w.kind === "category" && w.condition === "surge");

  // 1. 워치리스트에 걸린 신규 공구
  for (const d of await all<{ id: string; title: string; open_date: string | null; category_l1: string | null; price_krw: number | null; brand_name: string | null; brand_norm: string | null; handle: string | null }>(
    `SELECT d.id, d.title, to_char(d.open_date,'YYYY-MM-DD') AS open_date, d.category_l1, d.price_krw,
            b.name AS brand_name, b.name_norm AS brand_norm, sa.handle
       FROM deal d
       LEFT JOIN brand b ON b.id = d.brand_id
       LEFT JOIN social_account sa ON sa.id = d.social_account_id
      WHERE d.first_seen >= $1`, [since])) {
    const hitBrand = d.brand_norm && watchBrand.has(d.brand_norm);
    const hitSeller = d.handle && watchSeller.has(d.handle);
    const hitKeyword = watchKeyword.find((k) => d.title?.includes(k));
    if (!hitBrand && !hitSeller && !hitKeyword) continue;
    await push(events, batchId, {
      kind: "new_deal", entity: "deal", entityId: d.id, handle: d.handle, title: d.title,
      detail: `@${d.handle} · ${d.open_date ?? "상시"} 오픈 · 워치 ${
        hitBrand ? `브랜드 '${d.brand_name}'` : hitSeller ? "셀러" : `키워드 '${hitKeyword}'`} 일치`,
      payload: { brand: d.brand_name, category: d.category_l1, price: d.price_krw },
    });
  }

  // 2. 브랜드 충돌 → 진행 중 캠페인 타깃에서 자동 제외
  //    회신 이후 단계(협의·확정)까지 간 건은 건드리지 않는다. 사람이 판단할 영역이다.
  for (const x of await all<{ member_id: string; campaign_name: string; brand_name: string | null; title: string; open_date: string | null; handle: string; campaign_id: string; deal_id: string }>(
    `SELECT cm.id AS member_id, cp.name AS campaign_name, b.name AS brand_name, d.title,
            to_char(d.open_date,'YYYY-MM-DD') AS open_date, sa.handle, cp.id AS campaign_id, d.id AS deal_id
       FROM deal d
       JOIN creator c ON c.id = d.creator_id
       JOIN social_account sa ON sa.creator_id = c.id
       JOIN campaign_member cm ON cm.creator_id = c.id
       JOIN campaign cp ON cp.id = cm.campaign_id AND cp.status='running'
       LEFT JOIN brand b ON b.id = d.brand_id
      WHERE d.first_seen >= $1
        AND d.category_l1 = cp.category
        AND (b.name IS NULL OR b.name <> cp.brand_name)
        AND cm.engine_state > 0
        AND cm.stage_id <= (SELECT id FROM pipeline_stage WHERE key='replied')`, [since])) {
    await run(
      `UPDATE campaign_member SET engine_state=-6, dropped_at=now(), drop_reason=$2, next_action_at=NULL WHERE id=$1`,
      [x.member_id, `브랜드 충돌 · ${x.brand_name ?? x.title}`],
    );
    await run(
      `INSERT INTO audit_log (actor_kind, entity, entity_id, action, reason)
       VALUES ('system','campaign_member',$1,'auto_exclude',$2)`,
      [x.member_id, `브랜드 충돌 (${x.brand_name ?? x.title})`],
    );
    autoExcluded++;
    await push(events, batchId, {
      kind: "brand_conflict", entity: "campaign_member", entityId: x.member_id, handle: x.handle,
      title: `@${x.handle} 이 ${x.brand_name ?? "경쟁 브랜드"} 진행중`,
      detail: `'${x.campaign_name}' 타깃에서 자동 제외됨 · ${x.open_date ?? "상시"}`,
      payload: { campaignId: x.campaign_id, dealId: x.deal_id }, severity: "alert",
    });
  }

  // 3. 브랜드 사전에 없던 이름
  for (const b of await all<{ id: string; name: string; deal_count: string }>(
    `SELECT b.id, b.name, count(d.id) AS deal_count
       FROM brand b LEFT JOIN deal d ON d.brand_id=b.id
      WHERE NOT b.is_verified AND b.first_seen >= $1
      GROUP BY b.id, b.name`, [since])) {
    await push(events, batchId, {
      kind: "new_brand", entity: "brand", entityId: b.id, title: b.name,
      detail: `${b.deal_count}개 딜에서 등장 · 브랜드 사전에 없음 · 별칭 등록 필요`, severity: "warn",
    });
  }

  // 4. 사라진 딜 — 원문 404/410 이면 마감 처리하고 tombstone 을 남긴다
  for (const g of await all<{ id: string; title: string; handle: string | null; source: string; http_status: number }>(
    `SELECT d.id, d.title, sa.handle, ds.source, ds.http_status
       FROM deal d JOIN deal_source ds ON ds.deal_id=d.id
       LEFT JOIN social_account sa ON sa.id = d.social_account_id
      WHERE ds.http_status IN (404,410) AND d.status='active'`)) {
    await run(`UPDATE deal SET status='gone' WHERE id=$1`, [g.id]);
    await push(events, batchId, {
      kind: "deal_gone", entity: "deal", entityId: g.id, handle: g.handle, title: g.title,
      detail: `${g.source} 원문 ${g.http_status} · 마감 처리 + tombstone 기록`,
    });
  }

  // 5. 핸들 변경
  for (const r of await all<{ id: string; handle: string; platform_user_id: string | null; old_handle: string }>(
    `SELECT sa.id, sa.handle, sa.platform_user_id, ha.handle AS old_handle
       FROM handle_alias ha JOIN social_account sa ON sa.id = ha.social_account_id
      WHERE ha.seen_from >= $1`, [since])) {
    await push(events, batchId, {
      kind: "handle_change", entity: "social_account", entityId: r.id, handle: r.handle,
      title: `@${r.handle} ← @${r.old_handle}`,
      detail: `소스 PK ${r.platform_user_id ?? "동일"} · alias 이력에 추가됨`, severity: "warn",
    });
  }

  // 6. 적기 도달 — 워치 중인 셀러만
  for (const c of await all<{ creator_id: string; handle: string; avg_interval_days: string | null; days_since_last: number | null }>(
    `SELECT creator_id, handle, avg_interval_days, days_since_last FROM v_creator_latest
      WHERE avg_interval_days IS NOT NULL AND days_since_last IS NOT NULL`)) {
    if (!watchSeller.has(c.handle)) continue;
    const t = timing({ avgIntervalDays: Number(c.avg_interval_days), daysSinceLast: c.days_since_last });
    if (!t.ready) continue;
    await push(events, batchId, {
      kind: "timing_ready", entity: "creator", entityId: c.creator_id, handle: c.handle,
      title: `@${c.handle}`, detail: `${t.label} · 다음 공구 준비 시점`, payload: { ratio: t.ratio },
    });
  }

  // 7. 카테고리 급증
  for (const rule of surgeRules) {
    const r = await one<{ today: number; prev: number }>(
      `SELECT count(*)::int AS today,
              (SELECT count(*)::int FROM deal
                WHERE category_l1=$1 AND open_date BETWEEN CURRENT_DATE - 28 AND CURRENT_DATE - 1) AS prev
         FROM deal WHERE category_l1=$1 AND open_date = CURRENT_DATE`, [rule.target]);
    if (!r) continue;
    const avg = r.prev / 28;
    if (r.today >= (rule.threshold ?? 5) && avg > 0 && r.today > avg * 2) {
      await push(events, batchId, {
        kind: "category_surge", entity: "category", title: rule.target,
        detail: `일 ${r.today}건 · 지난 4주 평균 ${avg.toFixed(1)}건 대비 급증`,
        payload: { today: r.today, avg },
      });
    }
  }

  // 8. 계정 비활성 — 60일 무활동
  for (const d of await all<{ creator_id: string; handle: string; days_since_last: number }>(
    `SELECT creator_id, handle, days_since_last FROM v_creator_latest
      WHERE days_since_last >= 60 AND is_active`)) {
    await run(`UPDATE social_account SET is_active=false, deactivated_at=now() WHERE creator_id=$1 AND is_active`, [d.creator_id]);
    await push(events, batchId, {
      kind: "account_dead", entity: "creator", entityId: d.creator_id, handle: d.handle,
      title: `@${d.handle}`, detail: `${d.days_since_last}일간 신규 공구 없음 · 재검증 대상`, severity: "warn",
    });
  }

  if (events.length) await notify.changeDigest(events);
  return { events, autoExcluded };
}
