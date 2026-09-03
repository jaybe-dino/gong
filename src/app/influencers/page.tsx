import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Empty, FitBar, IgLink, Note, Pill, Scroller } from "@/components/ui";
import CreatorDrawer from "./CreatorDrawer";
import FitRefresh from "./FitRefresh";
import { loadCreators, listCampaigns, type ScoredCreator } from "@/lib/queries";
import { fmt, fol, STAGE_TONE } from "@/lib/format";

export const dynamic = "force-dynamic";

const CATS = ["전체", "리빙", "육아", "식품", "뷰티", "패션", "인테리어", "건강", "여행", "반려동물", "가전"];
const PAGE = 25;
const SORTS: [string, string][] = [
  ["fit", "적합도순"], ["timing", "타이밍 적기순"], ["followers", "팔로워순"], ["deals", "최근 30일 딜순"],
];

export default async function InfluencersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; cat?: string; sort?: string; reach?: string; page?: string; open?: string; campaign?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const cat = sp.cat && CATS.includes(sp.cat) ? sp.cat : "전체";
  const sort = SORTS.some(([k]) => k === sp.sort) ? sp.sort! : "fit";
  const onlyReach = sp.reach === "1";
  const page = Math.max(1, Number(sp.page ?? 1) || 1);

  // 정렬·자르기를 DB 가 한다.
  //
  // 전에는 limit 5000 으로 받아 메모리에서 줄 세웠다. 시드 1,742명일 때는 전원이
  // 들어왔지만 1.9만 건을 임포트하면 팔로워 상위 5,000명만 들어온다 — 팔로워는
  // 낮아도 적합도가 높은 크리에이터가 목록에서 사라진다. 적합도 순위가 이 제품의
  // 핵심인데 그 순위가 팔로워로 먼저 걸러지고 있었다.
  const { rows: shown, total, campaign, unscored } = await loadCreators({
    campaignId: sp.campaign ?? null,
    category: cat === "전체" ? null : cat,
    search: q || null,
    reachable: onlyReach,
    order: sort as "fit" | "followers" | "deals" | "timing",
    limit: PAGE,
    offset: (page - 1) * PAGE,
  });
  const campaigns = await listCampaigns();

  const pages = Math.max(1, Math.ceil(total / PAGE));

  const link = (o: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      q: q || undefined, cat, sort, reach: onlyReach ? "1" : undefined,
      page: String(page), campaign: sp.campaign, ...o,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v && !(k === "cat" && v === "전체") && !(k === "sort" && v === "fit") && !(k === "page" && v === "1")) u.set(k, v);
    }
    const s = u.toString();
    return `/influencers${s ? `?${s}` : ""}`;
  };

  return (
    <Shell path="/influencers" title="인플루언서 DB" sub={`3개 소스 병합 · ${fmt(total)}명`}>
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
          <select className="sel" name="campaign" defaultValue={campaign?.id} aria-label="기준 캠페인">
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="btn sm" type="submit">적용</button>
        </form>

        <div className="filterbar">
          {CATS.map((c) => (
            <Link key={c} className="chip" href={link({ cat: c, page: "1" })} aria-pressed={cat === c} scroll={false}>{c}</Link>
          ))}
          <span className="spacer" />
          {SORTS.map(([k, label]) => (
            <Link key={k} className="chip" href={link({ sort: k, page: "1" })} aria-pressed={sort === k} scroll={false}>{label}</Link>
          ))}
          <Link className="chip" href={link({ reach: onlyReach ? undefined : "1", page: "1" })} aria-pressed={onlyReach} scroll={false}>
            연락 가능만
          </Link>
        </div>

        {unscored > 0 && (
          <FitRefresh campaignId={campaign?.id ?? ""} unscored={unscored} campaignName={campaign?.name ?? ""} />
        )}

        <Card
          title={`${fmt(total)}명 · ${page}/${pages} 페이지`}
          hint="이름을 클릭하면 통합 프로필이 열립니다"
          right={<Link className="btn pri sm" href={`/send?campaign=${campaign?.id ?? ""}`}>제안 발송으로</Link>}
        >
          {shown.length === 0 ? (
            <Empty>조건에 맞는 크리에이터가 없습니다.</Empty>
          ) : (
            <Scroller wide>
              <table>
                <thead>
                  <tr>
                    <th>크리에이터</th><th>등급</th><th>팔로워</th><th>30일 딜</th><th>평균 간격</th>
                    <th>마지막 공구</th><th>적합도</th><th>연락 채널</th><th>상태</th><th>스테이지</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => <Row key={r.creator_id} r={r} href={link({ open: r.creator_id })} />)}
                </tbody>
              </table>
            </Scroller>
          )}
          {pages > 1 && (
            <div className="pager">
              <Link className="btn sm" href={link({ page: String(Math.max(1, page - 1)) })} aria-disabled={page === 1} scroll={false}>이전</Link>
              <span className="mono">{page} / {pages}</span>
              <Link className="btn sm" href={link({ page: String(Math.min(pages, page + 1)) })} aria-disabled={page === pages} scroll={false}>다음</Link>
            </div>
          )}
        </Card>

        <Note>
          <b>팔로워 수는 점수 축이 아니라 분류 축입니다.</b> 적합도 100점은 공구 실적 40 · 참여 품질 25 ·
          카테고리 적합 20 · 도달 가능성 15 로 나뉘고, 경쟁 브랜드를 30일 이내에 진행한 셀러는 점수와 무관하게
          제외됩니다. 행을 열면 그 사람에 대해 각 축이 실제로 몇 점을 줬는지 보입니다.
        </Note>
      </section>

      {sp.open && <CreatorDrawer creatorId={sp.open} campaignId={campaign?.id ?? null} closeHref={link({ open: undefined })} />}
    </Shell>
  );
}

