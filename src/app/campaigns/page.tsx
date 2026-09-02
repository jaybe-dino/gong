import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Empty, FitBar, IgLink, Note, Pill, Scroller } from "@/components/ui";
import { all } from "@/lib/db";
import { addTarget, moveStage } from "@/lib/actions";
import { defaultCampaign, getCampaign, listCampaigns, loadCreators } from "@/lib/queries";
import { fmt, fol, STAGE_TONE } from "@/lib/format";
import { ENGINE_LABEL } from "@/lib/states";

export const dynamic = "force-dynamic";

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; err?: string }>;
}) {
  const sp = await searchParams;
  const campaign = sp.id ? await getCampaign(sp.id) : await defaultCampaign();

  const [campaigns, stages, members, stageDefs] = await Promise.all([
    listCampaigns(),
    all<{ key: string; label: string; n: string; sort_order: number; is_terminal: boolean }>(
      `SELECT ps.key, ps.label, ps.sort_order, ps.is_terminal, count(m.id) AS n
         FROM pipeline_stage ps
         LEFT JOIN campaign_member m ON m.stage_id=ps.id AND m.campaign_id=$1
        WHERE ps.is_enabled GROUP BY ps.key, ps.label, ps.sort_order, ps.is_terminal
        ORDER BY ps.sort_order`,
      [campaign?.id ?? null]),
    all<{ member_id: string; handle: string; display_name: string; stage_key: string; current_step: number; gmv: string; engine_state: number; fit_score: number | null }>(
      `SELECT m.id AS member_id, sa.handle, c.display_name, ps.key AS stage_key,
              m.current_step, m.gmv, m.engine_state, m.fit_score
         FROM campaign_member m
         JOIN creator c ON c.id=m.creator_id
         JOIN social_account sa ON sa.creator_id=c.id
         JOIN pipeline_stage ps ON ps.id=m.stage_id
        WHERE m.campaign_id=$1 ORDER BY m.created_at DESC`,
      [campaign?.id ?? null]),
    all<{ key: string; label: string }>(`SELECT key, label FROM pipeline_stage WHERE is_enabled ORDER BY sort_order`),
  ]);

  // 타깃 추천 — 아직 담지 않은 크리에이터 중 적합도 상위
  const { rows } = await loadCreators({ campaignId: campaign?.id ?? null, limit: 5000 });
  const memberIds = new Set(members.map((m) => m.handle));
  const pool = rows.filter((r) => !memberIds.has(r.handle));
  const recos = pool.filter((r) => !r.fit.excluded).sort((a, b) => b.fit.score - a.fit.score).slice(0, 6);
  const excluded = pool.filter((r) => r.fit.excluded && r.fit.reason && !r.suppressed).slice(0, 4);

  const totalGmv = members.reduce((a, m) => a + Number(m.gmv), 0);
  const stageMap = Object.fromEntries(stages.map((s) => [s.key, Number(s.n)]));

  return (
    <Shell path="/campaigns" title="캠페인" sub={`${campaign?.name ?? "—"} · GMV ${fmt(totalGmv)}원`}>
      <section className="screen">
        {sp.err === "reason_required" && (
          <Note tone="stop">
            <b>스테이지를 뒤로 옮기려면 사유가 필요합니다.</b> 자동화는 절대 크리에이터를 뒤로 옮기지 않고,
            사람이 옮길 때도 <code className="mono">audit_log</code> 에 남길 사유가 없으면 거부합니다. 이 규칙이 없으면
            늦게 도착한 웹훅 하나가 협의 중인 건을 &quot;컨택 발송&quot;으로 되돌립니다.
          </Note>
        )}

        <div className="cols c2">
          <Card title="진행 중인 캠페인" hint="행을 클릭하면 그 캠페인 기준으로 화면이 다시 계산됩니다">
            <Scroller wide>
              <table>
                <thead><tr><th>캠페인</th><th>브랜드</th><th>카테고리</th><th>기간</th><th>타깃</th><th>확정 이상</th><th>GMV</th></tr></thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} className={`rowlink${c.id === campaign?.id ? " on" : ""}`}>
                      <td><Link href={`/campaigns?id=${c.id}`} scroll={false} style={{ color: "inherit", textDecoration: "none" }}><b>{c.name}</b></Link></td>
                      <td>{c.brand_name}</td>
                      <td>{c.category}</td>
                      <td className="num">{c.sale_from?.slice(5)} ~ {c.sale_to?.slice(5)}</td>
                      <td className="num">{fmt(c.members)}</td>
                      <td className="num">{fmt(c.agreed)}</td>
                      <td className="num">{fmt(c.gmv)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          </Card>

          <Card title="타깃 추천" hint={`${campaign?.name} · 아직 담지 않은 상위 ${recos.length}명`}>
            <Scroller wide>
              <table>
                <thead><tr><th>크리에이터</th><th>적합도</th><th>추천 근거</th><th /></tr></thead>
                <tbody>
                  {recos.map((r) => (
                    <tr key={r.creator_id}>
                      <td>
                        <IgLink handle={r.handle}><b>@{r.handle}</b></IgLink><br />
                        <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{fol(r.followers)}</span>
                      </td>
                      <td><FitBar score={r.fit.score} /></td>
                      <td style={{ fontSize: 11.5 }}>
                        실적 {r.fit.breakdown.activity} · 품질 {r.fit.breakdown.quality} · 카테고리 {r.fit.breakdown.category} · 도달 {r.fit.breakdown.reach}
                        {r.timing.ready && <> · <b style={{ color: "var(--ok)" }}>{r.timing.label}</b></>}
                      </td>
                      <td>
                        <form action={addTarget}>
                          <input type="hidden" name="campaignId" value={campaign?.id ?? ""} />
                          <input type="hidden" name="creatorId" value={r.creator_id} />
                          <button className="btn sm" type="submit">담기</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                  {excluded.map((e) => (
                    <tr key={e.creator_id}>
                      <td><IgLink handle={e.handle}><b>@{e.handle}</b></IgLink></td>
                      <td><Pill tone="k-stop">제외</Pill></td>
                      <td style={{ fontSize: 11.5 }}><Pill tone="k-stop">{e.fit.reason}</Pill></td>
                      <td><button className="btn sm" disabled>제외</button></td>
                    </tr>
                  ))}
                  {recos.length === 0 && excluded.length === 0 && (
                    <tr><td colSpan={4}><Empty>추천할 대상이 없습니다.</Empty></td></tr>
                  )}
                </tbody>
              </table>
            </Scroller>
          </Card>
        </div>

        <Card
          title={`${campaign?.name} · 스테이지`}
          hint="자동화는 카드를 왼쪽으로 되돌리지 않습니다 — 되돌리려면 사유가 필요합니다"
          right={<Link className="btn sm" href={`/send?campaign=${campaign?.id ?? ""}`}>제안 발송</Link>}
        >
          <div className="card-b">
            <div className="kan" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(150px,1fr))` }}>
              {stages.map((s) => {
                const list = members.filter((m) => m.stage_key === s.key);
                return (
                  <div className="kcol" key={s.key}>
                    <h5><span>{s.label}</span><span>{fmt(stageMap[s.key] ?? 0)}</span></h5>
                    {list.slice(0, 3).map((m) => (
                      <div className="kcard" key={m.member_id}>
                        <b>@{m.handle}</b>
                        <span>
                          스텝 {m.current_step}/4 · {ENGINE_LABEL[m.engine_state] ?? m.engine_state}
                          {Number(m.gmv) ? ` · ${fmt(m.gmv)}` : ""}
                        </span>
                        <form action={moveStage} style={{ marginTop: 6 }}>
                          <input type="hidden" name="memberId" value={m.member_id} />
                          <select className="sel" name="stage" defaultValue={s.key} style={{ fontSize: 11, width: "100%" }}>
                            {stageDefs.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                          </select>
                          <input className="sel" name="reason" placeholder="뒤로 옮길 때 사유" style={{ fontSize: 11, width: "100%", marginTop: 4 }} />
                          <button className="btn sm" type="submit" style={{ marginTop: 4, width: "100%" }}>이동</button>
                        </form>
                      </div>
                    ))}
                    {list.length > 3 && <div className="kcard" style={{ textAlign: "center", color: "var(--ink-3)" }}>+{fmt(list.length - 3)}</div>}
                    {list.length === 0 && <div className="kcard" style={{ textAlign: "center", color: "var(--ink-3)" }}>—</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </Card>

        <Note>
          상태는 3축으로 분리돼 있습니다 — <b>엔진</b>(<code className="mono">engine_state</code>, 워커만 씀),{" "}
          <b>파이프라인</b>(<code className="mono">stage_id</code>, 사람이 읽는 축),{" "}
          <b>회신 의미</b>(<code className="mono">interest_status</code>). 한 컬럼에 &quot;발송됨&quot;과 &quot;협의
          중&quot;과 &quot;수신거부&quot;를 같이 넣으면 반드시 망가집니다.
        </Note>
      </section>
    </Shell>
  );
}
