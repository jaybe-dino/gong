import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // 개선 제보의 스크린샷이 서버 액션 본문으로 올라온다. 기본 1MB 에서는
    // 화면 한 장만 붙여도 "전송 중 오류" 로 떨어지고, 사용자에게는 그 이유가
    // 보이지 않는다. 위젯이 올리기 전에 긴 변 1600px 로 줄이므로 실제 본문은
    // 훨씬 작지만, 여유를 둔다.
    serverActions: { bodySizeLimit: "12mb" },
  },
  // 스키마를 적재하는 코드는 런타임에 db/*.sql 을 읽는다. 트레이싱이 .sql 을
  // 따라가지 못하므로 해당 함수 번들에 명시적으로 포함시킨다.
  //
  // 라우트마다 번들이 따로 만들어진다. /setup(화면의 서버 액션)과
  // /api/admin/setup(API) 이 각각 필요하다 — 한쪽만 넣으면 다른 쪽이
  // "db/001_schema.sql 을 찾을 수 없다" 로 죽는다.
  outputFileTracingIncludes: {
    "/setup": ["./db/*.sql"],
    "/api/admin/setup": ["./db/*.sql"],
    // 양식 파일도 런타임에 읽는다.
    "/api/template/[kind]": ["./samples/template-*.csv"],
  },
};

export default nextConfig;