function Row({ r, href }: { r: ScoredCreator; href: string }) {
  const cad = r.avg_interval_days == null ? null : Math.round(Number(r.avg_interval_days));
  const isShop = r.platform !== "instagram";
  return (
    <tr className="rowlink">
      <td>
        {/* blogpay 샵은 인스타 계정이 없다. 인스타 링크를 걸면 404 로 보낸다. */}
        {isShop ? (
          <span className="mono" style={{ fontWeight: 600 }}>{r.handle.replace(/^shop:/, "")}</span>
        ) : (
          <IgLink handle={r.handle}><b>@{r.handle}</b></IgLink>
        )}
        <br />
        <Link href={href} scroll={false} style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {r.display_name} ›
        </Link>
        {isShop && <> <Pill tone="k-mute">샵</Pill></>}
        {r.biz_no && <> <span style={{ fontSize: 10, color: "var(--ink-3)" }} title="사업자등록번호 보유">사업자</span></>}
      </td>
      <td>
        {r.outreach_tier ? <Pill tone={TIER_TONE[r.outreach_tier] ?? "k-mute"}>{r.outreach_tier}</Pill> : <span className="num">—</span>}
        {/* 접두사를 떼면 "없음" 만 남아 옆의 채널 배지와 모순돼 보인다. 그들 표기 그대로 둔다. */}
        {r.contact_grade && (
          <><br /><span style={{ fontSize: 10, color: "var(--ink-3)" }} title="연락등급 (원본 데이터)">{r.contact_grade}</span></>
        )}
      </td>
      <td className="num">{fol(r.followers)}</td>
      <td className="num">{r.deals_30d ?? "—"}</td>
      <td className="num">{cad ? `${cad}일` : "—"}</td>
      <td>
        {r.days_since_last == null ? <span className="num">—</span>
          : r.timing.ready
            ? <span className="num" style={{ color: "var(--ok)", fontWeight: 600 }}>{r.days_since_last}일 전 ★</span>
            : <span className="num">{r.days_since_last}일 전</span>}
      </td>
      <td>{r.fit.excluded ? <Pill tone="k-stop">제외</Pill> : <FitBar score={r.fit.score} />}</td>
      <td>{channelPills(r)}</td>
      <td>{healthPill(r.health_state, r.health_severity)}</td>
      <td>{r.stage_key ? <Pill tone={STAGE_TONE[r.stage_key] ?? "k-mute"}>{r.stage_label}</Pill> : <Pill tone="k-mute">발굴</Pill>}</td>
    </tr>
  );
}

/** 아웃리치 티어 A~F. A 가 가장 먼저 접촉할 대상이다. */
const TIER_TONE: Record<string, string> = { A: "k-ok", B: "k-acc", C: "k-acc", D: "k-warn", E: "k-vio", F: "k-mute" };

const CH_LABEL: Record<string, [string, string]> = {
  email: ["k-ok", "이메일"],
  inpock_offer: ["k-acc", "인포크"],
  inlink_form: ["k-acc", "인링크"],
  linktree_form: ["k-acc", "링크폼"],
  kakao: ["k-warn", "카카오"],
  phone: ["k-warn", "전화"],
  instagram_dm: ["k-mute", "DM"],
  sms: ["k-warn", "문자"],
};

/**
 * 보유한 연락 채널 전부를 보여준다.
 *
 * 예전에는 최선 채널 하나만 배지로 찍었다. 실제 데이터에는 이메일과 인링크를 같이
 * 가진 사람이 많은데, 하나만 보이면 이메일이 막혔을 때 대안이 있는지 알 수 없다.
 */
function channelPills(r: ScoredCreator) {
  const chs = (r.channels ?? []).filter((c) => CH_LABEL[c]);
  if (!chs.length) {
    // 연락처가 없어도 DM 딥링크가 있으면 사람이 한 번 눌러 열 수 있다.
    return r.dm_url ? <Pill tone="k-mute">DM 링크</Pill> : <Pill tone="k-stop">미확보</Pill>;
  }
  return (
    <span style={{ display: "inline-flex", gap: 3, flexWrap: "wrap" }}>
      {chs.map((c) => {
        const [tone, label] = CH_LABEL[c];
        const verified = c === "email" && r.email_verified;
        return <Pill key={c} tone={tone}>{verified ? `${label}✓` : label}</Pill>;
      })}
    </span>
  );
}

const HEALTH: Record<string, [string, string]> = {
  ok: ["k-ok", "정상"],
  dormant: ["k-warn", "휴면"],
  stale: ["k-warn", "데이터 낡음"],
  unreachable: ["k-stop", "연락 불가"],
  bad_email: ["k-stop", "메일 반송"],
  bounced: ["k-stop", "바운스"],
  dead: ["k-stop", "계정 비활성"],
  suppressed: ["k-stop", "수신거부"],
};

function healthPill(state: string | null, severity: string | null) {
  if (!state) return <span style={{ fontSize: 11, color: "var(--ink-3)" }}>미점검</span>;
  const [tone, label] = HEALTH[state] ?? ["k-mute", state];
  return <Pill tone={severity === "alert" ? "k-stop" : tone}>{label}</Pill>;
}

