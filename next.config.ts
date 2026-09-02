import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 스키마를 적재하는 코드는 런타임에 db/*.sql 을 읽는다. 트레이싱이 .sql 을
  // 따라가지 못하므로 해당 함수 번들에 명시적으로 포함시킨다.
  //
  // 라우트마다 번들이 따로 만들어진다. /setup(화면의 서버 액션)과
  // /api/admin/setup(API) 이 각각 필요하다 — 한쪽만 넣으면 다른 쪽이
  // "db/001_schema.sql 을 찾을 수 없다" 로 죽는다.
  outputFileTracingIncludes: {
    "/setup": ["./db/*.sql"],
    "/api/admin/setup": ["./db/*.sql"],
  },
};

export default nextConfig;
