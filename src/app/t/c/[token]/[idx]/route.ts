import { NextResponse } from "next/server";
import { recordClick } from "@/lib/tracking";
import * as settings from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * 클릭 추적 후 원래 주소로 보낸다.
 *
 * 대상 주소를 쿼리로 받지 않는다 — /t/c/{token}?u=<아무주소> 는 열린
 * 리다이렉터가 되어 우리 도메인의 신뢰를 빌려 피싱에 쓰인다. 발송할 때
 * blast_link 에 담아 둔 링크를 번호로만 가리키므로, 우리가 넣은 주소
 * 외에는 어디로도 보낼 수 없다.
 *
 * 기록이 실패하더라도 사람은 목적지에 도착해야 한다. 추적이 링크를 망치면
 * 그건 추적이 아니라 고장이다.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ token: string; idx: string }> },
) {
  const { token, idx } = await ctx.params;
  const n = Number(idx);

  const hit = Number.isInteger(n) && n >= 0
    ? await recordClick(token, n, req.headers.get("user-agent")).catch(() => null)
    : null;

  if (hit?.url) return NextResponse.redirect(hit.url, 302);

  // 링크를 못 찾았으면 홈으로. 404 를 주면 사용자는 우리 실수를 자기 문제로 본다.
  const base = (await settings.get("app.base_url")).replace(/\/$/, "");
  return NextResponse.redirect(base || "/", 302);
}
