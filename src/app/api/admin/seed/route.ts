import { NextResponse } from "next/server";
// @ts-expect-error — .mjs 스크립트에는 타입 선언이 없다. CLI 와 같은 코드를 쓰기 위해 그대로 가져온다.
import { seed } from "../../../../../scripts/seed.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 데모 데이터 적재. /api/admin/setup 으로 스키마를 올린 다음 한 번 호출한다.
 *
 * 이미 시드된 DB 에서는 아무것도 하지 않고 skipped 를 돌려준다.
 * force=1 이면 데이터 테이블을 TRUNCATE 하고 다시 넣는다 (정책 시드는 남는다).
 *
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<도메인>/api/admin/seed
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET 이 설정돼 있지 않다" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const force = new URL(req.url).searchParams.get("force") === "1";
  const started = Date.now();
  try {
    const r = await seed({ force });
    return NextResponse.json({ ok: true, ms: Date.now() - started, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
