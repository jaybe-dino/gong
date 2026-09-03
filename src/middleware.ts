import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isPublicPath, verify } from "@/lib/auth";

/**
 * 로그인 게이트.
 *
 * 크리에이터의 이메일·전화번호·사업자번호가 들어 있는 콘솔이다. 배포된 상태로
 * 열려 있으면 개인정보가 그대로 공개된다.
 */
export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  if (await verify(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  // 로그인 후 원래 보려던 곳으로 돌려보낸다. 경로만 넘겨 오픈 리다이렉트를 막는다.
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
