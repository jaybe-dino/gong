import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /api/admin/setup 이 런타임에 db/*.sql 을 읽는다. 트레이싱이 .sql 을
  // 따라가지 못하므로 서버 번들에 명시적으로 포함시킨다.
  outputFileTracingIncludes: {
    "/api/admin/setup": ["./db/*.sql"],
  },
};

export default nextConfig;
