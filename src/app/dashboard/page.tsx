import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Funnel, IgLink, Note, Pill, Scroller } from "@/components/ui";
import { all, one } from "@/lib/db";
import { krDate, today } from "@/lib/clock";
import { defaultCampaign, breakers, senders } from "@/lib/queries";
import { fmt, pct, STAGE_TONE } from "@/lib/format";
import { INTEREST_LABEL, interestTone } from "@/lib/states";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const campaign = await defaultCampaign();

  const [sent7, sent14, mail, agreed, contacted, brs, snd, recent, stages, tasks, pendingBatch, ripe] = await Promise.all([
    one<{ n: string }>(`SELECT count(*) AS n FROM message WHERE direction='out' AND sent_at >= now() - interval '7 days'`),
    one<{ n: string }>(`SELECT count(*) AS n FROM message WHERE direction='out' AND sent_at >= now() - interval '14 days' AND sent_at < now() - interval '7 days'`),
    one<{ sent: string; replied: string }>(
      `SELECT count(*) FILTER (WHERE direction='out') AS sent,
              count(*) FILTER (WHERE direction='in')  AS replied
         FROM message WHERE channel='email'`),
    one<{ n: string; gmv: string }>(
      `SELECT count(*) AS n, COALESCE(sum(m.gmv),0) AS gmv FROM campaign_member m
         JOIN pipeline_stage ps ON ps.id=m.stage_id
        WHERE ps.key IN ('agreed','sampling','live','settling','complete')`),
    one<{ n: string }>(`SELECT count(DISTINCT campaign_member_id) AS n FROM message WHERE direction='out'`),
    breakers(),
    senders(),
    all<{ handle: string; display_name: string; interest_status: number; campaign: string; last_at: string }>(
      `SELECT sa.handle, c.display_name, m.interest_status, cp.name AS campaign,
              to_char(max(msg.sent_at),'MM-DD HH24:MI') AS last_at
         FROM campaign_member m
         JOIN creator c ON c.id=m.creator_id
         JOIN social_account sa ON sa.creator_id=c.id
         JOIN campaign cp ON cp.id=m.campaign_id
         JOIN message msg ON msg.campaign_member_id=m.id AND msg.direction='in'
        GROUP BY sa.handle, c.display_name, m.interest_status, cp.name
        ORDER BY max(msg.sent_at) DESC LIMIT 6`),
    all<{ key: string; label: string; n: string }>(
      `SELECT ps.key, ps.label, count(m.id) AS n
         FROM pipeline_stage ps
         LEFT JOIN campaign_member m ON m.stage_id=ps.id AND m.campaign_id=$1
        GROUP BY ps.key, ps.label, ps.sort_order ORDER BY ps.sort_order`,
      [campaign?.id ?? null]),
    one<{ dm: string; inpock: string }>(
      `SELECT count(*) FILTER (WHERE channel='instagram_dm') AS dm,
              count(*) FILTER (WHERE channel IN ('inpock_offer','linktree_form')) AS inpock
         FROM outreach_task WHERE state IN ('queued','claimed')`),
    one<{ id: string; filename: string; rows_read: number; rows_new: number }>(
      `SELECT id, filename, rows_read, rows_new FROM import_batch WHERE state='dry_run' ORDER BY created_at DESC LIMIT 1`),
    one<{ n: string }>(
      `SELECT count(*) AS n FROM (
         SELECT DISTINCT ON (s.social_account_id) s.avg_interval_days, s.days_since_last
           FROM account_snapshot s ORDER BY s.social_account_id, s.captured_at DESC) x
        WHERE x.avg_interval_days > 0
          AND x.days_since_last BETWEEN x.avg_interval_days * 0.8 AND x.avg_interval_days * 2.2`),
  ]);

  const w = Number(sent7?.n ?? 0);
  const wPrev = Number(sent14?.n ?? 0);
  const wow = wPrev ? Math.round(((w - wPrev) / wPrev) * 100) : null;
  const emailSent = Number(mail?.sent ?? 0);
  const emailReplied = Number(mail?.replied ?? 0);
  const replyRate = emailSent ? (emailReplied / emailSent) * 100 : 0;
  const agreedN = Number(agreed?.n ?? 0);
  const gmv = Number(agreed?.gmv ?? 0);
  const contactedN = Number(contacted?.n ?? 0);

  const spam = brs.find((b) => b.metric === "spam_rate");
  const bounce = brs.find((b) => b.metric === "bounce_rate");
  const asPct = (v: string | null) => (v == null ? 0 : Number(v) * 100);

  // 스테이지는 현재 상태다. 퍼널로 보려면 뒤 단계를 누적해 올린다.
  const order = ["prospect", "qualified", "contacted", "replied", "negotiating", "agreed", "sampling", "live"];
  const counts = Object.fromEntries(stages.map((s) => [s.key, Number(s.n)]));
  const total = stages.reduce((a, b) => a + Number(b.n), 0);
  const cumulative = order.map((k, i) => ({
    label: stages.find((s) => s.key === k)?.label ?? k,
    count: order.slice(i).reduce((a, kk) => a + (counts[kk] ?? 0), 0),
  }));

  const slaThread = recent.find((r) => !r.interest_status);

  return (
    <Shell path="/dashboard" title="대시보드" sub={krDate(today())}>
      <section className="screen">
        <div className="kpis">
          <div className="kpi">
            <span className="lab">이번 주 발송</span>
            <div className="val">{fmt(w)}<small>건</small></div>
            <div className={`delta ${wow != null && wow >= 0 ? "up" : "down"}`}>
              {wow == null ? "지난주 기록 없음" : `${wow >= 0 ? "▲" : "▼"} 지난주 대비 ${wow >= 0 ? "+" : ""}${wow}%`}
            </div>
          </div>
          <div className="kpi">
            <span className="lab">회신율 (이메일)</span>
            <div className="val">{replyRate.toFixed(1)}<small>%</small></div>
            <div className={`delta ${replyRate >= 4 ? "up" : ""}`}>{replyRate >= 4 ? "▲ 목표 4.0% 상회" : "목표 4.0%"}</div>
            <div className="meter"><i style={{ width: `${Math.min(100, (replyRate / 10) * 100)}%` }} /></div>
          </div>
          <div className="kpi">
            <span className="lab">확정 이상</span>
            <div className="val">{fmt(agreedN)}<small>건</small></div>
            <div className="delta">수락률 {pct(contactedN ? (agreedN / contactedN) * 100 : 0)}</div>
          </div>
          {spam && (
            <div className="kpi">
              <span className="lab">스팸 신고율</span>
              <div className="val">{asPct(spam.current_value).toFixed(2)}<small>%</small></div>
              <div className={`delta ${spam.is_tripped ? "down" : "up"}`}>기준 {asPct(spam.warn_at).toFixed(2)}% 이하</div>
              <div className="meter">
                <i className={spam.is_tripped ? "s" : ""} style={{ width: `${Math.min(100, (asPct(spam.current_value) / asPct(spam.halt_at)) * 100)}%` }} />
              </div>
            </div>
          )}
          {bounce && (
            <div className="kpi">
              <span className="lab">바운스율</span>
              <div className="val">{asPct(bounce.current_value).toFixed(1)}<small>%</small></div>
              <div className="delta">기준 {asPct(bounce.warn_at).toFixed(0)}% 이하</div>
              <div className="meter"><i className="w" style={{ width: `${Math.min(100, (asPct(bounce.current_value) / asPct(bounce.warn_at)) * 100)}%` }} /></div>
            </div>
          )}
          <div className="kpi">
            <span className="lab">컨택당 GMV</span>
            <div className="val">{fmt(contactedN ? Math.round(gmv / contactedN) : 0)}<small>원</small></div>
            <div className="delta">확정 {fmt(agreedN)}건 / 컨택 {fmt(contactedN)}명</div>
          </div>
        </div>

        <div className="cols c32">
          <Card title="오늘 처리할 것" right={<Link className="btn sm" href="/queue">작업 큐 열기</Link>}>
            <div className="tasklist">
              {slaThread && (
                <div className="taskrow">
                  <Pill tone="k-stop">회신 대기</Pill>
                  <div>
                    <div className="who"><IgLink handle={slaThread.handle} /> · {slaThread.display_name}</div>
                    <div className="meta">{slaThread.campaign} · {slaThread.last_at} 회신 · 아직 분류되지 않음</div>
                  </div>
                  <Link className="btn sm" href="/inbox">인박스</Link>
                </div>
              )}
              <div className="taskrow">
                <Pill tone="k-warn">DM 큐</Pill>
                <div>
                  <div className="who">{fmt(tasks?.dm ?? 0)}건 대기</div>
                  <div className="meta">인스타 DM 은 콜드 자동 발송이 불가해 사람이 처리합니다</div>
                </div>
                <Link className="btn sm" href="/queue?channel=instagram_dm">배급 받기</Link>
              </div>
              <div className="taskrow">
                <Pill tone="k-acc">인포크 제안</Pill>
                <div>
                  <div className="who">{fmt(tasks?.inpock ?? 0)}건 대기</div>
                  <div className="meta">이메일 미보유 타깃 · 링크페이지 확인 필요</div>
                </div>
                <Link className="btn sm" href="/queue?channel=inpock_offer">열기</Link>
              </div>
              {pendingBatch && (
                <div className="taskrow">
                  <Pill tone="k-vio">임포트</Pill>
                  <div>
                    <div className="who">{pendingBatch.filename} 미반영</div>
                    <div className="meta">{fmt(pendingBatch.rows_read)}행 · 신규 추정 {fmt(pendingBatch.rows_new)}명 · dry-run</div>
                  </div>
                  <Link className="btn sm" href="/import">검토</Link>
                </div>
              )}
              <div className="taskrow">
                <Pill tone="k-ok">타이밍 알림</Pill>
                <div>
                  <div className="who">적기 도달 {fmt(ripe?.n ?? 0)}명</div>
                  <div className="meta">평균 간격 대비 경과일이 0.8~2.2배 구간</div>
                </div>
                <Link className="btn sm" href="/influencers?sort=timing">보기</Link>
              </div>
            </div>
          </Card>

          <Card title="파이프라인" hint={campaign?.name}>
            <div className="card-b">
              <Funnel steps={cumulative.map((s, i) => ({
                label: s.label, count: s.count,
                sub: i > 0 && cumulative[i - 1].count ? `${Math.round((s.count / cumulative[i - 1].count) * 100)}%` : undefined,
              }))} />
              <div style={{ marginTop: 14 }}>
                <Note>
                  스테이지는 현재 상태이고 위 퍼널은 뒤 단계를 누적해 올린 값입니다. 이탈{" "}
                  <b>{fmt(counts.dropped ?? 0)}건</b>은 제외했습니다 (전체 {fmt(total)}명).
                </Note>
              </div>
            </div>
          </Card>
        </div>

        <div className="cols c2">
          <Card title="발신 계정 건강도" hint="daily_cap 이 아니라 램프업된 current_cap 이 실제 상한입니다">
            <Scroller>
              <table>
                <thead><tr><th>계정</th><th>채널</th><th>오늘</th><th>현재 상한</th><th>목표</th><th>상태</th></tr></thead>
                <tbody>
                  {snd.map((s) => (
                    <tr key={s.id}>
                      <td className="mono">{s.identifier}</td>
                      <td>{s.channel === "email" ? "이메일" : "IG DM"}</td>
                      <td className="num">{s.sent_today}</td>
                      <td className="num">{s.current_cap}</td>
                      <td className="num">{s.daily_cap}</td>
                      <td>
                        {s.paused_until ? <Pill tone="k-stop">정지</Pill>
                          : s.current_cap < s.daily_cap ? <Pill tone="k-warn">램프업 D{s.account_age_d}</Pill>
                          : <Pill tone="k-ok">정상</Pill>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          </Card>

          <Card title="최근 회신" right={<Link className="btn sm" href="/inbox">전체 보기</Link>}>
            <Scroller>
              <table>
                <thead><tr><th>크리에이터</th><th>분류</th><th>캠페인</th><th>마지막</th></tr></thead>
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.handle}>
                      <td><IgLink handle={r.handle} /></td>
                      <td><Pill tone={interestTone(r.interest_status)}>{INTEREST_LABEL[r.interest_status] ?? "미분류"}</Pill></td>
                      <td>{r.campaign}</td>
                      <td className="num">{r.last_at}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          </Card>
        </div>

        <Card title="서킷브레이커" hint="지표가 임계를 넘으면 발송 워커가 스스로 멈춥니다">
          <Scroller wide>
            <table>
              <thead><tr><th>지표</th><th>경보</th><th>중단</th><th>조치</th><th>현재</th><th>상태</th></tr></thead>
              <tbody>
                {brs.map((m) => (
                  <tr key={m.metric}>
                    <td>{m.metric}</td>
                    <td className="num">{m.warn_at ?? "—"}</td>
                    <td className="num">{m.halt_at ?? "—"}</td>
                    <td>{m.action}</td>
                    <td className="num">{m.current_value ?? "—"}</td>
                    <td>{m.is_tripped ? <Pill tone="k-stop">발동</Pill> : <Pill tone="k-ok">정상</Pill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
        </Card>
      </section>
    </Shell>
  );
}
