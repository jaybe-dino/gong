import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Empty, FitBar, IgLink, Note, Pill, Scroller, SrcDots } from "@/components/ui";
import CreatorDrawer from "./CreatorDrawer";
import { all, one } from "@/lib/db";
import { today } from "@/lib/clock";
import { defaultCampaign, ensureFitCache } from "@/lib/fit-cache";
import { fmt, fol } from "@/lib/format";

export const dynamic = "force-dynamic";

const CATS = ["전체", "리빙", "육아/키즈", "식품", "뷰티", "패션", "인테리어", "건강", "여행/숙소", "반려동물"];
const PAGE = 25;

interface Row {
  id: number;
  display_name: string;
  handle: string;
  primary_category: string | null;
  followers: number | null;
  deals_30d: number | null;
  cadence: number | null;
  last_days: number | null;
  score: number;
  excluded: number;
  exclude_reason: string | null;
  reach: string | null;
  sources: string;
  stage: string | null;
}

export default async function InfluencersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; cat?: string; sort?: string; reach?: string; page?: string; open?: string; campaign?: string }>;
}) {
  const sp = await searchParams;
  const ref = today();
  const campaign = defaultCampaign(sp.campaign ? Number(sp.campaign) : undefined);
  ensureFitCache(campaign, ref);

  const q = (sp.q ?? "").trim();
  const cat = sp.cat && CATS.includes(sp.cat) ? sp.cat : "전체";
  const sort = ["fit", "timing", "followers", "deals"].includes(sp.sort ?? "") ? sp.sort! : "fit";
  const onlyReach = sp.reach === "1";
  const page = Math.max(1, Number(sp.page ?? 1) || 1);

  const where: string[] = [];
  const params: unknown[] = [campaign.id, ref];
  if (cat !== "전체") {
    where.push(`c.primary_category = ?`);
    params.push(cat);
  }
  if (q) {
    where.push(`(a.handle LIKE ? OR c.display_name LIKE ? OR EXISTS (
       SELECT 1 FROM deal d JOIN brand b ON b.id=d.brand_id
        WHERE d.account_id=a.id AND b.name LIKE ?))`);
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (onlyReach) where.push(`reach.kind IS NOT NULL AND reach.kind != 'ig_dm' AND f.excluded = 0`);

  const orderBy =
    sort === "followers" ? "snap.followers DESC" :
    sort === "deals" ? "m.deals_30d DESC" :
    sort === "timing" ? `CASE WHEN m.avg_cadence_days > 0
        THEN ABS((julianday(?) - julianday(m.last_deal_on)) / m.avg_cadence_days - 1.0) ELSE 99 END ASC` :
    "f.excluded ASC, f.score DESC";

  const base = `
    FROM creator c
    JOIN social_account a ON a.creator_id = c.id AND a.is_primary = 1
    LEFT JOIN fit_cache f ON f.campaign_id = ? AND f.creator_id = c.id AND f.computed_at = ?
    LEFT JOIN creator_metric m ON m.creator_id = c.id
    LEFT JOIN (SELECT s.account_id, s.followers FROM account_snapshot s
                 JOIN (SELECT account_id, MAX(observed_at) t FROM account_snapshot GROUP BY account_id) x
                   ON x.account_id = s.account_id AND x.t = s.observed_at) snap ON snap.account_id = a.id
    LEFT JOIN (SELECT creator_id, MIN(CASE kind WHEN 'email' THEN 0 WHEN 'inpock' THEN 1 WHEN 'linktree' THEN 2 ELSE 3 END) ord,
                      kind FROM contact_point GROUP BY creator_id) reach ON reach.creator_id = c.id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;

  const total = one<{ n: number }>(`SELECT COUNT(*) AS n ${base}`, params)!.n;
  const grand = one<{ n: number }>(`SELECT COUNT(*) AS n FROM creator`)!.n;

  const orderParams = sort === "timing" ? [ref] : [];
  const rows = all<Row>(
    `SELECT c.id, c.display_name, a.handle, c.primary_category,
            snap.followers, m.deals_30d, m.avg_cadence_days AS cadence,
            CAST(julianday(?) - julianday(m.last_deal_on) AS INTEGER) AS last_days,
            COALESCE(f.score,0) AS score, COALESCE(f.excluded,0) AS excluded, f.exclude_reason,
            reach.kind AS reach,
            (SELECT GROUP_CONCAT(DISTINCT source) FROM source_ref sr WHERE sr.entity_type='creator' AND sr.entity_id=c.id) AS sources,
            (SELECT stage FROM campaign_target ct WHERE ct.creator_id=c.id ORDER BY ct.updated_at DESC LIMIT 1) AS stage
     ${base} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [ref, ...params, ...orderParams, PAGE, (page - 1) * PAGE],
  );

  const link = (o: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    const merged = { q, cat, sort, reach: onlyReach ? "1" : undefined, page: String(page), ...o };
    for (const [k, v] of Object.entries(merged)) {
      if (v && !(k === "cat" && v === "전체") && !(k === "sort" && v === "fit") && !(k === "page" && v === "1")) u.set(k, v);
    }
    const s = u.toString();
    return `/influencers${s ? `?${s}` : ""}`;
  };

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const openId = sp.open ? Number(sp.open) : null;

  return (
    <Shell path="/influencers" title="인플루언서 DB" sub={`3개 소스 병합 · ${fmt(grand)}명`}>
      <section className="screen">
        <form className="filterbar" method="get" action="/influencers">
          <div className="search">
            <span className="mono" style={{ color: "var(--ink-3)" }}>⌕</span>
            <input name="q" defaultValue={q} placeholder="핸들 · 이름 · 브랜드 검색" aria-label="검색" />
          </div>
          {cat !== "전체" && <input type="hidden" name="cat" value={cat} />}
          {sort !== "fit" && <input type="hidden" name="sort" value={sort} />}
          {onlyReach && <input type="hidden" name="reach" value="1" />}
          <button className="btn sm" type="submit">검색</button>
          <span className="spacer" />
          <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>적합도 기준 캠페인</span>
          <b style={{ fontSize: 12 }}>{campaign.name}</b>
        </form>

        <div className="filterbar">
          {CATS.map((c) => (
            <Link key={c} className="chip" href={link({ cat: c, page: "1" })} aria-pressed={cat === c} scroll={false}>
              {c}
            </Link>
          ))}
          <span className="spacer" />
          {([["fit", "적합도순"], ["timing", "타이밍 적기순"], ["followers", "팔로워순"], ["deals", "최근 30일 딜순"]] as const).map(
            ([k, label]) => (
              <Link key={k} className="chip" href={link({ sort: k, page: "1" })} aria-pressed={sort === k} scroll={false}>
                {label}
              </Link>
            ),
          )}
          <Link className="chip" href={link({ reach: onlyReach ? undefined : "1", page: "1" })} aria-pressed={onlyReach} scroll={false}>
            연락 가능만
          </Link>
        </div>

        <Card
          title={`${fmt(grand)}명 중 ${fmt(total)}명 · ${page}/${pages} 페이지`}
          hint="행을 클릭하면 통합 프로필이 열립니다"
          right={<Link className="btn pri sm" href="/send">제안 발송으로</Link>}
        >
          {rows.length === 0 ? (
            <Empty>조건에 맞는 크리에이터가 없습니다.</Empty>
          ) : (
            <Scroller wide>
              <table>
                <thead>
                  <tr>
                    <th>크리에이터</th><th>팔로워</th><th>30일 딜</th><th>평균 간격</th><th>마지막 공구</th>
                    <th>주력</th><th>적합도</th><th>연락 경로</th><th>소스</th><th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const ratio = r.cadence && r.last_days != null ? r.last_days / r.cadence : null;
                    const ripe = ratio != null && ratio >= 0.8 && ratio <= 2.2;
                    return (
                      <tr key={r.id} className="rowlink">
                        <td>
                          <IgLink handle={r.handle}>
                            <b>@{r.handle}</b>
                          </IgLink>
                          <br />
                          <Link href={link({ open: String(r.id) })} scroll={false} style={{ fontSize: 11, color: "var(--ink-3)" }}>
                            {r.display_name} ›
                          </Link>
                        </td>
                        <td className="num">{fol(r.followers)}</td>
                        <td className="num">{r.deals_30d ?? "—"}</td>
                        <td className="num">{r.cadence ? `${Math.round(r.cadence)}일` : "—"}</td>
                        <td>
                          {r.last_days == null ? (
                            <span className="num">—</span>
                          ) : ripe ? (
                            <span className="num" style={{ color: "var(--ok)", fontWeight: 600 }}>{r.last_days}일 전 ★</span>
                          ) : (
                            <span className="num">{r.last_days}일 전</span>
                          )}
                        </td>
                        <td>{r.primary_category ?? "—"}</td>
                        <td>{r.excluded ? <Pill tone="k-stop">제외</Pill> : <FitBar score={r.score} />}</td>
                        <td>{reachPill(r.reach, r.excluded === 1)}</td>
                        <td><SrcDots sources={(r.sources ?? "").split(",").filter(Boolean)} /></td>
                        <td>{r.stage ? <StagePill stage={r.stage} /> : <Pill tone="k-mute">발굴</Pill>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Scroller>
          )}
          {pages > 1 && (
            <div className="pager">
              <Link className="btn sm" href={link({ page: String(Math.max(1, page - 1)) })} aria-disabled={page === 1} scroll={false}>
                이전
              </Link>
              <span className="mono">{page} / {pages}</span>
              <Link className="btn sm" href={link({ page: String(Math.min(pages, page + 1)) })} aria-disabled={page === pages} scroll={false}>
                다음
              </Link>
            </div>
          )}
        </Card>

        <Note>
          <b>소스 표시</b> — <span className="mono">맘</span> 맘캘린더(브랜드·검증 큐레이션) / <span className="mono">팡</span>{" "}
          공구팡팡(팔로워·가격·오픈시각) / <span className="mono">인</span> 인공(30·90일 딜 수, 평균 간격). 세 소스가 다
          붙은 레코드일수록 신뢰도가 높고, 하나만 붙은 레코드는 재검증 대상입니다.
        </Note>
      </section>

      {openId != null && <CreatorDrawer creatorId={openId} campaign={campaign} closeHref={link({ open: undefined })} />}
    </Shell>
  );
}

function reachPill(kind: string | null, excluded: boolean) {
  if (excluded) return <Pill tone="k-stop">제외</Pill>;
  if (kind === "email") return <Pill tone="k-ok">이메일</Pill>;
  if (kind === "inpock" || kind === "linktree") return <Pill tone="k-acc">인포크</Pill>;
  if (kind === "ig_dm") return <Pill tone="k-mute">DM만</Pill>;
  return <Pill tone="k-mute">미확보</Pill>;
}

function StagePill({ stage }: { stage: string }) {
  const label: Record<string, string> = {
    contacted: "컨택 발송", replied: "회신", negotiating: "협의",
    confirmed: "확정", running: "진행중", dropped: "이탈",
  };
  const tone: Record<string, string> = {
    contacted: "k-acc", replied: "k-warn", negotiating: "k-warn",
    confirmed: "k-ok", running: "k-ok", dropped: "k-stop",
  };
  return <Pill tone={tone[stage] ?? "k-mute"}>{label[stage] ?? stage}</Pill>;
}
