import dns from "node:dns/promises";
import { all, one, run } from "../db";
import { hasTable } from "../schema";
import { REACHABLE_CHANNELS, sqlList } from "../channels/kinds";

/**
 * 유효성 점검 에이전트.
 *
 * 무엇을 할 수 있고 무엇을 할 수 없는지부터.
 *
 * 입력이 CSV 업로드뿐이므로 인스타그램을 직접 들여다보는 판정은 할 수 없다 —
 * 계정 정지·게시물 삭제·팔로워 실시간 변화는 다음 업로드 전까지 알 수 없다.
 * 그걸 아는 척하면 안 된다. 대신 "우리 데이터가 얼마나 낡았는가" 를 상태로
 * 드러낸다. 조용히 낡는 것이 틀린 판단의 주된 원인이다.
 *
 * 데이터만으로 판정하는 것:
 *   suppressed  수신거부·DNC 등재 — 연락 금지
 *   dead        계정 비활성 표시
 *   bounced     바운스 누적
 *   bad_email   이메일 도메인이 메일을 받지 않음 (다른 채널은 살아 있을 수 있다)
 *   unreachable 연락 수단 없음 (DM 만 남음)
 *   stale       최신 스냅샷이 오래됨
 *   dormant     케이던스 이탈 (경과일 > 평균 간격 × 2.2)
 *
 * 밖에 물어보는 것:
 *   이메일 도메인 MX 조회. 없는 도메인은 확실히 걸러진다.
 *   있다고 해서 그 주소가 존재한다는 뜻은 아니다 — exampl.com 같은 실재하는
 *   오타 도메인도 MX 를 갖는다. 그 이상은 실제 발송의 바운스로만 알 수 있다.
 */

/** 스냅샷이 이보다 오래되면 낡은 것으로 본다. */
export const STALE_DAYS = 45;

/** 케이던스 이탈 배수. score.ts 의 타이밍 판정과 같은 기준을 쓴다. */
export const DORMANT_RATIO = 2.2;

export const HEALTH_CHUNK = 5000;

export interface HealthProgress {
  checked: number;
  remaining: number;
  done: boolean;
  changed: number;
}

/**
 * 상태를 한 번에 계산해 담는다.
 *
 * 우선순위는 "연락이 가능한가" 가 먼저다. 수신거부된 사람이 휴면인지는 의미가 없다.
 * reasons 에는 해당하는 사유를 전부 남기고, state 에는 가장 높은 것만 둔다.
 */
const STATE_SQL = `
  WITH base AS (
    SELECT c.id AS creator_id, sa.handle, sa.is_active,
           v.captured_at, v.days_since_last, v.avg_interval_days,
           (SELECT count(*) FROM contact_point cp
             WHERE cp.creator_id = c.id AND cp.channel IN (${sqlList(REACHABLE_CHANNELS)})
               AND cp.consent_status <> 'opt_out') AS reachable_n,
           (SELECT coalesce(max(cp.bounce_count), 0) FROM contact_point cp WHERE cp.creator_id = c.id) AS bounces,
           EXISTS (
             SELECT 1 FROM suppression s
              WHERE (s.identifier_type='creator_id' AND s.identifier_val = c.id::text)
                 OR (s.identifier_type='ig_handle'  AND s.identifier_val = sa.handle)
                 OR (s.identifier_type='email'      AND s.identifier_val IN
                       (SELECT value_norm FROM contact_point WHERE creator_id = c.id))
           ) AS suppressed,
           EXISTS (
             SELECT 1 FROM contact_point cp
              WHERE cp.creator_id = c.id AND cp.channel='email' AND cp.verification='invalid'
           ) AS bad_email
      FROM creator c
      JOIN social_account sa ON sa.creator_id = c.id
      LEFT JOIN LATERAL (
        SELECT * FROM account_snapshot s WHERE s.social_account_id = sa.id
         ORDER BY s.captured_at DESC LIMIT 1
      ) v ON true
     WHERE c.merged_into IS NULL AND c.id = ANY($1::uuid[])
  ), judged AS (
    SELECT creator_id,
           suppressed,
           NOT coalesce(is_active, true)                                   AS dead,
           bounces >= 2                                                    AS bounced,
           reachable_n = 0                                                 AS unreachable,
           bad_email,
           (captured_at IS NULL OR captured_at < now() - ($2 || ' days')::interval) AS stale,
           (avg_interval_days IS NOT NULL AND avg_interval_days > 0
             AND days_since_last IS NOT NULL
             AND days_since_last > avg_interval_days * $3)                 AS dormant
      FROM base
  )
  SELECT creator_id,
         CASE WHEN suppressed   THEN 'suppressed'
              WHEN dead         THEN 'dead'
              WHEN bounced      THEN 'bounced'
              WHEN unreachable  THEN 'unreachable'
              WHEN stale        THEN 'stale'
              WHEN dormant      THEN 'dormant'
              ELSE 'ok' END AS state,
         CASE WHEN suppressed OR dead OR bounced THEN 'alert'
              WHEN unreachable OR stale OR dormant OR bad_email THEN 'warn'
              ELSE 'info' END AS severity,
         (SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM (
            SELECT '수신거부·DNC 등재' AS r WHERE suppressed
            UNION ALL SELECT '계정 비활성' WHERE dead
            UNION ALL SELECT '바운스 누적' WHERE bounced
            UNION ALL SELECT '연락 수단 없음 — DM 만 남음' WHERE unreachable
            UNION ALL SELECT '이메일 도메인이 메일을 받지 않음' WHERE bad_email
            UNION ALL SELECT '데이터가 오래됨 — 새 CSV 업로드 필요' WHERE stale
            UNION ALL SELECT '케이던스 이탈 — 휴면 추정' WHERE dormant
          ) x) AS reasons
    FROM judged`;

