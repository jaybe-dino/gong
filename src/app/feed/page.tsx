import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Empty, Note, Pill } from "@/components/ui";
import { all } from "@/lib/db";
import { DOW, addDays, addMonths, dayLabel, pad2, parseD, shortD, today } from "@/lib/clock";
import { dday, dealStatus, type DealStatus } from "@/lib/deals";
import { fmt } from "@/lib/format";
import { igUrl } from "@/lib/handle";

export const dynamic = "force-dynamic";

const CATS = ["전체", "육아", "리빙", "식품", "건강", "인테리어", "가전", "뷰티", "패션", "여행", "반려동물"];
const TABS: [string, string][] = [
  ["pick", "우리가 찜한 공구"], ["all", "전체"], ["open", "오늘 오픈"],
  ["close", "오늘 마감"], ["soon", "예정"], ["past", "지난 공구"],
];

interface Row {
  id: string; title: string; category_l1: string | null;
  open_date: string | null; close_date: string | null; price_krw: number | null;
  is_always_on: boolean; is_curated: boolean;
  handle: string | null; seller: string | null; brand_name: string | null;
}

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; cat?: string; d?: string; view?: string }>;
}) {
  const sp = await searchParams;
  const ref = sp.d && /^\d{4}-\d{2}-\d{2}$/.test(sp.d) ? sp.d : today();
  const tab = TABS.some((t) => t[0] === sp.tab) ? sp.tab! : "all";
  const cat = sp.cat && CATS.includes(sp.cat) ? sp.cat : "전체";
  const view = sp.view === "cal" ? "cal" : "list";

  const rows = await all<Row>(
    `SELECT d.id, d.title, d.category_l1,
            to_char(d.open_date,'YYYY-MM-DD') AS open_date,
            to_char(d.close_date,'YYYY-MM-DD') AS close_date,
            d.price_krw, d.is_always_on, d.is_curated,
            sa.handle, c.display_name AS seller, b.name AS brand_name
       FROM deal d
       LEFT JOIN social_account sa ON sa.id = d.social_account_id
       LEFT JOIN creator c ON c.id = d.creator_id
       LEFT JOIN brand b ON b.id = d.brand_id
      WHERE d.status='active' ${cat === "전체" ? "" : "AND d.category_l1 = $1"}
      ORDER BY d.open_date NULLS LAST`,
    cat === "전체" ? [] : [cat],
  );

  const link = (o: Partial<Record<"tab" | "cat" | "d" | "view", string>>) => {
    const q = new URLSearchParams({ tab, cat, d: ref, view, ...o });
    if (q.get("cat") === "전체") q.delete("cat");
    if (q.get("tab") === "all") q.delete("tab");
    if (q.get("view") === "list") q.delete("view");
    if (q.get("d") === today()) q.delete("d");
    const s = q.toString();
    return `/feed${s ? `?${s}` : ""}`;
  };

  const asDeal = (r: Row) => ({ starts_on: r.open_date, ends_on: r.close_date, is_always_on: r.is_always_on ? 1 : 0 });
  const counts: Record<string, number> = {
    all: rows.length,
    pick: rows.filter((r) => r.is_curated).length,
    open: rows.filter((r) => r.open_date === ref).length,
    close: rows.filter((r) => r.close_date === ref).length,
    soon: rows.filter((r) => dealStatus(asDeal(r), ref) === "soon").length,
    past: rows.filter((r) => dealStatus(asDeal(r), ref) === "past").length,
  };

  const filtered = rows.filter((r) => {
    const st = dealStatus(asDeal(r), ref);
    if (tab === "pick") return r.is_curated;
    if (tab === "open") return r.open_date === ref;
    if (tab === "close") return r.close_date === ref;
    if (tab === "soon") return st === "soon";
    if (tab === "past") return st === "past";
    return true;
  });

  const GROUPS: [DealStatus, string, string][] = [
    ["live", "지금 진행 중인 공구", "선택한 날짜에 열려 있는 공구입니다"],
    ["always", "상시 공구", "마감일이 없어 캘린더·D-DAY 집계에서 분리합니다"],
    ["soon", "곧 열리는 공구", "오픈일에 셀러 계정에서 신청 링크가 열립니다"],
    ["past", "지난 공구", "브랜드 이력과 케이던스 계산에 쓰입니다"],
  ];
  const liveN = filtered.filter((r) => dealStatus(asDeal(r), ref) === "live").length;

  return (
    <Shell path="/feed" title="공구 캘린더" sub={`${dayLabel(ref)} 기준 · 딜 ${fmt(rows.length)}건`}>
      <section className="screen">
        <div className="feedtabs">
          {TABS.map(([k, label]) => (
            <Link key={k} className="ftab" href={link({ tab: k })} aria-pressed={tab === k} scroll={false}>
              {label}<span className="n">{counts[k]}</span>
            </Link>
          ))}
        </div>

        <div className="filterbar">
          <div className="datenav">
            <Link href={link({ d: view === "cal" ? addMonths(ref, -1) : addDays(ref, -1) })} aria-label="이전" scroll={false}>◀</Link>
            <span className="cur">{ref === today() ? "오늘 · " : ""}{dayLabel(ref)}</span>
            <Link href={link({ d: view === "cal" ? addMonths(ref, 1) : addDays(ref, 1) })} aria-label="다음" scroll={false}>▶</Link>
          </div>
          <Link className="btn sm" href={link({ d: today() })} scroll={false}>오늘로</Link>
          <span className="spacer" />
          <div className="vtoggle">
            <Link href={link({ view: "list" })} aria-pressed={view === "list"} scroll={false}>리스트</Link>
            <Link href={link({ view: "cal" })} aria-pressed={view === "cal"} scroll={false}>캘린더</Link>
          </div>
        </div>

        <div className="feedtabs">
          {CATS.map((c) => (
            <Link key={c} className="chip" href={link({ cat: c })} aria-pressed={cat === c} scroll={false}>{c}</Link>
          ))}
        </div>

        <Note>
          <b>모든 항목은 셀러의 인스타그램으로 바로 열립니다.</b> 원문 게시물은 우리 DB 에 저장하지 않고 링크로만
          연결합니다 — 세 소스 모두 원문 재배포를 약관으로 금지하고 있습니다.
        </Note>

        {view === "list" ? (
          filtered.length === 0 ? (
            <Card><Empty>이 조건에 맞는 공구가 없습니다.</Empty></Card>
          ) : (
            <div>
              <p className="lede" style={{ margin: "0 0 4px" }}>
                <b>{ref === today() ? "오늘" : shortD(ref)} 기준 {liveN}건이 진행 중</b>입니다.
                조건에 맞는 공구 {fmt(filtered.length)}건을 보고 있습니다.
              </p>
              {GROUPS.map(([st, title, sub]) => {
                let list = filtered.filter((r) => dealStatus(asDeal(r), ref) === st);
                if (!list.length) return null;
                list = [...list].sort((a, b) => String(a.open_date).localeCompare(String(b.open_date)));
                if (st === "past") list.reverse();
                const shown = list.slice(0, 60);
                return (
                  <div className="fsec" key={st}>
                    <h3>{title}{" "}
                      <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: "var(--ink-3)", fontWeight: 400 }}>{list.length}</span>
                    </h3>
                    <p className="sh">{sub}</p>
                    <div className="dlist">{shown.map((d) => <DealRow key={d.id} d={d} ref_={ref} />)}</div>
                    {list.length > shown.length && (
                      <p className="sh" style={{ marginTop: 8 }}>+ {fmt(list.length - shown.length)}건 더 있습니다. 날짜나 카테고리로 좁혀 보세요.</p>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <CalendarView rows={rows} ref_={ref} link={link} />
        )}
      </section>
    </Shell>
  );
}

function DealRow({ d, ref_ }: { d: Row; ref_: string }) {
  const dd = dday({ starts_on: d.open_date, ends_on: d.close_date, is_always_on: d.is_always_on ? 1 : 0 }, ref_);
  const period = d.is_always_on ? "상시 진행" : `${d.open_date} ~ ${d.close_date ? shortD(d.close_date) : "?"}`;
  const inner = (
    <>
      <span className="dthumb">{d.is_curated ? "찜" : (d.category_l1 ?? "—").slice(0, 2)}</span>
      <span className="dmain">
        <b>{d.title}</b>
        <span className="dmeta">
          <span className="sel">{d.seller ?? "셀러 미상"}{d.handle ? ` @${d.handle}` : ""}</span>
          {d.brand_name && <span>· {d.brand_name}</span>}
          <span>· {d.category_l1 ?? "미분류"}</span>
          <span className="dt">· {period}</span>
        </span>
      </span>
      <span className="dright">
        <span className={`pill ${dd.kind}`}>{dd.label}</span>
        {d.price_krw ? <span className="dprice">{fmt(d.price_krw)}<small>원</small></span> : null}
        <span className="igmark">IG</span>
      </span>
    </>
  );
  if (!d.handle) return <div className={`drow${d.is_curated ? " pick" : ""}`}>{inner}</div>;
  return (
    <a className={`drow${d.is_curated ? " pick" : ""}`} href={igUrl(d.handle)} target="_blank" rel="noopener noreferrer"
       title={`instagram.com/${d.handle} 새 탭에서 열기`}>
      {inner}
    </a>
  );
}

function CalendarView({
  rows, ref_, link,
}: {
  rows: Row[]; ref_: string;
  link: (o: Partial<Record<"tab" | "cat" | "d" | "view", string>>) => string;
}) {
  const base = parseD(ref_);
  const y = base.getFullYear();
  const m = base.getMonth();
  const start = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const t = today();

  return (
    <Card title={`${y}년 ${m + 1}월`} hint="날짜를 누르면 그날의 공구만 리스트로 봅니다"
      right={<span style={{ display: "flex", gap: 5 }}><Pill tone="k-acc">진행중</Pill><Pill tone="k-warn">오픈</Pill><Pill tone="k-mute">마감</Pill></span>}>
      <div className="card-b">
        <div className="cal">
          {DOW.map((d, i) => <div className={`dow${i === 0 ? " sun" : ""}`} key={d}>{d}</div>)}
          {Array.from({ length: start }, (_, i) => <div className="cell off" key={`off${i}`} />)}
          {Array.from({ length: days }, (_, i) => {
            const day = i + 1;
            const ds = `${y}-${pad2(m + 1)}-${pad2(day)}`;
            const on = rows.filter((r) => !r.is_always_on && r.open_date && r.close_date && r.open_date <= ds && ds <= r.close_date);
            return (
              <Link className={`cell${ds === t ? " today" : ""}`} href={link({ d: ds, view: "list" })} key={ds} scroll={false}>
                <span className={`dn${new Date(y, m, day).getDay() === 0 ? " sun" : ""}`}>{day}</span>
                {on.slice(0, 3).map((r) => (
                  <span className={`cev${r.open_date === ds ? " soon" : r.close_date! < t ? " past" : ""}`} key={r.id}>
                    {r.seller ?? "—"} · {r.title.slice(0, 10)}
                  </span>
                ))}
                {on.length > 3 && <span className="cmore">+{on.length - 3}</span>}
              </Link>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
