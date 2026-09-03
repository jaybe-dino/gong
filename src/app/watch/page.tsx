import Shell from "@/components/Shell";
import { Card, Empty, IgLink, Note, Pill, Scroller } from "@/components/ui";
import { all, one } from "@/lib/db";
import { fmt } from "@/lib/format";
import { markEventsRead } from "@/lib/actions";
import { freshness, healthSummary, STALE_DAYS } from "@/lib/jobs/validate";

export const dynamic = "force-dynamic";

/** change_event.kind → 배지 */
const KIND: Record<string, [string, string]> = {
  new_deal: ["k-ok", "신규 공구"],
  brand_conflict: ["k-stop", "브랜드 충돌"],
  new_brand: ["k-vio", "새 브랜드"],
  timing_ready: ["k-ok", "적기 도달"],
  deal_gone: ["k-warn", "사라진 딜"],
  handle_change: ["k-warn", "핸들 변경"],
  price_change: ["k-mute", "가격 변경"],
  category_surge: ["k-acc", "카테고리 급증"],
  account_dead: ["k-stop", "계정 비활성"],
};

const COND: Record<string, string> = {
  new_deal: "새 공구가 열릴 때", new_seller: "새 셀러가 붙을 때",
  timing_ready: "적기 도달", surge: "일 N건 이상 급증", keyword_match: "제품명에 포함",
};
const HEALTH_LABEL: Record<string, string> = {
  ok: "정상", dormant: "휴면 추정", stale: "데이터 오래됨", unreachable: "연락 수단 없음",
  bounced: "바운스 누적", bad_email: "메일 안 받는 도메인", dead: "계정 비활성", suppressed: "수신거부",
};

const TARGET_KIND: Record<string, string> = { brand: "브랜드", seller: "셀러", keyword: "키워드", category: "카테고리" };

