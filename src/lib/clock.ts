/** 오늘 날짜(YYYY-MM-DD). GONG_TODAY 로 고정하면 테스트·데모를 재현할 수 있다. */
export function today(): string {
  const override = process.env.GONG_TODAY;
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  return ymd(new Date());
}

export const DOW = ["일", "월", "화", "수", "목", "금", "토"] as const;

export function pad2(n: number) {
  return (n < 10 ? "0" : "") + n;
}
export function ymd(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function parseD(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s: string, n: number) {
  const d = parseD(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
export function addMonths(s: string, n: number) {
  const d = parseD(s);
  d.setMonth(d.getMonth() + n);
  return ymd(d);
}
export function diffDays(a: string, b: string) {
  return Math.round((parseD(a).getTime() - parseD(b).getTime()) / 86400000);
}
export function dayLabel(s: string) {
  return `${s.slice(5)} (${DOW[parseD(s).getDay()]})`;
}
export function shortD(s: string) {
  return s.slice(5);
}
export function krDate(s: string) {
  const d = parseD(s);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${DOW[d.getDay()]}요일`;
}
