import { NextResponse } from "next/server";
import { all, one } from "@/lib/db";
import { EXPECTED_MIGRATIONS } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * 진단 엔드포인트.
 *
 * 프로덕션에서 화면이 죽으면 Next.js 는 "Application error" 와 digest 만 남긴다.
 * 원문 메시지를 숨기는 건 맞는 설계지만, 그러면 무엇이 잘못됐는지 알 방법이
 * 로그뿐이다 — Vercel 로그를 열 수 없는 상황에서는 아무것도 못 한다.
 *
 * 그래서 "지금 서버가 보는 상태" 를 한 번에 돌려준다. 화면이 죽는 원인은 거의
 * 언제나 여기 다섯 줄 안에 있다: DB 연결 · 스키마 · 마이그레이션 · 데이터 · 환경 변수.
 *
 * 값은 절대 내보내지 않는다 — 있다/없다만 말한다. DATABASE_URL 은 호스트만,
 * 서비스 계정 키는 유무만. 이 응답이 새어도 열쇠는 새지 않아야 한다.
 */

function host(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return "(형식이 URL 이 아님)";
  }
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = new URL(req.url).searchParams.get("secret")
    ?? (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!secret) return NextResponse.json({ error: "CRON_SECRET 이 설정돼 있지 않습니다." }, { status: 503 });
  if (given !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const env = {
    DATABASE_URL: host(process.env.DATABASE_URL ?? process.env.POSTGRES_URL),
    APP_PASSWORD: Boolean(process.env.APP_PASSWORD),
    CRON_SECRET: true,
    GOOGLE_SA_KEY_JSON: Boolean(process.env.GOOGLE_SA_KEY_JSON?.trim()),
  };

  const started = Date.now();
  try {
    const tables = (await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE'`))?.n ?? 0;

    if (tables === 0) {
      return NextResponse.json({
        ok: false, env, db: "연결됨", tables: 0, ms: Date.now() - started,
        진단: "DB 는 붙었는데 테이블이 하나도 없습니다. /setup 에서 스키마를 적용하세요.",
      });
    }

    const applied = new Set(
      (await all<{ filename: string }>(`SELECT filename FROM schema_migration`).catch(() => []))
        .map((r) => r.filename));
    const pending = EXPECTED_MIGRATIONS.filter((m) => !applied.has(m));

    // 개수는 화면이 실제로 읽는 표에서만 센다. 없는 표는 조용히 0 이 아니라 null 이다.
    const counts: Record<string, number | null> = {};
    for (const t of ["creator", "campaign", "campaign_member", "contact_point", "message", "mailbox", "app_setting"]) {
      counts[t] = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`).catch(() => null))?.n ?? null;
    }

    const notes: string[] = [];
    if (pending.length) notes.push(`마이그레이션 ${pending.length}개 미적용 — /setup 에서 '스키마 적용'`);
    if (counts.creator === 0) notes.push("크리에이터가 0명입니다 — /import 에서 CSV 를 올리세요.");
    if (counts.campaign === 0) notes.push("캠페인이 없습니다 — /campaigns 에서 만드세요.");
    if (!env.GOOGLE_SA_KEY_JSON) notes.push("GOOGLE_SA_KEY_JSON 이 없어 메일이 dry-run 으로만 처리됩니다.");

    return NextResponse.json({
      ok: pending.length === 0,
      env, db: "연결됨", ms: Date.now() - started,
      tables, applied: [...applied].sort(), pending, counts,
      진단: notes.length ? notes : "이상 없음",
    });
  } catch (e) {
    // 여기까지 왔다면 화면이 죽는 이유도 십중팔구 이것이다.
    return NextResponse.json({
      ok: false, env, db: "연결 실패", ms: Date.now() - started,
      error: (e as Error).message,
      진단:
        "DB 에 붙지 못했습니다. 화면 전체가 'Application error' 로 뜨는 원인입니다. " +
        "Vercel → Settings → Environment Variables 의 DATABASE_URL 이 현재 Neon 연결 문자열과 같은지 확인하고, " +
        "Neon 대시보드에서 프로젝트가 살아 있는지(무료 플랜은 자동 정지됩니다) 보세요. 고친 뒤에는 반드시 Redeploy 해야 합니다.",
    }, { status: 500 });
  }
}
