"use client";

/**
 * 화면이 죽었을 때 보이는 페이지.
 *
 * Next.js 는 프로덕션에서 서버 오류의 원문을 숨기고 digest 만 남긴다. 그 자체는
 * 맞는 설계지만, 기본 화면은 "Application error: a server-side exception has
 * occurred" 한 줄이라 무엇을 해야 하는지 아무것도 알려주지 않는다.
 *
 * 원인은 거의 언제나 DB 연결이다 — 여러 화면이 한꺼번에 죽으면 특히 그렇다.
 * 그래서 확인 순서를 여기 적어 두고, 진단 엔드포인트로 바로 보낸다.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="setup">
      <h1>화면을 불러오지 못했습니다</h1>
      <p className="lede">서버에서 오류가 났습니다. 아래 순서로 확인하면 대부분 여기서 끝납니다.</p>

      <section className="card">
        <h2>확인 순서</h2>
        <ol className="hint" style={{ paddingLeft: 18, lineHeight: 2 }}>
          <li>
            <b>진단 먼저</b> — <code>/api/admin/diag?secret=CRON_SECRET</code> 를 주소창에 넣고 여세요.
            DB 연결·마이그레이션·데이터 건수를 한 번에 보여줍니다.
          </li>
          <li>
            <b>여러 화면이 같이 죽었다면 DB 연결입니다.</b> Vercel → Settings → Environment Variables 의{" "}
            <code>DATABASE_URL</code> 이 지금 Neon 연결 문자열과 같은지, Neon 프로젝트가 정지되지 않았는지
            보세요. 고친 뒤에는 <b>Redeploy</b> 해야 반영됩니다.
          </li>
          <li>
            <b>이 화면만 죽었다면</b> <a href="/setup">초기 설정</a> 에서 미적용 마이그레이션이 있는지 보세요.
          </li>
        </ol>
        {error.digest && (
          <p className="subnote">
            오류 식별자 <code>{error.digest}</code> — Vercel 로그에서 이 값으로 찾을 수 있습니다.
          </p>
        )}
      </section>

      <section className="card">
        <h2>다시 시도</h2>
        <div className="step">
          <button onClick={reset} type="button">이 화면 다시 불러오기</button>
          <span className="subnote">
            일시적인 연결 끊김이었다면 이걸로 복구됩니다. 두 번 이상 같은 화면이 죽으면 위 진단을 보세요.
          </span>
        </div>
      </section>

      <p className="hint">
        <a href="/dashboard">대시보드</a> · <a href="/setup">초기 설정</a> · <a href="/settings">계정 연동</a>
      </p>
    </main>
  );
}
