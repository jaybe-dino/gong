import { one } from "./db";

export interface NavItem { href: string; label: string; count?: number }
export interface NavGroup { title: string; items: NavItem[] }

const n = async (sql: string) => Number((await one<{ n: string }>(sql))?.n ?? 0);

/** 사이드바 배지는 실제 행 수다. 하드코딩하지 않는다. */
export async function navGroups(): Promise<NavGroup[]> {
  const [deals, events, creators, campaigns, tasks, threads] = await Promise.all([
    n(`SELECT count(*) AS n FROM deal WHERE status='active'`),
    n(`SELECT count(*) AS n FROM change_event WHERE NOT is_read`),
    n(`SELECT count(*) AS n FROM creator WHERE merged_into IS NULL`),
    n(`SELECT count(*) AS n FROM campaign WHERE status='running'`),
    n(`SELECT count(*) AS n FROM outreach_task WHERE state IN ('queued','claimed')`),
    n(`SELECT count(DISTINCT thread_key) AS n FROM message WHERE thread_key IS NOT NULL AND direction='in'`),
  ]);
  return [
    { title: "개요", items: [{ href: "/plan", label: "설계 개요" }, { href: "/dashboard", label: "대시보드" }] },
    { title: "공구 모니터링", items: [
      { href: "/feed", label: "공구 캘린더", count: deals },
      { href: "/watch", label: "변화 감지", count: events },
    ] },
    { title: "데이터", items: [
      { href: "/influencers", label: "인플루언서 DB", count: creators },
      { href: "/deals", label: "딜 · 브랜드 탐색" },
      { href: "/import", label: "데이터 임포트" },
    ] },
    { title: "실행", items: [
      { href: "/campaigns", label: "캠페인", count: campaigns },
      { href: "/send", label: "제안 발송" },
      { href: "/queue", label: "작업 큐", count: tasks },
    ] },
    { title: "커뮤니케이션", items: [{ href: "/inbox", label: "통합 인박스", count: threads }] },
    { title: "설정", items: [{ href: "/policy", label: "채널 정책 · 발신 계정" }] },
  ];
}
