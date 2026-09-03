import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, authConfigured, login } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function submit(formData: FormData) {
  "use server";
  const next = String(formData.get("next") ?? "/dashboard");
  const token = await login(String(formData.get("password") ?? ""));
  if (!token) redirect(`/login?err=1${next ? `&next=${encodeURIComponent(next)}` : ""}`);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
  // 경로만 허용한다. 외부 URL 을 넣어 다른 사이트로 보내는 걸 막는다.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string; next?: string }>;
}) {
  const sp = await searchParams;
  const configured = authConfigured();

  return (
    <main className="login">
      <div className="login-card">
        <h1>아웃리치 콘솔</h1>
        <p className="lede">Dinostudio 내부 도구입니다.</p>

        {configured ? (
          <form action={submit}>
            <input type="hidden" name="next" value={sp.next ?? "/dashboard"} />
            <label className="field">
              <span>비밀번호</span>
              <input type="password" name="password" required autoFocus autoComplete="current-password" />
            </label>
            {sp.err ? <p className="bad">비밀번호가 맞지 않습니다.</p> : null}
            <button className="btn pri" type="submit">들어가기</button>
          </form>
        ) : (
          <>
            <p className="bad">APP_PASSWORD 가 설정되지 않았습니다.</p>
            <p className="hint">
              Vercel → Settings → Environment Variables 에 <code>APP_PASSWORD</code> 를 추가하고 재배포하세요.
              이 값이 없으면 아무도 들어올 수 없습니다 — 환경 변수를 빼먹었을 때 사이트가 열려 있는 것보다
              닫혀 있는 편이 안전합니다.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
