import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Empty, IgLink, Note, Pill, Scroller } from "@/components/ui";
import { all, one } from "@/lib/db";
import { today, shortD } from "@/lib/clock";
import { dday, dealStatus, type DealStatus } from "@/lib/deals";
import { defaultCampaign } from "@/lib/fit-cache";
import { brandConflict } from "@/lib/scoring";
import { loadScoringContext } from "@/lib/scoring-context";
import { fmt } from "@/lib/format";
import { igUrl } from "@/lib/handle";

export const dynamic = "force-dynamic";

interface DealRowT {
  id: number; product_name: string; category: string | null; starts_on: string | null;
  ends_on: string | null; price: number | null; is_always_on: number; picked: number;
  handle: string; seller: string; brand: string | null;
}

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string; campaign?: string }>;
}) {
  const sp = await searchParams;
  const ref = today();
  const campaign = defaultCampaign(sp.campaign ? Number(sp.campaign) : undefined);

  const brands = all<{ id: number; name: string; category: string | null; in_dictionary: number; total: number; live: number; sellers: number; last: string | null }>(
    `SELECT b.id, b.name, b.category, b.in_dictionary,
            COUNT(d.id) AS total,
            SUM(CASE WHEN d.is_always_on = 0 AND d.starts_on <= ? AND ? <= d.ends_on THEN 1 ELSE 0 END) AS live,
            COUNT(DISTINCT a.creator_id) AS sellers,
            MAX(d.starts_on) AS last
       FROM brand b
       LEFT JOIN deal d ON d.brand_id = b.id AND d.gone_at IS NULL
       LEFT JOIN social_account a ON a.id = d.account_id
      GROUP BY b.id ORDER BY total DESC`,
    [ref, ref],
  );

  const selected = sp.brand && brands.some((b) => b.name === sp.brand) ? sp.brand : brands[0]?.name;

  // 브랜드 충돌 검사 — 이 캠페인의 파이프라인에 올라 있는 셀러를 실제로 판정한다.
  const pipeline = all<{ creator_id: number; handle: string; name: string }>(
    `SELECT ct.creator_id, a.handle, c.display_name AS name
       FROM campaign_target ct
       JOIN creator c ON c.id = ct.creator_id
       JOIN social_account a ON a.creator_id = c.id AND a.is_primary = 1
      WHERE ct.campaign_id = ? ORDER BY ct.updated_at DESC LIMIT 200`,
    [campaign.id],
  );
  const ctx = loadScoringContext(ref);
  const conflicts = pipeline
    .map((p) => ({ ...p, c: brandConflict(p.creator_id, campaign, ref, ctx) }))
    .filter((x) => x.c)
    .sort((a, b) => a.c!.daysAgo - b.c!.daysAgo)
    .slice(0, 12);
  const clean = pipeline.filter((p) => !brandConflict(p.creator_id, campaign, ref, ctx)).slice(0, 3);

  const detail = selected
    ? all<DealRowT>(
        `SELECT d.id, d.product_name, d.category, d.starts_on, d.ends_on, d.price, d.is_always_on, d.picked,
                a.handle, c.display_name AS seller, b.name AS brand
           FROM deal d
           JOIN brand b ON b.id = d.brand_id
           JOIN social_account a ON a.id = d.account_id
           JOIN creator c ON c.id = a.creator_id
          WHERE b.name = ? AND d.gone_at IS NULL
          ORDER BY d.starts_on DESC`,
        [selected],
      )
    : [];

  const sellers = Array.from(new Set(detail.map((d) => d.seller)));
  const live = detail.filter((d) => dealStatus(d, ref) === "live");
  const brandRow = brands.find((b) => b.name === selected);

  const GROUPS: [DealStatus, string][] = [
    ["live", `지금 진행 중인 ${selected} 공구`],
    ["soon", `곧 열리는 ${selected} 공구`],
    ["always", `${selected} 상시 공구`],
    ["past", `지난 ${selected} 공구`],
  ];

  return (
    <Shell path="/deals" title="딜 · 브랜드 탐색" sub={`브랜드 ${fmt(brands.length)}개 · 충돌 검사 기준 ${campaign.name}`}>
      <section className="screen">
        <div className="cols c2">
          <Card title="브랜드" hint="맘캘린더 브랜드 사전을 기준 사전으로 사용">
            <Scroller wide>
              <table>
                <thead>
                  <tr><th>브랜드</th><th>카테고리</th><th>누적 딜</th><th>진행중</th><th>참여 셀러</th><th>최근</th></tr>
                </thead>
                <tbody>
                  {brands.map((b) => (
                    <tr key={b.id} className={`rowlink${b.name === selected ? " on" : ""}`}>
                      <td>
                        <Link href={`/deals?brand=${encodeURIComponent(b.name)}`} scroll={false} style={{ color: "inherit", textDecoration: "none" }}>
                          <b>{b.name}</b>{" "}
                          {b.in_dictionary === 0 && <Pill tone="k-vio">새 브랜드</Pill>}
                        </Link>
                      </td>
                      <td>{b.category ?? "—"}</td>
                      <td className="num">{fmt(b.total)}</td>
                      <td className="num">{fmt(b.live ?? 0)}</td>
                      <td className="num">{fmt(b.sellers)}</td>
                      <td className="num">{b.last ? shortD(b.last) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          </Card>

          <Card title="브랜드 충돌 검사" hint={campaign.name}>
            <div className="card-b">
              <p className="lede" style={{ marginBottom: 12 }}>
                캠페인 카테고리와 겹치는 브랜드를 최근 90일 안에 진행한 셀러는 제안 대상에서 자동 후순위로 밀립니다.
                30일 이내면 제외, 60일 이내 −15, 90일 이내 −5 입니다.
              </p>
              <Scroller>
                <table>
                  <thead><tr><th>셀러</th><th>충돌 브랜드</th><th>경과</th><th>판정</th></tr></thead>
                  <tbody>
                    {conflicts.map((x) => (
                      <tr key={x.creator_id}>
                        <td><IgLink handle={x.handle} /></td>
                        <td>{x.c!.brand}</td>
                        <td className="num">{x.c!.daysAgo}일</td>
                        <td>
                          {x.c!.verdict === "exclude" ? <Pill tone="k-stop">제외</Pill> : <Pill tone="k-warn">감점 {x.c!.points}</Pill>}
                        </td>
                      </tr>
                    ))}
                    {clean.map((x) => (
                      <tr key={`ok-${x.creator_id}`}>
                        <td><IgLink handle={x.handle} /></td>
                        <td>—</td>
                        <td>—</td>
                        <td><Pill tone="k-ok">통과</Pill></td>
                      </tr>
                    ))}
                    {conflicts.length === 0 && clean.length === 0 && (
                      <tr><td colSpan={4}><Empty>이 캠페인에 올라온 타깃이 없습니다.</Empty></td></tr>
                    )}
                  </tbody>
                </table>
              </Scroller>
            </div>
          </Card>
        </div>

        <Card
          title={selected ? `${selected} 공구` : "브랜드 상세"}
          hint="브랜드를 클릭하면 그 브랜드의 공구 이력이 열립니다"
        >
          <div className="card-b">
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 14 }}>
              딜 · 브랜드 탐색 › {selected} 공구
              {brandRow?.in_dictionary === 0 && (
                <>
                  {" "}
                  <Pill tone="k-vio">브랜드 사전에 없음 — 별칭 등록 필요</Pill>
                </>
              )}
            </div>

            {detail.length === 0 ? (
              <Empty>수집된 {selected} 공구가 없습니다.</Empty>
            ) : (
              GROUPS.map(([st, title]) => {
                let list = detail.filter((d) => dealStatus(d, ref) === st);
                if (!list.length) return null;
                list = [...list].sort((a, b) => String(a.starts_on).localeCompare(String(b.starts_on)));
                if (st === "past") list.reverse();
                return (
                  <div className="fsec" key={st}>
                    <h3>
                      {title}{" "}
                      <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: "var(--ink-3)", fontWeight: 400 }}>
                        {list.length}
                      </span>
                    </h3>
                    <div className="dlist">
                      {list.slice(0, 30).map((d) => {
                        const dd = dday(d, ref);
                        return (
                          <a
                            className={`drow${d.picked ? " pick" : ""}`}
                            key={d.id}
                            href={igUrl(d.handle)}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <span className="dthumb">{d.picked ? "찜" : (d.category ?? "—").slice(0, 2)}</span>
                            <span className="dmain">
                              <b>{d.product_name}</b>
                              <span className="dmeta">
                                <span className="sel">{d.seller} @{d.handle}</span>
                                <span>· {d.category ?? "미분류"}</span>
                                <span className="dt">· {d.is_always_on ? "상시 진행" : `${d.starts_on} ~ ${shortD(d.ends_on!)}`}</span>
                              </span>
                            </span>
                            <span className="dright">
                              <span className={`pill ${dd.kind}`}>{dd.label}</span>
                              {d.price ? <span className="dprice">{fmt(d.price)}<small>원</small></span> : null}
                              <span className="igmark">IG</span>
                            </span>
                          </a>
                        );
                      })}
                    </div>
                    {list.length > 30 && <p className="sh" style={{ marginTop: 8 }}>+ {list.length - 30}건 더 있습니다.</p>}
                  </div>
                );
              })
            )}

            <div style={{ borderTop: "1px solid var(--line)", marginTop: 18, paddingTop: 14 }}>
              <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>이 브랜드에 대해 자주 확인하는 것</h4>
              <ul className="tight">
                <li>
                  <b>{selected} 공구는 지금 진행 중인가요?</b> —{" "}
                  {live.length ? `${live.length}건 진행 중입니다 (${live.map((d) => d.seller).join(", ")}).` : "현재 진행 중인 공구는 없습니다."}
                </li>
                <li>
                  <b>어떤 셀러가 이 브랜드를 진행했나요?</b> —{" "}
                  {sellers.length ? `${sellers.slice(0, 8).join(", ")}${sellers.length > 8 ? " 외" : ""} 총 ${sellers.length}명.` : "기록이 없습니다."}
                </li>
                <li>
                  <b>우리 캠페인과 충돌하나요?</b> — 최근 90일 안에 이 브랜드를 진행한 셀러는 같은 카테고리 캠페인의 제안
                  대상에서 자동 제외됩니다. 현재 {campaign.name} 기준 <b>{conflicts.filter((c) => c.c!.verdict === "exclude").length}명</b>이
                  제외, <b>{conflicts.filter((c) => c.c!.verdict === "penalty").length}명</b>이 감점 상태입니다.
                </li>
                <li>
                  <b>가격은 어디서 확인하나요?</b> — 각 행을 누르면 셀러 인스타그램 원문으로 이동합니다. 상세 가격·옵션은
                  원문이 기준입니다.
                </li>
              </ul>
            </div>
          </div>
        </Card>

        <Note tone="warn">
          상시(always-on) 공구는 기간 공구와 집계를 분리합니다. 마감일이 없어 <b>캘린더·D-DAY 지표에 넣으면 통계가
          왜곡</b>됩니다. 스키마에서 <code className="mono">deal.is_always_on</code> 으로 구분하고,{" "}
          <code className="mono">dealStatus()</code> 가 별도 상태로 돌려줍니다.
        </Note>
      </section>
    </Shell>
  );
}
