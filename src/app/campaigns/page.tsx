import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Empty, FitBar, IgLink, Note, Pill, Scroller } from "@/components/ui";
import { all, one } from "@/lib/db";
import { addTarget, moveStage } from "@/lib/actions";
import { defaultCampaign, ensureFitCache } from "@/lib/fit-cache";
import { fmt, fol, STAGE_LABEL, STAGE_ORDER, STAGE_TONE } from "@/lib/format";
import { today } from "@/lib/clock";
import type { ScoreReason } from "@/lib/scoring";

export const dynamic = "force-dynamic";

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const sp = await searchParams;
  const ref = today();
  const campaign = defaultCampaign(sp.id ? Number(sp.id) : undefined);
  ensureFitCache(campaign, ref);

  const campaigns = all<{ id: number; name: string; brand: string | null; starts_on: string; ends_on: string; targets: number; confirmed: number; gmv: number }>(
    `SELECT c.id, c.name, b.name AS brand, c.starts_on, c.ends_on,
            COUNT(t.id) AS targets,
            SUM(CASE WHEN t.stage IN ('confirmed','running') THEN 1 ELSE 0 END) AS confirmed,
            COALESCE(SUM(t.gmv),0) AS gmv
       FROM campaign c
       LEFT JOIN brand b ON b.id = c.brand_id
       LEFT JOIN campaign_target t ON t.campaign_id = c.id
      GROUP BY c.id ORDER BY c.starts_on`,
  );

  // 타깃 추천 — 아직 담지 않은 크리에이터 중 적합도 상위
  const recos = all<{ creator_id: number; handle: string; name: string; followers: number | null; score: number; reasons: string }>(
    `SELECT f.creator_id, a.handle, c.display_name AS name,
            (SELECT followers FROM account_snapshot s WHERE s.account_id=a.id ORDER BY s.observed_at DESC LIMIT 1) AS followers,
            f.score, f.reasons
       FROM fit_cache f
       JOIN creator c ON c.id = f.creator_id
       JOIN social_account a ON a.creator_id = c.id AND a.is_primary=1
      WHERE f.campaign_id = ? AND f.excluded = 0
        AND NOT EXISTS (SELECT 1 FROM campaign_target t WHERE t.campaign_id=f.campaign_id AND t.creator_id=f.creator_id)
      ORDER BY f.score DESC LIMIT 6`,
    [campaign.id],
  );

  const excluded = all<{ handle: string; exclude_reason: string | null }>(
    `SELECT a.handle, f.exclude_reason
       FROM fit_cache f JOIN social_account a ON a.creator_id=f.creator_id AND a.is_primary=1
      WHERE f.campaign_id=? AND f.excluded=1 AND f.exclude_reason IS NOT NULL
      ORDER BY f.creator_id LIMIT 4`,
    [campaign.id],
  );

  const stageRows = all<{ stage: string; n: number }>(
    `SELECT stage, COUNT(*) AS n FROM campaign_target WHERE campaign_id=? GROUP BY stage`,
    [campaign.id],
  );
  const stageMap = Object.fromEntries(stageRows.map((s) => [s.stage, s.n])) as Record<string, number>;

  const cards = all<{ creator_id: number; handle: string; stage: string; step: number; gmv: number; updated_at: string }>(
    `SELECT t.creator_id, a.handle, t.stage, t.step, t.gmv, t.updated_at
       FROM campaign_target t JOIN social_account a ON a.creator_id=t.creator_id AND a.is_primary=1
      WHERE t.campaign_id=? ORDER BY t.updated_at DESC`,
    [campaign.id],
  );

  const totalGmv = one<{ g: number }>(`SELECT COALESCE(SUM(gmv),0) AS g FROM campaign_target WHERE campaign_id=?`, [campaign.id])!.g;

  return (
    <Shell path="/campaigns" title="캠페인" sub={`${campaign.name} · GMV ${fmt(totalGmv)}원`}>
      <section className="screen">
        <div className="cols c2">
          <Card title="진행 중인 캠페인" hint="행을 클릭하면 그 캠페인 기준으로 화면이 다시 계산됩니다">
            <Scroller wide>
              <table>
                <thead>
                  <tr><th>캠페인</th><th>브랜드</th><th>기간</th><th>타깃</th><th>확정</th><th>GMV</th></tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} className={`rowlink${c.id === campaign.id ? " on" : ""}`}>
                      <td>
                        <Link href={`/campaigns?id=${c.id}`} scroll={false} style={{ color: "inherit", textDecoration: "none" }}>
                          <b>{c.name}</b>
                        </Link>
                      </td>
                      <td>{c.brand ?? "—"}</td>
                      <td className="num">{c.starts_on.slice(5)} ~ {c.ends_on.slice(5)}</td>
                      <td className="num">{fmt(c.targets)}</td>
                      <td className="num">{fmt(c.confirmed ?? 0)}</td>
                      <td className="num">{fmt(c.gmv)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          </Card>

          <Card title="타깃 추천" hint={`${campaign.name} · 아직 담지 않은 상위 ${recos.length}명`}>
            <Scroller wide>
              <table>
                <thead><tr><th>크리에이터</th><th>적합도</th><th>추천 근거</th><th /></tr></thead>
                <tbody>
                  {recos.map((r) => {
                    const reasons = JSON.parse(r.reasons) as ScoreReason[];
                    const top = reasons.filter((x) => x.points !== 0).slice(0, 3);
                    return (
                      <tr key={r.creator_id}>
                        <td>
                          <IgLink handle={r.handle}><b>@{r.handle}</b></IgLink>
                          <br />
                          <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{fol(r.followers)}</span>
                        </td>
                        <td><FitBar score={r.score} /></td>
                        <td style={{ fontSize: 11.5 }}>
                          {top.map((t) => `${t.detail}`).join(" · ")}
                        </td>
                        <td>
                          <form action={addTarget}>
                            <input type="hidden" name="campaignId" value={campaign.id} />
                            <input type="hidden" name="creatorId" value={r.creator_id} />
                            <button className="btn sm" type="submit">담기</button>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                  {excluded.map((e) => (
                    <tr key={e.handle}>
                      <td><IgLink handle={e.handle}><b>@{e.handle}</b></IgLink></td>
                      <td><Pill tone="k-stop">제외</Pill></td>
                      <td style={{ fontSize: 11.5 }}>
                        <Pill tone="k-stop">{e.exclude_reason}</Pill>
                      </td>
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
          title={`${campaign.name} · 스테이지`}
          hint="자동화는 카드를 왼쪽으로 되돌리지 않습니다 — 되돌리는 건 사람만 할 수 있습니다"
          right={<Link className="btn sm" href={`/send?campaign=${campaign.id}`}>제안 발송</Link>}
        >
          <div className="card-b">
            <div className="kan">
              {STAGE_ORDER.map((stage) => {
                const list = cards.filter((c) => c.stage === stage);
                return (
                  <div className="kcol" key={stage}>
                    <h5>
                      <span>{STAGE_LABEL[stage]}</span>
                      <span>{fmt(stageMap[stage] ?? 0)}</span>
                    </h5>
                    {list.slice(0, 3).map((c) => (
                      <div className="kcard" key={c.creator_id}>
                        <b>@{c.handle}</b>
                        <span>
                          스텝 {c.step}/4{c.gmv ? ` · GMV ${fmt(c.gmv)}` : ""}
                        </span>
                        <form action={moveStage} style={{ marginTop: 6 }}>
                          <input type="hidden" name="campaignId" value={campaign.id} />
                          <input type="hidden" name="creatorId" value={c.creator_id} />
                          <select className="sel" name="stage" defaultValue={stage} style={{ fontSize: 11, width: "100%" }}>
                            {STAGE_ORDER.map((s) => (
                              <option key={s} value={s}>{STAGE_LABEL[s]}</option>
                            ))}
                          </select>
                          <button className="btn sm" type="submit" style={{ marginTop: 4, width: "100%" }}>이동</button>
                        </form>
                      </div>
                    ))}
                    {list.length > 3 && (
                      <div className="kcard" style={{ textAlign: "center", color: "var(--ink-3)" }}>
                        +{fmt(list.length - 3)}
                      </div>
                    )}
                    {list.length === 0 && (
                      <div className="kcard" style={{ textAlign: "center", color: "var(--ink-3)" }}>—</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </Card>

        <Note>
          스테이지 이동은 <code className="mono">campaign_target.stage</code> 를 직접 바꿉니다. 회신 분류(인박스)도 같은
          컬럼을 움직입니다 — <b>3 일정 확정</b>은 확정으로, <b>2 조건 문의</b>는 협의로, <b>-4 연락 금지</b>는 이탈로
          보내고 동시에 수신거부 목록에 등록합니다.
        </Note>
      </section>
    </Shell>
  );
}
