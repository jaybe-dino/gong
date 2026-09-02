import { NextResponse } from "next/server";
import { tick as sequenceTick } from "@/lib/jobs/sequence-worker";
import { tick as inboundTick } from "@/lib/jobs/inbound-sync";
import { tick as breakerTick, rampUp, resetDaily } from "@/lib/jobs/circuit-breaker";
import { refreshFit } from "@/lib/jobs/refresh-fit";
import { defaultCampaign } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 워커 한 틱. Vercel Cron 이 호출한다 (vercel.json 의 crons).
 *
 * 서버리스에는 상주 프로세스가 없어서 `npm run worker` 루프를 띄울 수 없다.
 * 대신 크론이 이 엔드포인트를 주기적으로 때린다.
 *
 * Vercel Cron 은 요청에 CRON_SECRET 을 Authorization 헤더로 실어 보낸다.
 * 설정돼 있으면 반드시 검사한다 — 아무나 발송을 트리거할 수 있으면 안 된다.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const out: Record<string, unknown> = {};

  for (const [name, fn] of [
    ["resetDaily", resetDaily],
    ["rampUp", rampUp],
    ["breaker", breakerTick],
    ["inbound", inboundTick],
    ["sequence", () => sequenceTick({ limit: 50 })],
    // 적합도 캐시. 임포트가 무효화한 만큼만 채운다 — 사람이 화면을 안 열어도 채워져야 한다.
    ["fit", async () => {
      const c = await defaultCampaign();
      return c ? await refreshFit(c.id, { limit: 2000 }) : { scored: 0, remaining: 0, done: true };
    }],
  ] as const) {
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = { error: (e as Error).message };
    }
  }

  return NextResponse.json({ ok: true, ms: Date.now() - started, ...out });
}
