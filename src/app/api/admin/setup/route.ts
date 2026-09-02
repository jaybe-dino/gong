import { NextResponse } from "next/server";
// @ts-expect-error — .mjs 스크립트에는 타입 선언이 없다. CLI 와 같은 코드를 쓰기 위해 그대로 가져온다.
import { setupDb } from "../../../../../scripts/setup-db.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 배포 직후 DB 를 한 번 초기화하는 엔드포인트.
 *
 * 서버리스에는 셸이 없어서 `npm run db:setup` 을 프로덕션에서 돌릴 수 없다.
 * 로컬에서 프로덕션 DB 로 붙는 것도 방법이지만, 그러려면 연결 문자열을
 * 개인 노트북에 내려받아야 한다. 대신 앱 자신이 스키마를 적재하게 한다.
 *
 * CRON_SECRET 으로 보호한다. 이게 없으면 아무나 스키마를 갈아버릴 수 있다.
 * 이미 테이블이 있으면 손대지 않고 skipped 를 돌려준다. drop=1 은 public 스키마를
 * 통째로 재생성한다 — 데이터가 전부 날아가므로 명시적으로만 받는다.
 *
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<도메인>/api/admin/setup
 *
 * 시드 적재는 /api/admin/seed 로 분리했다. 스키마는 몇 초면 끝나지만
 * 시드는 1,700여 명을 넣어서 한 요청의 제한 시간에 걸릴 수 있다.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET 이 설정돼 있지 않다" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const drop = new URL(req.url).searchParams.get("drop") === "1";
  const started = Date.now();
  try {
    const r = await setupDb({ drop });
    return NextResponse.json({ ok: true, ms: Date.now() - started, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
