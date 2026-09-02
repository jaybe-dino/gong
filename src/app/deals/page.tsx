import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Empty, IgLink, Note, Pill, Scroller } from "@/components/ui";
import { all } from "@/lib/db";
import { shortD, today } from "@/lib/clock";
import { dday, dealStatus, type DealStatus } from "@/lib/deals";
import { defaultCampaign, getCampaign, listCampaigns } from "@/lib/queries";
import { fmt } from "@/lib/format";
import { igUrl } from "@/lib/handle";
import { relatedCategories } from "@/lib/score";

export const dynamic = "force-dynamic";

interface DealRowT {
  id: string; title: string; category_l1: string | null;
  open_date: string | null; close_date: string | null; price_krw: number | null;
  is_always_on: boolean; is_curated: boolean;
  handle: string | null; seller: string | null;
}

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string; campaign?: string }>;
}) {
  const sp = await searchParams;
  const ref = today();
  const campaign = sp.campaign ? await getCampaign(sp.campaign) : await defaultCampaign();
  const cats = campaign ? relatedCategories(campaign.category) : [""];

  const [brands, campaigns] = await Promise.all([
    all<{ id: string; name: string; category: string | null; is_verified: boolean; total: string; live: string; sellers: string; last: string | null }>(
      `SELECT b.id, b.name, b.category, b.is_verified,
              count(d.id) AS total,
              count(*) FILTER (WHERE NOT d.is_always_on AND d.open_date <= CURRENT_DATE AND d.close_date >= CURRENT_DATE) AS live,
              count(DISTINCT d.creator_id) AS sellers,
              to_char(max(d.open_date),'YYYY-MM-DD') AS last
         FROM brand b LEFT JOIN deal d ON d.brand_id=b.id AND d.status='active'
        GROUP BY b.id ORDER BY count(d.id) DESC`),
    listCampaigns(),
  ]);

  const selected = sp.brand && brands.some((b) => b.name === sp.brand) ? sp.brand : brands[0]?.name;
  const brandRow = brands.find((b) => b.name === selected);

  // 브랜드 충돌 검사 — 이 캠페인 파이프라인에 올라 있는 셀러를 실제로 판정한다.
  const conflicts = await all<{ handle: string; display_name: string; brand_name: string | null; days_ago: number | null }>(
    `SELECT sa.handle, c.display_name, conf.brand_name, conf.days_ago::int
       FROM campaign_member m
       JOIN creator c ON c.id=m.creator_id
       JOIN social_account sa ON sa.creator_id=c.id
       LEFT JOIN LATERAL (
         SELECT b.name AS brand_name, (CURRENT_DATE - d.open_date) AS days_ago
           FROM deal d JOIN brand b ON b.id=d.brand_id
          WHERE d.creator_id=c.id AND d.status='active'
            AND d.open_date BETWEEN CURRENT_DATE - 90 AND CURRENT_DATE
            AND (b.category = ANY($2) OR b.id = $3)
          ORDER BY d.open_date DESC LIMIT 1
       ) conf ON true
      WHERE m.campaign_id=$1
      ORDER BY conf.days_ago NULLS LAST LIMIT 14`,
    [campaign?.id ?? null, cats, campaign?.brand_id ?? null],
  );

  const detail = selected
    ? await all<DealRowT>(
        `SELECT d.id, d.title, d.category_l1,
                to_char(d.open_date,'YYYY-MM-DD') AS open_date,
                to_char(d.close_date,'YYYY-MM-DD') AS close_date,
                d.price_krw, d.is_always_on, d.is_curated,
                sa.handle, c.display_name AS seller
           FROM deal d
           JOIN brand b ON b.id=d.brand_id
           LEFT JOIN social_account sa ON sa.id=d.social_account_id
           LEFT JOIN creator c ON c.id=d.creator_id
          WHERE b.name=$1 AND d.status='active'
          ORDER BY d.open_date DESC NULLS LAST`,
        [selected])
    : [];

  const asDeal = (r: DealRowT) => ({ starts_on: r.open_date, ends_on: r.close_date, is_always_on: r.is_always_on ? 1 : 0 });
  const sellers = [...new Set(detail.map((d) => d.seller).filter(Boolean))] as string[];
  const live = detail.filter((d) => dealStatus(asDeal(d), ref) === "live");
  const excluded = conflicts.filter((c) => c.days_ago != null && c.days_ago <= 30).length;
  const penalized = conflicts.filter((c) => c.days_ago != null && c.days_ago > 30).length;

  const GROUPS: [DealStatus, string][] = [
    ["live", `지금 진행 중인 ${selected} 공구`],
    ["soon", `곧 열리는 ${selected} 공구`],
    ["always", `${selected} 상시 공구`],
    ["past", `지난 ${selected} 공구`],
  ];

  return (
    <Shell path="/deals" title="딜 · 브랜드 탐색" sub={`브랜드 ${fmt(brands.length)}개 · 충돌 검사 기준 ${campaign?.name ?? "—"}`}>
      <section className="screen">
        <div className="cols c2">
          <Card title="브랜드" hint="맘캘린더 브랜드 사전을 기준 사전으로 사용">
            <Scroller wide>
              <table>
                <thead><tr><th>브랜드</th><th>카테고리</th><th>누적 딜</th><th>진행중</th><th>참여 셀러</th><th>최근</th></tr></thead>
                <tbody>
                  {brands.map((b) => (
                    <tr key={b.id} className={`rowlink${b.name === selected ? " on" : ""}`}>
                      <td>
                        <Link href={`/deals?brand=${encodeURIComponent(b.name)}${sp.campaign ? `&campaign=${sp.campaign}` : ""}`}
                              scroll={false} style={{ color: "inherit", textDecoration: "none" }}>
                          <b>{b.name}</b> {!b.is_verified && <Pill tone="k-vio">새 브랜드</Pill>}
                        </Link>
                      </td>
                      <td>{b.category ?? "—"}</td>
                      <td className="num">{fmt(b.total)}</td>
                      <td className="num">{fmt(b.live)}</td>
                      <td className="num">{fmt(b.sellers)}</td>
                      <td className="num">{b.last ? shortD(b.last) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          </Card>

          <Card
            title="브랜드 충돌 검사"
            hint={campaign?.name}
            right={
              <form method="get" action="/deals">
                {selected && <input type="hidden" name="brand" value={selected} />}
                <select className="sel" name="campaign" defaultValue={campaign?.id} aria-label="기준 캠페인">
                  {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button className="btn sm" type="submit" style={{ marginLeft: 6 }}>적용</button>
              </form>
            }
          >
            <div className="card-b">
              <p className="lede" style={{ marginBottom: 12 }}>
                캠페인 카테고리(또는 캠페인 브랜드 자신)와 겹치는 브랜드를 최근 90일 안에 진행한 셀러입니다.
                30일 이내면 제외, 60일 이내 −15, 90일 이내 −5.
              </p>
              <Scroller>
                <table>
                  <thead><tr><th>셀러</th><th>충돌 브랜드</th><th>경과</th><th>판정</th></tr></thead>
                  <tbody>
                    {conflicts.map((x) => (
                      <tr key={x.handle}>
                        <td><IgLink handle={x.handle} /></td>
                        <td>{x.brand_name ?? "—"}</td>
                        <td className="num">{x.days_ago != null ? `${x.days_ago}일` : "—"}</td>
                        <td>
                          {x.days_ago == null ? <Pill tone="k-ok">통과</Pill>
                            : x.days_ago <= 30 ? <Pill tone="k-stop">제외</Pill>
                            : x.days_ago <= 60 ? <Pill tone="k-warn">감점 −15</Pill>
                            : <Pill tone="k-warn">감점 −5</Pill>}
                        </td>
                      </tr>
                    ))}
                    {conflicts.length === 0 && <tr><td colSpan={4}><Empty>이 캠페인에 올라온 타깃이 없습니다.</Empty></td></tr>}
                  </tbody>
                </table>
              </Scroller>
            </div>
          </Card>
        </div>

        <Card title={selected ? `${selected} 공구` : "브랜드 상세"} hint="브랜드를 클릭하면 그 브랜드의 공구 이력이 열립니다">
          <div className="card-b">
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 14 }}>
              딜 · 브랜드 탐색 › {selected} 공구
              {brandRow && !brandRow.is_verified && <> <Pill tone="k-vio">브랜드 사전에 없음 — 별칭 등록 필요</Pill></>}
            </div>

            {detail.length === 0 ? <Empty>수집된 {selected} 공구가 없습니다.</Empty> : GROUPS.map(([st, title]) => {
              let list = detail.filter((d) => dealStatus(asDeal(d), ref) === st);
              if (!list.length) return null;
              list = [...list].sort((a, b) => String(a.open_date).localeCompare(String(b.open_date)));
              if (st === "past") list.reverse();
              return (
                <div className="fsec" key={st}>
                  <h3>{title}{" "}
                    <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: "var(--ink-3)", fontWeight: 400 }}>{list.length}</span>
                  </h3>
                  <div className="dlist">
                    {list.slice(0, 30).map((d) => {
                      const dd = dday(asDeal(d), ref);
                      const inner = (
                        <>
                          <span className="dthumb">{d.is_curated ? "찜" : (d.category_l1 ?? "—").slice(0, 2)}</span>
                          <span className="dmain">
                            <b>{d.title}</b>
                            <span className="dmeta">
                              <span className="sel">{d.seller ?? "셀러 미상"}{d.handle ? ` @${d.handle}` : ""}</span>
                              <span>· {d.category_l1 ?? "미분류"}</span>
                              <span className="dt">· {d.is_always_on ? "상시 진행" : `${d.open_date} ~ ${d.close_date ? shortD(d.close_date) : "?"}`}</span>
                            </span>
                          </span>
                          <span className="dright">
                            <span className={`pill ${dd.kind}`}>{dd.label}</span>
                            {d.price_krw ? <span className="dprice">{fmt(d.price_krw)}<small>원</small></span> : null}
                            <span className="igmark">IG</span>
                          </span>
                        </>
                      );
                      return d.handle ? (
                        <a className={`drow${d.is_curated ? " pick" : ""}`} key={d.id} href={igUrl(d.handle)} target="_blank" rel="noopener noreferrer">{inner}</a>
                      ) : (
                        <div className={`drow${d.is_curated ? " pick" : ""}`} key={d.id}>{inner}</div>
                      );
                    })}
                  </div>
                  {list.length > 30 && <p className="sh" style={{ marginTop: 8 }}>+ {list.length - 30}건 더 있습니다.</p>}
                </div>
              );
            })}

            <div style={{ borderTop: "1px solid var(--line)", marginTop: 18, paddingTop: 14 }}>
              <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>이 브랜드에 대해 자주 확인하는 것</h4>
              <ul className="tight">
                <li><b>{selected} 공구는 지금 진행 중인가요?</b> — {live.length ? `${live.length}건 진행 중입니다 (${live.map((d) => d.seller).join(", ")}).` : "현재 진행 중인 공구는 없습니다."}</li>
                <li><b>어떤 셀러가 이 브랜드를 진행했나요?</b> — {sellers.length ? `${sellers.slice(0, 8).join(", ")}${sellers.length > 8 ? " 외" : ""} 총 ${sellers.length}명.` : "기록이 없습니다."}</li>
                <li><b>우리 캠페인과 충돌하나요?</b> — {campaign?.name} 기준 <b>{excluded}명</b>이 제외, <b>{penalized}명</b>이 감점 상태입니다.</li>
                <li><b>가격은 어디서 확인하나요?</b> — 각 행을 누르면 셀러 인스타그램 원문으로 이동합니다. 상세 가격·옵션은 원문이 기준입니다.</li>
              </ul>
            </div>
          </div>
        </Card>

        <Note tone="warn">
          상시(always-on) 공구는 기간 공구와 집계를 분리합니다. 마감일이 없어 <b>캘린더·D-DAY 지표에 넣으면 통계가
          왜곡</b>됩니다. 스키마의 <code className="mono">always_on_has_no_close</code> 제약이 상시 공구에 마감일을
          넣는 것 자체를 막습니다.
        </Note>
      </section>
    </Shell>
  );
}
