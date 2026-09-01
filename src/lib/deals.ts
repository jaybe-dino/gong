import { diffDays } from "./clock";

export type DealStatus = "live" | "soon" | "past" | "always";

export interface DealLike {
  starts_on: string | null;
  ends_on: string | null;
  is_always_on: number;
}

/**
 * 기준일(ref)에서 본 딜의 상태.
 * 상시 공구는 마감일이 없어 D-DAY·캘린더 집계에 넣으면 통계가 왜곡되므로 별도 상태로 뺀다.
 */
export function dealStatus(d: DealLike, ref: string): DealStatus {
  if (d.is_always_on || !d.starts_on || !d.ends_on) return "always";
  if (ref < d.starts_on) return "soon";
  if (ref > d.ends_on) return "past";
  return "live";
}

/**
 * 슬롯을 차지하는 공구인가.
 *
 * 진행중·예정만 센다. 상시 공구는 끝나지 않아 슬롯으로 세면 그 셀러가 영구히
 * 후순위로 밀린다 — 캘린더·D-DAY 집계에서 빼는 것과 같은 이유다.
 */
export function occupiesSlot(d: DealLike, ref: string): boolean {
  const st = dealStatus(d, ref);
  return st === "live" || st === "soon";
}

export interface DDay {
  kind: "k-ok" | "k-warn" | "k-stop" | "k-acc" | "k-mute";
  label: string;
}

export function dday(d: DealLike, ref: string): DDay {
  const st = dealStatus(d, ref);
  if (st === "always") return { kind: "k-mute", label: "상시" };
  if (st === "soon") return { kind: "k-warn", label: `D-${diffDays(d.starts_on!, ref)}` };
  if (st === "past") return { kind: "k-mute", label: "마감" };
  const left = diffDays(d.ends_on!, ref);
  if (left === 0) return { kind: "k-stop", label: "오늘 마감" };
  return { kind: left <= 1 ? "k-stop" : "k-acc", label: `D-${left}` };
}
