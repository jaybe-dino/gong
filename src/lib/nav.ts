import { one } from "./db";

export interface NavItem {
  href: string;
  label: string;
  count?: number;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

const n = (sql: string, p: unknown[] = []) => one<{ n: number }>(sql, p)?.n ?? 0;

/** 사이드바 배지는 실제 행 수다. 하드코딩하지 않는다. */
export function navGroups(): NavGroup[] {
  return [
    {
      title: "개요",
      items: [
        { href: "/plan", label: "설계 개요" },
        { href: "/dashboard", label: "대시보드" },
      ],
    },
    {
      title: "공구 모니터링",
      items: [
        { href: "/feed", label: "공구 캘린더", count: n(`SELECT COUNT(*) AS n FROM deal WHERE gone_at IS NULL`) },
        { href: "/watch", label: "변화 감지", count: n(`SELECT COUNT(*) AS n FROM delta_event WHERE seen = 0`) },
      ],
    },
    {
      title: "데이터",
      items: [
        { href: "/influencers", label: "인플루언서 DB", count: n(`SELECT COUNT(*) AS n FROM creator`) },
        { href: "/deals", label: "딜 · 브랜드 탐색" },
        { href: "/import", label: "데이터 임포트" },
      ],
    },
    {
      title: "실행",
      items: [
        { href: "/campaigns", label: "캠페인", count: n(`SELECT COUNT(*) AS n FROM campaign WHERE status='active'`) },
        { href: "/send", label: "제안 발송" },
        { href: "/queue", label: "작업 큐", count: n(`SELECT COUNT(*) AS n FROM task WHERE status='pending'`) },
      ],
    },
    {
      title: "커뮤니케이션",
      items: [{ href: "/inbox", label: "통합 인박스", count: n(`SELECT COUNT(*) AS n FROM thread`) }],
    },
    {
      title: "설정",
      items: [{ href: "/policy", label: "채널 정책 · 발신 계정" }],
    },
  ];
}

export const PAGE_META: Record<string, [string, string]> = {
  "/plan": ["설계 개요", "메일링 · 데이터 유입 · 매칭"],
  "/dashboard": ["대시보드", ""],
  "/feed": ["공구 캘린더", "매일 갱신"],
  "/watch": ["변화 감지", "이전 스냅샷과의 델타"],
  "/influencers": ["인플루언서 DB", "3개 소스 병합"],
  "/deals": ["딜 · 브랜드 탐색", "브랜드 사전 기준"],
  "/import": ["데이터 임포트", "CSV 업로드 → 정규화 → 병합"],
  "/campaigns": ["캠페인", ""],
  "/send": ["제안 발송", ""],
  "/queue": ["작업 큐", "사람이 처리하는 큐"],
  "/inbox": ["통합 인박스", "partner@dinostudio.kr"],
  "/policy": ["채널 정책 · 발신 계정", "컴플라이언스 설정"],
};
