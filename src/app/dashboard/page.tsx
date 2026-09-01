import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Funnel, IgLink, Note, Pill, Scroller } from "@/components/ui";
import { all, one } from "@/lib/db";
import { addDays, krDate, today } from "@/lib/clock";
import { fmt, pct, STAGE_LABEL, STAGE_ORDER, STAGE_TONE, won } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const ref = today();
  const weekAgo = addDays(ref, -7);
  const twoWeeks = addDays(ref, -14);

  const sentWeek = one<{ n: number }>(`SELECT COUNT(*) AS n FROM outreach_log WHERE sent_at >= ?`, [weekAgo])!.n;
  const sentPrev = one<{ n: number }>(`SELECT COUNT(*) AS n FROM outreach_log WHERE sent_at >= ? AND sent_at < ?`, [twoWeeks, weekAgo])!.n;
  const wow = sentPrev ? Math.round(((sentWeek - sentPrev) / sentPrev) * 100) : null;

  const emailSent = one<{ n: number }>(`SELECT COUNT(*) AS n FROM outreach_log WHERE channel='email'`)!.n;
  const emailReplied = one<{ n: number }>(`SELECT COUNT(*) AS n FROM outreach_log WHERE channel='email' AND result='replied'`)!.n;
  const replyRate = emailSent ? (emailReplied / emailSent) * 100 : 0;

  const confirmed = one<{ n: number; gmv: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(gmv),0) AS gmv FROM campaign_target WHERE stage IN ('confirmed','running')`,
  )!;
  const totalContacted = one<{ n: number }>(`SELECT COUNT(DISTINCT creator_id) AS n FROM outreach_log`)!.n;
  const acceptRate = totalContacted ? (confirmed.n / totalContacted) * 100 : 0;
  const gmvPerContact = totalContacted ? Math.round(confirmed.gmv / totalContacted) : 0;

  const circuits = all<{ key: string; label: string; value: number; warn_at: number; stop_at: number | null; unit: string }>(
    `SELECT key, label, value, warn_at, stop_at, unit FROM circuit_metric`,
  );
  const c = (k: string) => circuits.find((x) => x.key === k);
  const spam = c("spam");
  const bounce = c("bounce");

  // 파이프라인 — 가장 큰 캠페인 기준
  const camp = one<{ id: number; name: string }>(
    `SELECT c.id, c.name FROM campaign c
      JOIN campaign_target t ON t.campaign_id = c.id
     GROUP BY c.id ORDER BY COUNT(t.id) DESC LIMIT 1`,
  );
  const stageCounts = camp
    ? all<{ stage: string; n: number }>(`SELECT stage, COUNT(*) AS n FROM campaign_target WHERE campaign_id=? GROUP BY stage`, [camp.id])
    : [];
  const stageMap = Object.fromEntries(stageCounts.map((s) => [s.stage, s.n]));
  const targetsTotal = stageCounts.reduce((s, x) => s + x.n, 0);

  const funnelSteps = [
    { label: "발굴", count: targetsTotal },
    ...STAGE_ORDER.filter((s) => s !== "dropped").map((s) => ({ label: STAGE_LABEL[s], count: stageMap[s] ?? 0 })),
  ];
  // 스테이지는 누적이 아니라 현재 상태다. 퍼널로 보려면 뒤 단계를 더해 올린다.
  const cumulative = funnelSteps.map((s, i) => ({
    ...s,
    count: i === 0 ? s.count : funnelSteps.slice(i).reduce((a, b) => a + b.count, 0),
  }));

  const senders = all<{ identifier: string; channel: string; sent_today: number; daily_cap: number; status: string; ramp_day: number | null }>(
    `SELECT identifier, channel, sent_today, daily_cap, status, ramp_day FROM sender_account ORDER BY channel, id`,
  );

  const recent = all<{ handle: string; name: string; cls: string | null; camp: string | null; last_at: string }>(
    `SELECT a.handle, c.display_name AS name, t.classification AS cls, cp.name AS camp, t.last_at
       FROM thread t
       JOIN creator c ON c.id = t.creator_id
       JOIN social_account a ON a.creator_id = c.id AND a.is_primary=1
       LEFT JOIN campaign cp ON cp.id = t.campaign_id
      ORDER BY t.last_at DESC LIMIT 6`,
  );

  // 오늘 처리할 것
  const slaThread = one<{ handle: string; name: string; camp: string | null; last_at: string; sla_due_at: string | null }>(
    `SELECT a.handle, c.display_name AS name, cp.name AS camp, t.last_at, t.sla_due_at
       FROM thread t JOIN creator c ON c.id=t.creator_id
       JOIN social_account a ON a.creator_id=c.id AND a.is_primary=1
       LEFT JOIN campaign cp ON cp.id=t.campaign_id
      WHERE t.classification IS NULL OR t.classification LIKE '2%'
      ORDER BY t.last_at DESC LIMIT 1`,
  );
  const dmQueue = one<{ n: number }>(`SELECT COUNT(*) AS n FROM task WHERE kind='ig_dm' AND status='pending'`)!.n;
  const inpockQueue = one<{ n: number }>(`SELECT COUNT(*) AS n FROM task WHERE kind='inpock' AND status='pending'`)!.n;
  const dmSender = one<{ identifier: string; sent_today: number; daily_cap: number }>(
    `SELECT identifier, sent_today, daily_cap FROM sender_account WHERE channel='ig_dm' AND status='ok' LIMIT 1`,
  );
  const pendingImport = one<{ id: number; filename: string; rows: number; created: number }>(
    `SELECT id, filename, rows, created FROM import_batch WHERE status='analyzed' ORDER BY created_at DESC LIMIT 1`,
  );
  const ripe = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM creator_metric m
      WHERE m.avg_cadence_days > 0
        AND julianday(?) - julianday(m.last_deal_on) BETWEEN m.avg_cadence_days * 0.8 AND m.avg_cadence_days * 1.2`,
    [ref],
  )!.n;

  return (
    <Shell path="/dashboard" title="대시보드" sub={krDate(ref)}>
      <section className="screen">
        <div className="kpis">
          <div className="kpi">
            <span className="lab">이번 주 발송</span>
            <div className="val">
              {fmt(sentWeek)}
              <small>건</small>
            </div>
            <div className={`delta ${wow != null && wow >= 0 ? "up" : "down"}`}>
              {wow == null ? "지난주 기록 없음" : `${wow >= 0 ? "▲" : "▼"} 지난주 대비 ${wow >= 0 ? "+" : ""}${wow}%`}
            </div>
          </div>
          <div className="kpi">
            <span className="lab">회신율 (이메일)</span>
            <div className="val">
              {replyRate.toFixed(1)}
              <small>%</small>
            </div>
            <div className={`delta ${replyRate >= 4 ? "up" : ""}`}>{replyRate >= 4 ? "▲ 목표 4.0% 상회" : "목표 4.0%"}</div>
            <div className="meter">
              <i style={{ width: `${Math.min(100, (replyRate / 6) * 100)}%` }} />
            </div>
          </div>
          <div className="kpi">
            <span className="lab">수락 (확정)</span>
            <div className="val">
              {fmt(confirmed.n)}
              <small>건</small>
            </div>
            <div className="delta">수락률 {pct(acceptRate)}</div>
          </div>
          {spam && (
            <div className="kpi">
              <span className="lab">{spam.label}</span>
              <div className="val">
                {spam.value}
                <small>{spam.unit}</small>
              </div>
              <div className={`delta ${spam.value < spam.warn_at ? "up" : "down"}`}>기준 {spam.warn_at}{spam.unit} 이하</div>
              <div className="meter">
                <i className={spam.value >= spam.warn_at ? "s" : ""} style={{ width: `${Math.min(100, (spam.value / (spam.stop_at ?? spam.warn_at)) * 100)}%` }} />
              </div>
            </div>
          )}
          {bounce && (
            <div className="kpi">
              <span className="lab">{bounce.label}</span>
              <div className="val">
                {bounce.value}
                <small>{bounce.unit}</small>
              </div>
              <div className="delta">기준 {bounce.warn_at}{bounce.unit} 이하</div>
              <div className="meter">
                <i className="w" style={{ width: `${Math.min(100, (bounce.value / bounce.warn_at) * 100)}%` }} />
              </div>
            </div>
          )}
          <div className="kpi">
            <span className="lab">컨택당 GMV</span>
            <div className="val">
              {fmt(gmvPerContact)}
              <small>원</small>
            </div>
            <div className="delta">확정·진행 {fmt(confirmed.n)}건 / 컨택 {fmt(totalContacted)}명</div>
          </div>
        </div>

        <div className="cols c32">
          <Card title="오늘 처리할 것" right={<Link className="btn sm" href="/queue">작업 큐 열기</Link>}>
            <div className="tasklist">
              {slaThread && (
                <div className="taskrow">
                  <Pill tone="k-stop">회신 대기</Pill>
                  <div>
                    <div className="who">
                      <IgLink handle={slaThread.handle} /> · {slaThread.name}
                    </div>
                    <div className="meta">
                      {slaThread.camp ?? "미배정"} · {slaThread.last_at} 회신
                      {slaThread.sla_due_at ? ` · 응답 SLA ${slaThread.sla_due_at}` : ""}
                    </div>
                  </div>
                  <Link className="btn sm" href="/inbox">인박스</Link>
                </div>
              )}
              <div className="taskrow">
                <Pill tone="k-warn">DM 큐</Pill>
                <div>
                  <div className="who">{dmQueue}건 대기</div>
                  <div className="meta">
                    발신 계정 {dmSender?.identifier ?? "—"} · 오늘 {dmSender?.sent_today ?? 0}/{dmSender?.daily_cap ?? 0} 사용
                  </div>
                </div>
                <Link className="btn sm" href="/queue?kind=ig_dm">배급 받기</Link>
              </div>
              <div className="taskrow">
                <Pill tone="k-acc">인포크 제안</Pill>
                <div>
                  <div className="who">{inpockQueue}건 대기</div>
                  <div className="meta">이메일 미보유 타깃 · 링크페이지 확인 필요</div>
                </div>
                <Link className="btn sm" href="/queue?kind=inpock">열기</Link>
              </div>
              {pendingImport && (
                <div className="taskrow">
                  <Pill tone="k-vio">임포트</Pill>
                  <div>
                    <div className="who">{pendingImport.filename} 미반영</div>
                    <div className="meta">
                      {fmt(pendingImport.rows)}행 · 신규 추정 {fmt(pendingImport.created)}명 · 병합 대기
                    </div>
                  </div>
                  <Link className="btn sm" href="/import">검토</Link>
                </div>
              )}
              <div className="taskrow">
                <Pill tone="k-ok">타이밍 알림</Pill>
                <div>
                  <div className="who">적기 도달 {fmt(ripe)}명</div>
                  <div className="meta">평균 공구 간격이 지나 다음 공구를 열 시점</div>
                </div>
                <Link className="btn sm" href="/influencers?sort=timing">보기</Link>
              </div>
            </div>
          </Card>

          <Card title="파이프라인" hint={camp?.name}>
            <div className="card-b">
              <Funnel
                steps={cumulative.map((s, i) => ({
                  label: s.label,
                  count: s.count,
                  sub: i > 0 && cumulative[i - 1].count ? `${Math.round((s.count / cumulative[i - 1].count) * 100)}%` : undefined,
                }))}
              />
              <div style={{ marginTop: 14 }}>
                <Note>
                  스테이지 카운트는 현재 상태이고, 위 퍼널은 뒤 단계를 누적해 올린 값입니다. 이탈{" "}
                  <b>{fmt(stageMap.dropped ?? 0)}건</b>은 퍼널에서 제외했습니다.
                </Note>
              </div>
            </div>
          </Card>
        </div>

        <div className="cols c2">
          <Card title="발신 계정 건강도" hint="상한과 램프업 상태">
            <Scroller>
              <table>
                <thead>
                  <tr>
                    <th>계정</th>
                    <th>채널</th>
                    <th>오늘</th>
                    <th>상한</th>
                    <th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {senders.map((s) => (
                    <tr key={s.identifier}>
                      <td className="mono">{s.identifier}</td>
                      <td>{s.channel === "email" ? "이메일" : "IG DM"}</td>
                      <td className="num">{s.sent_today}</td>
                      <td className="num">{s.daily_cap}</td>
                      <td>
                        {s.status === "ok" ? (
                          <Pill tone="k-ok">정상</Pill>
                        ) : s.status === "ramping" ? (
                          <Pill tone="k-warn">램프업 D{s.ramp_day}</Pill>
                        ) : (
                          <Pill tone="k-stop">24h 정지</Pill>
                        )}
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
                <thead>
                  <tr>
                    <th>크리에이터</th>
                    <th>분류</th>
                    <th>캠페인</th>
                    <th>마지막</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.handle}>
                      <td>
                        <IgLink handle={r.handle} />
                      </td>
                      <td>{classPill(r.cls)}</td>
                      <td>{r.camp ?? "—"}</td>
                      <td className="num">{r.last_at.slice(5, 16)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          </Card>
        </div>

        <Card title="서킷브레이커" hint="지표가 임계를 넘으면 발송 워커가 스스로 멈춥니다">
          <Scroller>
            <table>
              <thead>
                <tr>
                  <th>지표</th>
                  <th>경보</th>
                  <th>조치</th>
                  <th>현재</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {circuits.map((m) => {
                  const tripped = m.stop_at != null && m.value >= m.stop_at;
                  const warned = m.key === "inbox" ? m.value < m.warn_at : m.value >= m.warn_at;
                  return (
                    <tr key={m.key}>
                      <td>{m.label}</td>
                      <td className="num">{m.warn_at}{m.unit}</td>
                      <td>{all<{ action: string }>(`SELECT action FROM circuit_metric WHERE key=?`, [m.key])[0]?.action}</td>
                      <td className="num">{m.value}{m.unit}</td>
                      <td>
                        {tripped ? <Pill tone="k-stop">중단</Pill> : warned ? <Pill tone="k-warn">경보</Pill> : <Pill tone="k-ok">정상</Pill>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Scroller>
        </Card>
      </section>
    </Shell>
  );
}

function classPill(cls: string | null) {
  if (!cls) return <Pill tone="k-mute">미분류</Pill>;
  const n = cls.split(" ")[0];
  const label = cls.slice(n.length + 1);
  const tone = n === "3" ? "k-ok" : n === "2" || n === "1" ? "k-acc" : n === "-1" ? "k-warn" : n === "-3" ? "k-vio" : "k-stop";
  return <Pill tone={tone}>{label}</Pill>;
}