/** 아직 점검 안 됐거나 오래된 크리에이터를 limit 만큼 점검한다. */
export async function checkHealth(
  opts: { limit?: number; recheckBefore?: Date } = {},
): Promise<HealthProgress> {
  const limit = opts.limit ?? HEALTH_CHUNK;
  const before = opts.recheckBefore ?? null;

  const todo = await all<{ id: string }>(
    `SELECT c.id FROM creator c
       LEFT JOIN creator_health h ON h.creator_id = c.id
      WHERE c.merged_into IS NULL
        AND (h.creator_id IS NULL OR ($1::timestamptz IS NOT NULL AND h.checked_at < $1))
      ORDER BY c.id LIMIT $2`,
    [before, limit],
  );

  let changed = 0;
  if (todo.length) {
    const rows = await all<{ creator_id: string; state: string; severity: string; reasons: string[] }>(
      STATE_SQL, [todo.map((t) => t.id), String(STALE_DAYS), DORMANT_RATIO],
    );
    changed = await upsertHealth(rows);
  }

  const remaining = (await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM creator c
       LEFT JOIN creator_health h ON h.creator_id = c.id
      WHERE c.merged_into IS NULL
        AND (h.creator_id IS NULL OR ($1::timestamptz IS NOT NULL AND h.checked_at < $1))`,
    [before],
  ))!.n;

  return { checked: todo.length, remaining, done: remaining === 0, changed };
}

/** 상태가 바뀐 건수를 돌려준다. 바뀌지 않았으면 checked_at 만 올린다. */
async function upsertHealth(
  rows: { creator_id: string; state: string; severity: string; reasons: string[] }[],
): Promise<number> {
  if (!rows.length) return 0;
  const per = 4;
  const chunk = Math.max(1, Math.floor(60000 / per));
  let changed = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const values: string[] = [];
    const params: unknown[] = [];
    slice.forEach((r, ri) => {
      const b = ri * per;
      values.push(`($${b + 1}::uuid,$${b + 2}::text,$${b + 3}::text,$${b + 4}::jsonb)`);
      params.push(r.creator_id, r.state, r.severity, JSON.stringify(r.reasons));
    });
    // RETURNING 에서는 EXCLUDED 를 참조할 수 없다. changed_at 이 이번 문장의 now() 와
    // 같으면 상태가 바뀐 것이다 — 안 바뀐 행은 예전 changed_at 을 그대로 들고 있다.
    const res = await all<{ moved: boolean }>(
      `INSERT INTO creator_health (creator_id, state, severity, reasons)
       VALUES ${values.join(",")}
       ON CONFLICT (creator_id) DO UPDATE SET
         state = EXCLUDED.state, severity = EXCLUDED.severity, reasons = EXCLUDED.reasons,
         checked_at = now(),
         changed_at = CASE WHEN creator_health.state <> EXCLUDED.state THEN now() ELSE creator_health.changed_at END
       RETURNING (changed_at = now()) AS moved`,
      params,
    );
    changed += res.filter((r) => r.moved).length;
  }
  return changed;
}

/** 상태 요약. 화면이 쓴다. */
export async function healthSummary() {
  if (!(await hasTable("creator_health"))) return [];
  return await all<{ state: string; severity: string; n: number }>(
    `SELECT state, severity, count(*)::int AS n FROM creator_health GROUP BY state, severity ORDER BY n DESC`,
  );
}

/** 소스별 업로드 신선도. 업로드가 끊기면 모든 판정이 낡은 데이터 위에서 돈다. */
export async function freshness() {
  if (!(await hasTable("source_freshness"))) return [];
  return await all<{ source: string; last_upload: string; days_ago: number; rows_total: number }>(
    `SELECT source, to_char(last_upload,'YYYY-MM-DD') AS last_upload, days_ago, rows_total
       FROM source_freshness ORDER BY days_ago DESC`,
  );
}

export interface DomainProgress {
  checked: number;
  invalid: number;
  remaining: number;
  done: boolean;
}

/**
 * 이메일 도메인 MX 확인.
 *
 * 도메인 단위로 캐시한다 — 2만 개 주소가 몇 개 도메인에 몰린다.
 * MX 가 없으면 그 도메인의 주소는 invalid 로 내린다. 게이트가 걸러낸다.
 */
export async function verifyEmailDomains(opts: { limit?: number } = {}): Promise<DomainProgress> {
  const limit = opts.limit ?? 50;

  const todo = await all<{ domain: string }>(
    `SELECT DISTINCT split_part(cp.value_norm, '@', 2) AS domain
       FROM contact_point cp
       LEFT JOIN email_domain d ON d.domain = split_part(cp.value_norm, '@', 2)
      WHERE cp.channel = 'email' AND cp.value_norm LIKE '%@%' AND d.domain IS NULL
      ORDER BY 1 LIMIT $1`,
    [limit],
  );

  let invalid = 0;
  for (const { domain } of todo) {
    let hasMx: boolean | null = null;
    let note: string | null = null;
    try {
      hasMx = (await dns.resolveMx(domain)).length > 0;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      // NXDOMAIN·NODATA 는 판정이다. 그 밖(타임아웃 등)은 판정하지 않고 다음에 다시 본다.
      if (code === "ENOTFOUND" || code === "ENODATA") hasMx = false;
      else note = code;
    }
    if (note) continue;
    await run(
      `INSERT INTO email_domain (domain, has_mx, note) VALUES ($1,$2,$3)
       ON CONFLICT (domain) DO UPDATE SET has_mx=EXCLUDED.has_mx, checked_at=now(), note=EXCLUDED.note`,
      [domain, hasMx, note],
    );
    if (hasMx === false) invalid++;
  }

  // 판정을 연락처에 반영한다. 'valid' 로는 올리지 않는다 — MX 가 있다고 주소가
  // 존재하는 건 아니다. 확실한 것만 내린다.
  await run(
    `UPDATE contact_point cp SET verification = 'invalid'
       FROM email_domain d
      WHERE cp.channel='email' AND split_part(cp.value_norm,'@',2) = d.domain
        AND d.has_mx = false AND cp.verification <> 'invalid'`,
  );

  const remaining = (await one<{ n: number }>(
    `SELECT count(DISTINCT split_part(cp.value_norm,'@',2))::int AS n
       FROM contact_point cp
       LEFT JOIN email_domain d ON d.domain = split_part(cp.value_norm,'@',2)
      WHERE cp.channel='email' AND cp.value_norm LIKE '%@%' AND d.domain IS NULL`,
  ))!.n;

  return { checked: todo.length, invalid, remaining, done: remaining === 0 };
}
