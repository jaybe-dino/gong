// src/ 는 번들러 해석(확장자 없는 상대 경로)을 쓴다. node:test 로 같은 소스를 돌리기 위해
// 확장자가 없는 상대 지정자에 .ts / .tsx 를 붙여 다시 시도한다.
import path from "node:path";

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !path.extname(specifier)) {
    for (const ext of [".ts", ".tsx", ".js"]) {
      try {
        return await next(specifier + ext, context);
      } catch {
        // 다음 확장자 시도
      }
    }
  }
  return next(specifier, context);
}
