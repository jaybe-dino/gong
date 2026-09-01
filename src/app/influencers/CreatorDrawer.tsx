import Link from "next/link";
import { Note, Pill, IgLink, SrcDots } from "@/components/ui";
import { all, one } from "@/lib/db";
import { today } from "@/lib/clock";
import { fmt, fol } from "@/lib/format";
import { creatorMetrics } from "@/lib/metrics";
import { scoreCreator, type CampaignLike } from "@/lib/scoring";
import { dealStatus } from "@/lib/deals";

/**
 * 통합 프로필 드로어. 서버에서 렌더하고 URL 로 열고 닫는다 —
 * 이 화면에는 클라이언트 자바스크립트가 필요 없다.
 */
export default function CreatorDrawer({
  creatorId,
  campaign,
  closeHref,
}: {
  creatorId: number;
  campaign: CampaignLike & { name: string };
  closeHref: string;
}) {
  const ref = today();
  const c = one<{
    id: number; display_name: string; tier: string; primary_category: string | null;
    region: string | null; curated: number; handle: string;
  }>(
    `SELECT c.id, c.display_name, c.tier, c.primary_category, c.region, c.curated, a.handle
       FROM creator c JOIN social_account a ON a.creator_id=c.id AND a.is_primary=1
      WHERE c.id = ?`,
    [creatorId],
  );
  if (!c) return null;

  const snap = one<{ followers: number | null; following: number | null; posts_count: number | null; observed_at: string; precision: number }>(
    `SELECT followers, following, posts_count, observed_at, precision FROM account_snapshot
      WHERE account_id=(SELECT id FROM social_account WHERE creator_id=? AND is_primary=1)
      ORDER BY observed_at DESC LIMIT 1`,
    [creatorId],
  );
  const shares = all<{ category: string; pct: number }>(
    `SELECT category, pct FROM category_share WHERE creator_id=? ORDER BY pct DESC`, [creatorId],
  );
  const deals = all<{ product_name: string; brand: string | null; starts_on: string | null; ends_on: string | null; is_always_on: number; gone_at: string | null }>(
    `SELECT d.product_name, b.name AS brand, d.starts_on, d.ends_on, d.is_always_on, d.gone_at
       FROM deal d LEFT JOIN brand b ON b.id=d.brand_id
       JOIN social_account a ON a.id=d.account_id
      WHERE a.creator_id=? ORDER BY d.starts_on DESC LIMIT 12`,
    [creatorId],
  );
  const brands = all<{ name: string; last: string; n: number }>(
    `SELECT b.name, MAX(d.starts_on) AS last, COUNT(*) AS n
       FROM deal d JOIN brand b ON b.id=d.brand_id
       JOIN social_account a ON a.id=d.account_id
      WHERE a.creator_id=? GROUP BY b.id ORDER BY last DESC`,
    [creatorId],
  );
  const contacts = all<{ kind: string; value: string; source_desc: string; collected_at: string; collected_by: string; consent: string }>(
    `SELECT kind, value, source_desc, collected_at, collected_by, consent FROM contact_point WHERE creator_id=?`,
    [creatorId],
  );
  const logs = all<{ sent_at: string; channel: string; result: string; camp: string | null }>(
    `SELECT o.sent_at, o.channel, o.result, cp.name AS camp
       FROM outreach_log o LEFT JOIN campaign cp ON cp.id=o.campaign_id
      WHERE o.creator_id=? ORDER BY o.sent_at DESC LIMIT 8`,
    [creatorId],
  );
  const sources = all<{ source: string }>(
    `SELECT DISTINCT source FROM source_ref WHERE entity_type='creator' AND entity_id=?`, [creatorId],
  ).map((r) => r.source);
  const stage = one<{ stage: string; camp: string }>(
    `SELECT ct.stage, cp.name AS camp FROM campaign_target ct JOIN campaign cp ON cp.id=ct.campaign_id
      WHERE ct.creator_id=? ORDER BY ct.updated_at DESC LIMIT 1`, [creatorId],
  );

  const m = creatorMetrics(creatorId, ref);
  const fit = scoreCreator(creatorId, campaign, ref);
  const ratio = m.cadence && m.lastDealDays != null ? m.lastDealDays / m.cadence : null;

  return (
    <>
      <Link className="scrim" href={closeHref} aria-label="닫기" scroll={false} />
      <aside className="drawer" role="dialog" aria-label="크리에이터 상세">
        <div className="drawer-h">
          <div className="avatar">{c.display_name.charAt(0)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{c.display_name}</div>
            <div className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
              <IgLink handle={c.handle}>@{c.handle} ↗</IgLink> · {c.primary_category ?? "미분류"} · {c.tier}
              {c.region ? ` · ${c.region}` : ""}
            </div>
            <div style={{ marginTop: 6, display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
              {stage && <Pill tone="k-acc">{stage.camp} · {stage.stage}</Pill>}
              {c.curated === 1 && <Pill tone="k-vio">검증 큐레이션</Pill>}
              <SrcDots sources={sources} />
            </div>
          </div>
          <Link className="btn sm" href={closeHref} scroll={false}>닫기</Link>
        </div>

        <div className="drawer-b">
          <div className="dsec">
            <div className="statgrid">
              <div><span>팔로워</span><b>{fol(snap?.followers)}</b></div>
              <div><span>30일 딜</span><b>{m.deals30}</b></div>
              <div><span>평균 간격</span><b>{m.cadence ? Math.round(m.cadence) : "—"}</b></div>
              <div><span>적합도</span><b>{fit.excluded ? "제외" : fit.score}</b></div>
            </div>
            {snap && (
              <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--ink-3)" }} className="mono">
                스냅샷 {snap.observed_at}
                {snap.precision ? ` · 팔로워 반올림 오차 ±${snap.precision}` : ""}
                {" · "}팔로잉 {fmt(snap.following)} · 게시물 {fmt(snap.posts_count)}
              </p>
            )}
          </div>

          <div className="dsec">
            <h4>적합도 산정 — {campaign.name}</h4>
            {fit.excluded ? (
              <Note tone="stop">
                <b>제외됨.</b> {fit.excludeReason}
              </Note>
            ) : null}
            <div className="share" style={{ marginTop: fit.excluded ? 10 : 0 }}>
              {fit.reasons.map((r) => (
                <div className="shrow" key={r.label} style={{ gridTemplateColumns: "104px 1fr 44px" }}>
                  <span>{r.label}</span>
                  <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{r.detail}</span>
                  <span className="mono" style={{ textAlign: "right", color: r.points > 0 ? "var(--ok)" : r.points < 0 ? "var(--stop)" : "var(--ink-3)" }}>
                    {r.points > 0 ? `+${r.points}` : r.points}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="dsec">
            <h4>타이밍</h4>
            {ratio == null ? (
              <Note tone="warn">간격을 계산할 만큼의 공구 이력이 없습니다.</Note>
            ) : ratio >= 0.8 ? (
              <Note>
                <b>지금이 적기입니다.</b> 평균 {Math.round(m.cadence!)}일 간격으로 공구를 여는데 마지막 공구가{" "}
                {m.lastDealDays}일 전입니다. 다음 공구를 준비할 시점입니다.
              </Note>
            ) : (
              <Note tone="warn">
                <b>아직 이릅니다.</b> 마지막 공구가 {m.lastDealDays}일 전이고 평균 간격은 {Math.round(m.cadence!)}일입니다. 약{" "}
                {Math.max(0, Math.round(m.cadence! * 0.8 - m.lastDealDays!))}일 후 재평가를 권합니다.
              </Note>
            )}
          </div>

          <div className="dsec">
            <h4>카테고리 점유율</h4>
            <div className="share">
              {shares.map((s) => (
                <div className="shrow" key={s.category}>
                  <span>{s.category}</span>
                  <span className="shbar"><i style={{ width: `${s.pct}%` }} /></span>
                  <span className="mono">{s.pct}%</span>
                </div>
              ))}
            </div>
          </div>

          <div className="dsec">
            <h4>공구 이력</h4>
            {deals.length === 0 ? (
              <p style={{ color: "var(--ink-3)", fontSize: 12, margin: 0 }}>수집된 공구 이력이 없습니다.</p>
            ) : (
              <div className="tl">
                {deals.map((d, i) => {
                  const st = d.gone_at ? "소멸" : d.is_always_on ? "상시" :
                    dealStatus(d, ref) === "live" ? "진행중" : dealStatus(d, ref) === "soon" ? "예정" : "마감";
                  return (
                    <div className={`tlrow${st === "마감" || st === "소멸" ? " past" : ""}`} key={i}>
                      <b>{d.product_name}</b>
                      <span>
                        {d.is_always_on ? "상시" : `${d.starts_on} ~ ${d.ends_on}`} · {d.brand ?? "브랜드 미상"} · {st}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="dsec">
            <h4>브랜드 이력</h4>
            {brands.length === 0 ? (
              <p style={{ color: "var(--ink-3)", fontSize: 12, margin: 0 }}>기록된 브랜드 이력이 없습니다.</p>
            ) : (
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
              <p style={{ color: "var(--ink-3)", fontSize: 12, margin: 0 }}>
                연락 경로 미확보 — 인포크 제안 큐로 분기됩니다.
              </p>
            ) : (
              contacts.map((cp) => (
                <dl className="kv" key={cp.value} style={{ marginBottom: 10 }}>
                  <dt>{cp.kind}</dt>
                  <dd className="mono">{cp.value}</dd>
                  <dt>수집 출처</dt>
                  <dd>{cp.source_desc}</dd>
                  <dt>수집 일시</dt>
                  <dd className="mono">{cp.collected_at}</dd>
                  <dt>수집자</dt>
                  <dd>{cp.collected_by}</dd>
                  <dt>동의 상태</dt>
                  <dd>{cp.consent}</dd>
                </dl>
              ))
            )}
          </div>

          <div className="dsec">
            <h4>컨택 이력</h4>
            {logs.length === 0 ? (
              <p style={{ color: "var(--ink-3)", fontSize: 12, margin: 0 }}>발송 기록이 없습니다.</p>
            ) : (
              <div className="scroller">
                <table style={{ minWidth: 0 }}>
                  <thead>
                    <tr><th>일시</th><th>채널</th><th>캠페인</th><th>결과</th></tr>
                  </thead>
                  <tbody>
                    {logs.map((l, i) => (
                      <tr key={i}>
                        <td className="num">{l.sent_at.slice(5, 10)}</td>
                        <td>{l.channel === "email" ? "이메일" : "IG DM"}</td>
                        <td>{l.camp ?? "—"}</td>
                        <td>
                          {l.result === "replied" ? <Pill tone="k-ok">회신</Pill>
                            : l.result === "bounced" ? <Pill tone="k-stop">바운스</Pill>
                            : <Pill tone="k-mute">무응답</Pill>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, paddingBottom: 8 }}>
            <Link className="btn pri" href="/send">제안 발송으로</Link>
            <Link className="btn" href="/inbox">대화 보기</Link>
          </div>
        </div>
      </aside>
    </>
  );
}
