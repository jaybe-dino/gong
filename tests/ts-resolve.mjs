// src/ 는 번들러 해석(확장자 없는 상대 경로, 디렉터리 = index)을 쓴다.
// node:test 와 워커 러너로 같은 소스를 돌리기 위해 확장자와 /index 를 붙여 다시 시도한다.
import path from "node:path";

const CANDIDATES = [".ts", ".tsx", ".js", "/index.ts", "/index.tsx", "/index.js"];

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !path.extname(specifier)) {
    for (const suffix of CANDIDATES) {
      try {
        return await next(specifier + suffix, context);
      } catch {
        // 다음 후보 시도
      }
    }
  }
  return next(specifier, context);
}
