import Link from "next/link";
import { IgLink, Note, Pill } from "@/components/ui";
import { all, one } from "@/lib/db";
import { fmt, fol, CHANNEL_LABEL, SOURCE_LABEL, SOURCE_TYPE_LABEL, STAGE_TONE } from "@/lib/format";
import { score, type CreatorRow, getCampaign, defaultCampaign } from "@/lib/queries";
import { BREAKDOWN_LABEL, TIER_LABEL, type Breakdown } from "@/lib/score";
import { INTEREST_LABEL, interestTone } from "@/lib/states";

/** 통합 프로필. 서버에서 렌더하고 URL 로 열고 닫는다 — 클라이언트 자바스크립트가 필요 없다. */
export default async function CreatorDrawer({
  creatorId,
  campaignId,
  closeHref,
}: {
  creatorId: string;
  campaignId: string | null;
  closeHref: string;
}) {
  if (!/^[0-9a-f-]{36}$/i.test(creatorId)) return null;
  const campaign = campaignId ? await getCampaign(campaignId) : await defaultCampaign();

  const row = await one<CreatorRow & { home_region: string | null; gb_experience: string }>(
    `SELECT c.id AS creator_id, c.display_name, c.tier, c.is_curated, c.home_region, c.gb_experience,
            sa.handle, sa.profile_url, sa.is_active,
            v.followers, v.following, v.posts_count, v.engagement_rate, v.credibility,
            v.deals_30d, v.deals_90d, v.avg_interval_days, v.days_since_last,
            COALESCE(v.category_share,'{}'::jsonb) AS category_share,
            to_char(v.captured_at,'YYYY-MM-DD HH24:MI') AS captured_at,
            v.followers_precision,
            cp.reach, COALESCE(cp.email_verified,false) AS email_verified,
            (COALESCE(sup.n,0) > 0) AS suppressed,
            COALESCE(slots.n,0)::int AS active_slots,
            conf.days_ago::int AS conflict_days, conf.brand_name AS conflict_brand,
            NULL::text AS last_contact_at,
            ps.key AS stage_key, ps.label AS stage_label,
            cm.engine_state, cm.interest_status, cm.id AS member_id
       FROM creator c
       JOIN social_account sa ON sa.creator_id = c.id
       LEFT JOIN LATERAL (SELECT * FROM account_snapshot s WHERE s.social_account_id=sa.id ORDER BY s.captured_at DESC LIMIT 1) v ON true
       LEFT JOIN LATERAL (
         SELECT CASE WHEN bool_or(channel='email') THEN 'email'
                     WHEN bool_or(channel IN ('inpock_offer','linktree_form')) THEN 'inpock'
                     WHEN bool_or(channel='instagram_dm') THEN 'dm' END AS reach,
                bool_or(channel='email' AND verification='valid') AS email_verified
           FROM contact_point WHERE creator_id=c.id) cp ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS n FROM suppression s
          WHERE (s.identifier_type='ig_handle' AND s.identifier_val=sa.handle)
             OR (s.identifier_type='creator_id' AND s.identifier_val=c.id::text)
             OR (s.identifier_type='email' AND s.identifier_val IN (SELECT value_norm FROM contact_point WHERE creator_id=c.id))) sup ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS n FROM deal d WHERE d.creator_id=c.id AND d.status='active'
            AND NOT d.is_always_on AND d.close_date >= CURRENT_DATE) slots ON true
       LEFT JOIN LATERAL (
         SELECT (CURRENT_DATE - d.open_date) AS days_ago, b.name AS brand_name
           FROM deal d JOIN brand b ON b.id=d.brand_id
          WHERE d.creator_id=c.id AND d.status='active' AND d.open_date BETWEEN CURRENT_DATE - 90 AND CURRENT_DATE
            AND (b.category = $2 OR b.id = $3)
          ORDER BY d.open_date DESC LIMIT 1) conf ON true
       LEFT JOIN LATERAL (
         SELECT * FROM campaign_member m WHERE m.creator_id=c.id ORDER BY (m.campaign_id=$3) DESC, m.created_at DESC LIMIT 1) cm ON true
       LEFT JOIN pipeline_stage ps ON ps.id = cm.stage_id
      WHERE c.id = $1`,
    [creatorId, campaign?.category ?? null, campaign?.brand_id ?? null],
  );
  if (!row) return null;

  const [deals, brands, contacts, msgs, sources] = await Promise.all([
    all<{ title: string; brand_name: string | null; open_date: string | null; close_date: string | null; is_always_on: boolean; status: string; price_krw: number | null }>(
      `SELECT d.title, b.name AS brand_name,
              to_char(d.open_date,'YYYY-MM-DD') AS open_date,
              to_char(d.close_date,'YYYY-MM-DD') AS close_date,
              d.is_always_on, d.status, d.price_krw
         FROM deal d LEFT JOIN brand b ON b.id=d.brand_id
        WHERE d.creator_id=$1 ORDER BY d.open_date DESC NULLS LAST LIMIT 12`, [creatorId]),
    all<{ name: string; last: string; n: string }>(
      `SELECT b.name, to_char(max(d.open_date),'YYYY-MM-DD') AS last, count(*) AS n
         FROM deal d JOIN brand b ON b.id=d.brand_id
        WHERE d.creator_id=$1 GROUP BY b.id, b.name ORDER BY max(d.open_date) DESC NULLS LAST`, [creatorId]),
    all<{ channel: string; value: string; source_type: string; source_url: string; collected_at: string; collected_by: string; consent_status: string; verification: string; collect_note: string | null }>(
      `SELECT cp.channel, cp.value, cp.source_type, cp.source_url,
              to_char(cp.collected_at,'YYYY-MM-DD') AS collected_at,
              u.name AS collected_by, cp.consent_status, cp.verification, cp.collect_note
         FROM contact_point cp JOIN app_user u ON u.id=cp.collected_by
        WHERE cp.creator_id=$1`, [creatorId]),
    all<{ direction: string; channel: string; sent_at: string; campaign: string; subject: string | null }>(
      `SELECT m.direction, m.channel, to_char(m.sent_at,'MM-DD HH24:MI') AS sent_at,
              cp.name AS campaign, m.subject
         FROM message m
         JOIN campaign_member cm ON cm.id=m.campaign_member_id
         JOIN campaign cp ON cp.id=cm.campaign_id
        WHERE cm.creator_id=$1 ORDER BY m.sent_at DESC LIMIT 8`, [creatorId]),
    all<{ source: string }>(`SELECT DISTINCT source FROM source_ref WHERE entity='creator' AND entity_id=$1`, [creatorId]),
  ]);

  const s = score(row, campaign);
  const share = Object.entries(row.category_share ?? {}).sort((a, b) => b[1] - a[1]);
  const precision = (row as unknown as { followers_precision: number | null }).followers_precision;

  return (
    <>
      <Link className="scrim" href={closeHref} aria-label="닫기" scroll={false} />
      <aside className="drawer" role="dialog" aria-label="크리에이터 상세">
        <div className="drawer-h">
          <div className="avatar">{row.display_name.charAt(0)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{row.display_name}</div>
            <div className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
              <IgLink handle={row.handle}>@{row.handle} ↗</IgLink>
              {" · "}{TIER_LABEL[row.tier ?? ""] ?? row.tier}
              {row.home_region ? ` · ${row.home_region}` : ""}
            </div>
            <div style={{ marginTop: 6, display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
              {row.stage_key && <Pill tone={STAGE_TONE[row.stage_key] ?? "k-mute"}>{row.stage_label}</Pill>}
              {row.interest_status ? <Pill tone={interestTone(row.interest_status)}>{INTEREST_LABEL[row.interest_status]}</Pill> : null}
              {row.is_curated && <Pill tone="k-vio">검증 큐레이션</Pill>}
              {!row.is_active && <Pill tone="k-stop">비활성 계정</Pill>}
              <span className="srcdots">
                {(["momcal", "pangpang", "ingong"] as const).map((k) => (
                  <b key={k} className={sources.some((x) => x.source === k) ? "on" : ""} title={k}>{SOURCE_LABEL[k]}</b>
                ))}
              </span>
            </div>
          </div>
          <Link className="btn sm" href={closeHref} scroll={false}>닫기</Link>
        </div>

        <div className="drawer-b">
          <div className="dsec">
            <div className="statgrid">
              <div><span>팔로워</span><b>{fol(row.followers)}</b></div>
              <div><span>30일 딜</span><b>{row.deals_30d ?? "—"}</b></div>
              <div><span>평균 간격</span><b>{row.avg_interval_days ? Math.round(Number(row.avg_interval_days)) : "—"}</b></div>
              <div><span>적합도</span><b>{s.fit.excluded ? "제외" : s.fit.score}</b></div>
            </div>
            {row.captured_at && (
              <p className="mono" style={{ margin: "6px 0 0", fontSize: 11, color: "var(--ink-3)" }}>
                스냅샷 {row.captured_at}
                {precision ? ` · 팔로워 반올림 오차 ±${precision}` : ""}
                {" · "}팔로잉 {fmt(row.following)} · 게시물 {fmt(row.posts_count)}
                {row.engagement_rate != null ? ` · ER ${(Number(row.engagement_rate) * 100).toFixed(2)}%` : ""}
                {row.credibility != null ? ` · 진성 ${Number(row.credibility).toFixed(0)}%` : ""}
              </p>
            )}
          </div>

          <div className="dsec">
            <h4>적합도 산정 — {campaign?.name}</h4>
            {s.fit.excluded && <Note tone="stop"><b>제외됨.</b> {s.fit.reason}</Note>}
            <div className="share" style={{ marginTop: s.fit.excluded ? 10 : 0 }}>
              {(Object.keys(s.fit.breakdown) as (keyof Breakdown)[]).map((k) => (
                <div className="shrow" key={k} style={{ gridTemplateColumns: "104px 1fr 44px" }}>
                  <span>{BREAKDOWN_LABEL[k]}</span>
                  <span className="shbar">
                    <i style={{ width: `${Math.min(100, Math.abs(s.fit.breakdown[k]) * 2.5)}%`,
                                background: s.fit.breakdown[k] < 0 ? "var(--stop)" : undefined }} />
                  </span>
                  <span className="mono" style={{ textAlign: "right", color: s.fit.breakdown[k] < 0 ? "var(--stop)" : undefined }}>
                    {s.fit.breakdown[k] > 0 ? `+${s.fit.breakdown[k]}` : s.fit.breakdown[k]}
                  </span>
                </div>
              ))}
            </div>
            {s.fit.notes.length > 0 && (
              <ul className="tight" style={{ marginTop: 10, fontSize: 11.5 }}>
                {s.fit.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            )}
          </div>

          <div className="dsec">
            <h4>타이밍</h4>
            {s.timing.ready ? <Note><b>지금이 적기입니다.</b> {s.timing.label}</Note>
              : <Note tone="warn"><b>{s.timing.label}</b></Note>}
          </div>

          <div className="dsec">
            <h4>카테고리 점유율</h4>
            <div className="share">
              {share.length === 0 && <p style={{ color: "var(--ink-3)", fontSize: 12, margin: 0 }}>점유율 데이터가 없습니다.</p>}
              {share.map(([k, v]) => (
                <div className="shrow" key={k}>
                  <span>{k}</span><span className="shbar"><i style={{ width: `${v}%` }} /></span><span className="mono">{v}%</span>
                </div>
              ))}
            </div>
          </div>

          <div className="dsec">
            <h4>공구 이력</h4>
            {deals.length === 0 ? <p style={{ color: "var(--ink-3)", fontSize: 12, margin: 0 }}>수집된 공구 이력이 없습니다.</p> : (
              <div className="tl">
                {deals.map((d, i) => {
                  const label = d.status === "gone" ? "소멸" : d.is_always_on ? "상시"
                    : d.close_date && d.close_date < new Date().toISOString().slice(0, 10) ? "마감" : "진행·예정";
                  return (
                    <div className={`tlrow${label === "마감" || label === "소멸" ? " past" : ""}`} key={i}>
                      <b>{d.title}</b>
                      <span>
                        {d.is_always_on ? "상시" : `${d.open_date} ~ ${d.close_date}`} · {d.brand_name ?? "브랜드 미상"} · {label}
                        {d.price_krw ? ` · ${fmt(d.price_krw)}원` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="dsec">
            <h4>브랜드 이력</h4>
            {brands.length === 0 ? <p style={{ color: "var(--ink-3)", fontSize: 12, margin: 0 }}>기록된 브랜드 이력이 없습니다.</p> : (
              <div className="share">
                {brands.map((b) => (
                  <div className="shrow" key={b.name}>
                    <span>{b.name}</span>
                    <span className="mono" style={{ color: "var(--ink-3)", fontSize: 11.5 }}>{b.last}</span>
                    <span className="mono" style={{ textAlign: "right" }}>{b.n}회</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="dsec">
            <h4>연락처 · 수집 근거</h4>
            {contacts.length === 0 ? (
              <p style={{ color: "var(--ink-3)", fontSize: 12, margin: 0 }}>연락 경로 미확보 — 인포크 제안 큐로 분기됩니다.</p>
            ) : contacts.map((cp, i) => (
              <dl className="kv" key={i} style={{ marginBottom: 10 }}>
                <dt>{CHANNEL_LABEL[cp.channel] ?? cp.channel}</dt><dd className="mono">{cp.value}</dd>
                <dt>수집 출처</dt><dd>{SOURCE_TYPE_LABEL[cp.source_type] ?? cp.source_type}{cp.collect_note ? ` · ${cp.collect_note}` : ""}</dd>
                <dt>원본 URL</dt><dd style={{ fontSize: 11, color: "var(--ink-3)" }}>{cp.source_url}</dd>
                <dt>수집 일시</dt><dd className="mono">{cp.collected_at}</dd>
                <dt>수집자</dt><dd>{cp.collected_by}</dd>
                <dt>동의 · 검증</dt><dd className="mono" style={{ fontSize: 11.5 }}>{cp.consent_status} · {cp.verification}</dd>
              </dl>
            ))}
          </div>

          <div className="dsec">
            <h4>컨택 이력</h4>
            {msgs.length === 0 ? <p style={{ color: "var(--ink-3)", fontSize: 12, margin: 0 }}>발송 기록이 없습니다.</p> : (
              <div className="scroller">
                <table style={{ minWidth: 0 }}>
                  <thead><tr><th>일시</th><th>방향</th><th>채널</th><th>캠페인</th></tr></thead>
                  <tbody>
                    {msgs.map((m, i) => (
                      <tr key={i}>
                        <td className="num">{m.sent_at}</td>
                        <td>{m.direction === "out" ? <Pill tone="k-acc">발송</Pill> : <Pill tone="k-ok">회신</Pill>}</td>
                        <td>{CHANNEL_LABEL[m.channel] ?? m.channel}</td>
                        <td>{m.campaign}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, paddingBottom: 8 }}>
            <Link className="btn pri" href={`/send?campaign=${campaign?.id ?? ""}`}>제안 발송으로</Link>
            <Link className="btn" href="/inbox">대화 보기</Link>
          </div>
        </div>
      </aside>
    </>
  );
}
