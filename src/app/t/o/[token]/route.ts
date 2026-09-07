import { NextResponse } from "next/server";
import { PIXEL, recordOpen } from "@/lib/tracking";

export const dynamic = "force-dynamic";

/**
 * 열람 픽셀.
 *
 * 토큰이 무엇이든 항상 같은 1x1 GIF 를 돌려준다. 없는 토큰에 404 를 주면
 * 메일 스캐너가 토큰의 유효성을 알아낼 수 있고, 이미지가 깨져 보인다.
 *
 * 기록에 실패해도 200 을 준다 — 추적이 메일 렌더링을 망치면 안 된다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  await recordOpen(token, req.headers.get("user-agent")).catch(() => null);

  return new NextResponse(new Uint8Array(PIXEL), {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      // 캐시되면 재열람이 잡히지 않는다.
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
    },
  });
}