export default async function WatchPage() {
  const [lastBatch, newDeals, newBrands, gone, accountIssues, watch, events, unread] = await Promise.all([
    one<{ observed_at: string; source: string }>(
      `SELECT to_char(observed_at,'MM-DD HH24:MI') AS observed_at, source FROM import_batch ORDER BY observed_at DESC LIMIT 1`),
    one<{ n: string }>(`SELECT count(*) AS n FROM deal WHERE first_seen >= now() - interval '7 days'`),
    one<{ n: string }>(`SELECT count(*) AS n FROM brand WHERE NOT is_verified`),
    one<{ n: string }>(`SELECT count(*) AS n FROM deal WHERE status='gone'`),
    one<{ n: string }>(`SELECT count(*) AS n FROM change_event WHERE kind IN ('handle_change','account_dead')`),
    all<{ kind: string; target: string; condition: string; threshold: number | null; last_hit_at: string | null; notify: string }>(
      `SELECT kind, target, condition, threshold, to_char(last_hit_at,'MM-DD') AS last_hit_at, notify
         FROM watchlist WHERE is_active ORDER BY last_hit_at DESC NULLS LAST`),
    all<{ id: string; kind: string; title: string; detail: string | null; handle: string | null; severity: string; occurred_at: string; is_read: boolean }>(
      `SELECT id, kind, title, detail, handle, severity,
              to_char(occurred_at,'MM-DD HH24:MI') AS occurred_at, is_read
         FROM change_event ORDER BY occurred_at DESC, id DESC LIMIT 40`),
    one<{ n: string }>(`SELECT count(*) AS n FROM change_event WHERE NOT is_read`),
  ]);
  const [health, fresh] = await Promise.all([healthSummary(), freshness()]);
  const healthTotal = health.reduce((a, h) => a + h.n, 0);

  const counts = await one<{ sellers: string; brands: string }>(
    `SELECT count(*) FILTER (WHERE kind='seller') AS sellers, count(*) FILTER (WHERE kind='brand') AS brands FROM watchlist`,
  );

  return (
    <Shell path="/watch" title="변화 감지" sub="이전 스냅샷과의 델타">
      <section className="screen">
        <Card title="유효성 점검" hint={`크리에이터 ${fmt(healthTotal)}명 · 하루 한 번 전원 재점검`}>
          <div className="card-b">
            {healthTotal === 0 ? (
              <Empty>아직 점검하지 않았습니다. 크론이 돌면 채워집니다.</Empty>
            ) : (
              <>
                <div className="kpis">
                  {health.map((h) => (
                    <div className="kpi" key={h.state}>
                      <span className="lab">{HEALTH_LABEL[h.state] ?? h.state}</span>
                      <div className="val" style={{ color: h.severity === "alert" ? "var(--stop)" : h.severity === "warn" ? "var(--warn)" : "var(--ok)" }}>
                        {fmt(h.n)}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="lede" style={{ marginTop: 12 }}>
                  판정은 우리가 가진 데이터에서만 나옵니다. 입력이 CSV 업로드뿐이므로 계정 정지나 게시물
                  삭제는 다음 업로드 전까지 알 수 없습니다 — 그래서 &quot;데이터가 낡았다&quot;를 상태로
                  드러냅니다 (스냅샷 {STALE_DAYS}일 초과).
                </p>
              </>
            )}
          </div>
        </Card>

        <Card title="소스별 업로드 신선도" hint="업로드가 끊기면 모든 판정이 낡은 데이터 위에서 돕니다">
          {fresh.length === 0 ? <Empty>커밋된 임포트가 없습니다.</Empty> : (
            <Scroller>
              <table>
                <thead><tr><th>소스</th><th>마지막 업로드</th><th className="num">경과</th><th className="num">누적 행</th><th>상태</th></tr></thead>
                <tbody>
                  {fresh.map((f) => (
                    <tr key={f.source}>
                      <td>{f.source}</td>
                      <td className="num">{f.last_upload}</td>
                      <td className="num">{f.days_ago}일</td>
                      <td className="num">{fmt(f.rows_total)}</td>
                      <td>
                        <Pill tone={f.days_ago > STALE_DAYS ? "k-stop" : f.days_ago > 7 ? "k-warn" : "k-ok"}>
                          {f.days_ago > STALE_DAYS ? "오래됨" : f.days_ago > 7 ? "업로드 필요" : "최신"}
                        </Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          )}
        </Card>

                <div className="watchgrid">
          <div className="wcard"><span className="wl">마지막 갱신</span>
            <div className="wn" style={{ fontSize: 15 }}>{lastBatch?.observed_at ?? "—"}</div>
            <div className="ws">{lastBatch?.source ?? "업로드 없음"}</div></div>
          <div className="wcard"><span className="wl">신규 공구</span>
            <div className="wn" style={{ color: "var(--ok)" }}>{fmt(newDeals?.n)}</div><div className="ws">최근 7일</div></div>
          <div className="wcard"><span className="wl">새 브랜드</span>
            <div className="wn" style={{ color: "var(--violet)" }}>{fmt(newBrands?.n)}</div><div className="ws">브랜드 사전에 없던 이름</div></div>
          <div className="wcard"><span className="wl">사라진 딜</span>
            <div className="wn" style={{ color: "var(--warn)" }}>{fmt(gone?.n)}</div><div className="ws">원문 404 · 410 (tombstone)</div></div>
          <div className="wcard"><span className="wl">계정 이상</span>
            <div className="wn" style={{ color: "var(--stop)" }}>{fmt(accountIssues?.n)}</div><div className="ws">핸들 변경 · 비활성</div></div>
          <div className="wcard"><span className="wl">워치리스트</span>
            <div className="wn">{fmt(watch.length)}</div>
            <div className="ws">셀러 {counts?.sellers ?? 0} · 브랜드 {counts?.brands ?? 0}</div></div>
        </div>

        <div className="cols c32">
          <Card
            title="변화 피드"
            hint="임포트할 때마다 이전 스냅샷과 비교해 델타만 뽑습니다"
            right={
              Number(unread?.n ?? 0) > 0 ? (
                <form action={markEventsRead}>
                  <button className="btn sm" type="submit">{fmt(unread?.n)}건 확인 처리</button>
                </form>
              ) : undefined
            }
          >
            <div>
              {events.length === 0 && <Empty>감지된 변화가 없습니다.</Empty>}
              {events.map((e) => {
                const [tone, label] = KIND[e.kind] ?? ["k-mute", e.kind];
                return (
                  <div className="evrow" key={e.id} style={e.is_read ? { opacity: 0.55 } : undefined}>
                    <Pill tone={tone}>{label}</Pill>
                    <div>
                      <b>{e.title}</b>
                      <div className="em">{e.detail}</div>
                    </div>
                    {e.handle ? <IgLink handle={e.handle}><span className="btn sm">인스타 열기</span></IgLink> : <span className="num" style={{ fontSize: 11, color: "var(--ink-3)" }}>{e.occurred_at}</span>}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="워치리스트" hint="걸린 변화만 알림으로 나갑니다">
            <Scroller>
              <table>
                <thead><tr><th>대상</th><th>유형</th><th>알림 조건</th><th>최근</th></tr></thead>
                <tbody>
                  {watch.map((w) => (
                    <tr key={`${w.kind}:${w.target}:${w.condition}`}>
                      <td>{w.kind === "seller" ? <IgLink handle={w.target}><b>@{w.target}</b></IgLink> : <b>{w.target}</b>}</td>
                      <td>{TARGET_KIND[w.kind] ?? w.kind}</td>
                      <td>{COND[w.condition] ?? w.condition}{w.threshold ? ` (${w.threshold})` : ""}</td>
                      <td className="num">{w.last_hit_at ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
            <div className="card-b" style={{ borderTop: "1px solid var(--line)" }}>
              <Note tone="warn">
                <b>알림은 슬랙으로.</b> 아웃리치 발송 도메인으로 내부 알림을 보내면 발송 통계가 오염됩니다.
              </Note>
            </div>
          </Card>
        </div>

        <Card title="모니터링 파이프라인" hint="&quot;자동 수집&quot;이 아니라 &quot;업로드된 스냅샷 사이의 차이 감지&quot;입니다">
          <div className="card-b">
            <div className="arch">
              <div className="abox"><span className="kick">1 · 스냅샷</span><h4>업로드 시점을 기록한다</h4>
                <p>CSV 가 들어올 때마다 <code className="mono">observed_at</code> 이 찍힌 스냅샷으로 저장합니다. 덮어쓰지 않습니다.</p></div>
              <div className="abox"><span className="kick">2 · 델타</span><h4>이전 스냅샷과 비교한다</h4>
                <p>신규 딜 · 브랜드 충돌 · 새 브랜드 · 적기 도달 · 사라진 딜 · 핸들 변경 · 가격 변경 · 카테고리 급증 · 계정 비활성을 뽑습니다.</p></div>
              <div className="abox"><span className="kick">3 · 액션</span><h4>델타를 아웃리치로 연결한다</h4>
                <p>경쟁 브랜드 공구가 열리면 진행 중 캠페인 타깃에서 자동 제외하고, 워치 셀러의 공구가 끝나면 적기 알림을 띄웁니다.</p></div>
            </div>
            <div style={{ marginTop: 14 }}>
              <Note tone="stop">
                <b>자동 크롤링은 넣지 않았습니다.</b> 맘캘린더·공구팡팡·인공 모두 이용약관에서 자동화 수단을 통한
                접근과 데이터 무단 수집을 금지하고, 세 곳 다 공개 API 도 CSV 다운로드도 제공하지 않습니다. 지속
                모니터링이 필요하면 ① 각 사이트와 제휴 협의, 또는 ② 원천인 인스타그램 공개 게시물 직접 수집으로
                전환하는 두 경로를 권합니다.
              </Note>
            </div>
          </div>
        </Card>
      </section>
    </Shell>
  );
}
