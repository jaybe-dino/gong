/**
 * 알림은 슬랙으로.
 *
 * 이메일 알림은 발신 도메인 평판과 무관하게 쓸 수 있는 내부 채널로 분리한다.
 * 아웃리치용 발송 도메인으로 내부 알림을 보내면 발송 통계가 오염된다.
 * SLACK_WEBHOOK_URL 이 없으면 콘솔에 찍는다.
 */

export async function post(text: string): Promise<{ ok?: boolean; dryRun?: boolean }> {
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!hook) {
    console.log("[notify]", text.replace(/\n/g, " | ").slice(0, 400));
    return { dryRun: true };
  }
  try {
    const res = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return { ok: res.ok };
  } catch (e) {
    console.error("[notify] 실패:", (e as Error).message);
    return { ok: false };
  }
}

const ICON: Record<string, string> = {
  new_deal: "🆕", brand_conflict: "⛔", new_brand: "🏷️", deal_gone: "🗑️",
  handle_change: "🔁", timing_ready: "⏰", category_surge: "📈", account_dead: "💤",
};

export async function changeDigest(events: { kind: string; title: string; detail?: string | null; severity?: string }[]) {
  if (!events.length) return { dryRun: true };
  const alerts = events.filter((e) => e.severity === "alert");
  const lines = events.slice(0, 20).map((e) => `${ICON[e.kind] ?? "•"} *${e.title}* — ${e.detail ?? e.kind}`);
  return post(`공구 변화 ${events.length}건${alerts.length ? ` (긴급 ${alerts.length})` : ""}\n${lines.join("\n")}`);
}

export const senderPaused = (identifier: string, reason: string) =>
  post(`🚨 발신 계정 정지: *${identifier}* — ${reason}. 잔여 작업을 재배정했습니다.`);

export const breakerTripped = (metric: string, value: string, action: string) =>
  post(`🚨 서킷브레이커: *${metric}* = ${value} → ${action}`);

export const replyArrived = (m: { name: string; handle: string; campaign: string; preview: string }) =>
  post(`💬 회신 도착: *${m.name || m.handle}* (${m.campaign}) — ${m.preview.slice(0, 120)}`);
