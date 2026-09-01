import Shell from "@/components/Shell";
import { Card, IgLink, Note, Pill, Scroller } from "@/components/ui";
import { all, one } from "@/lib/db";
import { addDays, today } from "@/lib/clock";
import { fmt } from "@/lib/format";

export const dynamic = "force-dynamic";

const TONE: Record<string, [string, string]> = {
  new: ["k-ok", "신규"],
  conflict: ["k-stop", "충돌"],
  brand: ["k-vio", "새 브랜드"],
  timing: ["k-ok", "타이밍"],
  gone: ["k-warn", "소멸"],
  handle: ["k-warn", "계정"],
  price: ["k-mute", "변경"],
  surge: ["k-acc", "트렌드"],
  dead: ["k-stop", "비활성"],
};

export default function WatchPage() {
  const ref = today();
  const week = addDays(ref, -7);

  const lastImport = one<{ created_at: string }>(`SELECT created_at FROM import_batch ORDER BY created_at DESC LIMIT 1`);
  const newDeals = one<{ n: number }>(`SELECT COUNT(*) AS n FROM deal WHERE first_seen_at >= ?`, [week])!.n;
  const newBrands = one<{ n: number }>(`SELECT COUNT(*) AS n FROM brand WHERE in_dictionary = 0`)!.n;
  const goneDeals = one<{ n: number }>(`SELECT COUNT(*) AS n FROM deal WHERE gone_at IS NOT NULL`)!.n;
  const accountIssues = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM delta_event WHERE kind IN ('handle','dead')`,
  )!.n;
  const watchCount = one<{ n: number; sellers: number; brands: number }>(
    `SELECT COUNT(*) AS n,
            SUM(target_type='seller') AS sellers,
            SUM(target_type='brand')  AS brands FROM watchlist`,
  )!;

  const events = all<{ id: number; kind: string; title: string; subject: string; detail: string; handle: string | null; created_at: string }>(
    `SELECT id, kind, title, subject, detail, handle, created_at FROM delta_event ORDER BY created_at DESC, id`,
  );
  const watch = all<{ target_type: string; target: string; condition: string; last_hit_at: string | null }>(
    `SELECT target_type, target, condition, last_hit_at FROM watchlist ORDER BY last_hit_at DESC`,
  );

  const typeLabel: Record<string, string> = { brand: "브랜드", seller: "셀러", keyword: "키워드", category: "카테고리" };

  return (
    <Shell path="/watch" title="변화 감지" sub="이전 스냅샷과의 델타">
      <section className="screen">
        <div className="watchgrid">
          <div className="wcard">
            <span className="wl">마지막 갱신</span>
            <div className="wn" style={{ fontSize: 15 }}>{lastImport?.created_at.slice(5, 16) ?? "—"}</div>
            <div className="ws">스냅샷 업로드 시각</div>
          </div>
          <div className="wcard">
            <span className="wl">신규 공구</span>
            <div className="wn" style={{ color: "var(--ok)" }}>{fmt(newDeals)}</div>
            <div className="ws">최근 7일</div>
          </div>
          <div className="wcard">
            <span className="wl">새 브랜드</span>
            <div className="wn" style={{ color: "var(--violet)" }}>{fmt(newBrands)}</div>
            <div className="ws">브랜드 사전에 없던 이름</div>
          </div>
          <div className="wcard">
            <span className="wl">사라진 딜</span>
            <div className="wn" style={{ color: "var(--warn)" }}>{fmt(goneDeals)}</div>
            <div className="ws">원문 404 · 410 (tombstone)</div>
          </div>
          <div className="wcard">
            <span className="wl">계정 이상</span>
            <div className="wn" style={{ color: "var(--stop)" }}>{fmt(accountIssues)}</div>
            <div className="ws">핸들 변경 · 비활성</div>
          </div>
          <div className="wcard">
            <span className="wl">워치리스트</span>
            <div className="wn">{fmt(watchCount.n)}</div>
            <div className="ws">셀러 {watchCount.sellers ?? 0} · 브랜드 {watchCount.brands ?? 0}</div>
          </div>
        </div>

        <div className="cols c32">
          <Card title="변화 피드" hint="임포트할 때마다 이전 스냅샷과 비교해 델타만 뽑습니다">
            <div>
              {events.map((e) => {
                const [tone, label] = TONE[e.kind] ?? ["k-mute", e.kind];
                return (
                  <div className="evrow" key={e.id}>
                    <Pill tone={tone}>{label}</Pill>
                    <div>
                      <b>{e.subject}</b>
                      <div className="em">
                        {e.title} — {e.detail}
                      </div>
                    </div>
                    {e.handle ? (
                      <IgLink handle={e.handle}>
                        <span className="btn sm">인스타 열기</span>
                      </IgLink>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="워치리스트" hint="걸린 변화만 알림으로 나갑니다">
            <Scroller>
              <table>
                <thead>
                  <tr>
                    <th>대상</th>
                    <th>유형</th>
                    <th>알림 조건</th>
                    <th>최근</th>
                  </tr>
                </thead>
                <tbody>
                  {watch.map((w) => (
                    <tr key={`${w.target_type}:${w.target}`}>
                      <td>
                        {w.target_type === "seller" ? (
                          <IgLink handle={w.target.replace(/^@/, "")}>
                            <b>{w.target}</b>
                          </IgLink>
                        ) : (
                          <b>{w.target}</b>
                        )}
                      </td>
                      <td>{typeLabel[w.target_type]}</td>
                      <td>{w.condition}</td>
                      <td className="num">{w.last_hit_at?.slice(5) ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
            <div className="card-b" style={{ borderTop: "1px solid var(--line)" }}>
              <Note tone="warn">
                <b>알림은 슬랙으로.</b> 워치리스트에 걸린 변화는 담당자 슬랙 채널로 보냅니다. 이메일 알림은 발신 도메인
                평판과 무관하게 쓸 수 있는 내부 채널로 분리합니다.
              </Note>
            </div>
          </Card>
        </div>

        <Card title="모니터링 파이프라인" hint="&quot;자동 수집&quot;이 아니라 &quot;업로드된 스냅샷 사이의 차이 감지&quot;입니다">
          <div className="card-b">
            <div className="arch">
              <div className="abox">
                <span className="kick">1 · 스냅샷</span>
                <h4>업로드 시점을 기록한다</h4>
                <p>
                  CSV 가 들어올 때마다 <code className="mono">observed_at</code> 이 찍힌 스냅샷으로 저장합니다.
                  덮어쓰지 않습니다.
                </p>
              </div>
              <div className="abox">
                <span className="kick">2 · 델타</span>
                <h4>이전 스냅샷과 비교한다</h4>
                <p>신규 딜, 기간 변경, 가격 변경, 사라진 딜, 핸들 변경, 새 브랜드 6종을 뽑습니다.</p>
              </div>
              <div className="abox">
                <span className="kick">3 · 액션</span>
                <h4>델타를 아웃리치로 연결한다</h4>
                <p>
                  경쟁 브랜드 공구가 열리면 해당 셀러를 제안 대상에서 자동 제외하고, 워치 셀러의 공구가 끝나면 적기
                  알림을 띄웁니다.
                </p>
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <Note tone="stop">
                <b>자동 크롤링은 넣지 않았습니다.</b> 맘캘린더·공구팡팡·인공 모두 이용약관에서 자동화 수단을 통한 접근과
                데이터 무단 수집을 금지합니다(공구팡팡 제10조, 인공 제7·11조). 세 곳 다 공개 API 도 CSV 다운로드도
                제공하지 않습니다. 지속 모니터링이 꼭 필요하면 ① 각 사이트와 제휴 협의, 또는 ② 원천인 인스타그램 공개
                게시물 직접 수집으로 전환하는 두 경로를 권합니다.
              </Note>
            </div>
          </div>
        </Card>
      </section>
    </Shell>
  );
}
