import { scalar } from "@/lib/db";
import { schemaState } from "@/lib/schema";
import { setupAction, seedAction } from "./actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 배포 직후 DB 를 초기화하는 화면.
 *
 * 터미널 없이 브라우저에서 끝낼 수 있게 둔다. 서버리스에는 셸이 없어서
 * 프로덕션에서 npm run db:setup 을 돌릴 수 없다.
 *
 * Shell 을 쓰지 않는다 — Shell 은 담당자와 미확인 이벤트를 DB 에서 읽어서
 * 초기화 전에는 이 화면 자체가 뜨지 못한다.
 */
type Probe = { reachable: boolean; tables: number; creator: number | null; error?: string; pending: string[] };

async function probe(): Promise<Probe> {
  try {
    const tables =
      (await scalar<number>(
        `SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE'`,
      )) ?? 0;
    let creator: number | null = null;
    if (tables > 0) {
      try {
        creator = (await scalar<number>("SELECT count(*)::int FROM creator")) ?? 0;
      } catch {
        creator = null;
      }
    }
    // 마이그레이션이 밀려 있으면 화면 기능이 조용히 빠진다. 무엇이 남았는지 보여준다.
    const st = await schemaState().catch(() => ({ pending: [] as string[] }));
    return { reachable: true, tables, creator, pending: st.pending };
  } catch (e) {
    return { reachable: false, tables: 0, creator: null, error: (e as Error).message, pending: [] };
  }
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; kind?: string }>;
}) {
  const { msg, kind } = await searchParams;
  const s = await probe();
  const schemaReady = s.reachable && s.tables > 0;
  const seeded = (s.creator ?? 0) > 0;

  return (
    <main className="setup">
      <h1>초기 설정</h1>
      <p className="lede">프로덕션 DB 에 스키마와 데모 데이터를 넣습니다. 배포 직후 한 번만 하면 됩니다.</p>

      <section className="card">
        <h2>현재 상태</h2>
        {s.reachable ? (
          <>
          <dl>
            <div>
              <dt>연결</dt>
              <dd className="good">정상</dd>
            </div>
            <div>
              <dt>테이블</dt>
              <dd>
                {s.tables}개{schemaReady ? "" : " — 스키마 미적용"}
              </dd>
            </div>
            <div>
              <dt>크리에이터</dt>
              <dd>{s.creator === null ? "—" : `${s.creator.toLocaleString("ko-KR")}명`}</dd>
            </div>
            <div>
              <dt>마이그레이션</dt>
              <dd className={s.pending.length ? "bad" : "good"}>
                {s.pending.length === 0 ? "최신" : `${s.pending.length}개 미적용`}
              </dd>
            </div>
          </dl>
          {s.pending.length > 0 && (
            <p className="hint" style={{ marginTop: 10 }}>
              아직 적용되지 않은 것: <code>{s.pending.join(", ")}</code>
              <br />
              아래 <b>1. 스키마 적용</b> 을 누르면 올라갑니다. 기존 데이터는 건드리지 않습니다.
              적용 전에는 적합도 순위와 유효성 점검이 화면에서 빠집니다.
            </p>
          )}
          </>
        ) : (
          <>
            <p className="bad">DB 에 연결되지 않습니다.</p>
            <pre>{s.error}</pre>
            <p className="hint">
              <code>DATABASE_URL</code> 이 없거나 잘못됐습니다. Vercel → Settings → Environment
              Variables 를 확인하고 <b>Redeploy</b> 하세요. 환경 변수는 재배포해야 함수에 반영됩니다.
            </p>
          </>
        )}
      </section>

      {msg ? <p className={`msg ${kind === "err" ? "err" : "ok"}`}>{msg}</p> : null}

      <section className="card">
        <h2>실행</h2>
        <p className="hint">
          Vercel 에 넣은 <code>CRON_SECRET</code> 을 붙여넣으세요. 두 단계 모두 같은 값을 씁니다.
        </p>

        <form action={setupAction} className="step">
          <label className="field">
            <span>CRON_SECRET</span>
            <input type="password" name="secret" required autoComplete="off" />
          </label>
          <button type="submit" disabled={!s.reachable}>
            1. 스키마 적용
          </button>
          <span className="subnote">
            테이블 34개와 정책·템플릿 시드를 넣습니다. 이미 있으면 손대지 않습니다.
          </span>
        </form>

        <form action={seedAction} className="step">
          <label className="field">
            <span>CRON_SECRET</span>
            <input type="password" name="secret" required autoComplete="off" />
          </label>
          <button type="submit" disabled={!schemaReady}>
            2. 데모 데이터 넣기
          </button>
          <span className="subnote">크리에이터 1,742명 · 공구 5,258건. 이미 있으면 손대지 않습니다.</span>
          <label className="chk">
            <input type="checkbox" name="force" value="1" />
            <span>이미 있어도 지우고 다시 넣기</span>
          </label>
        </form>
      </section>

      {seeded ? (
        <p className="done">
          준비됐습니다. <a href="/dashboard">대시보드로 이동 →</a>
        </p>
      ) : null}
    </main>
  );
}
