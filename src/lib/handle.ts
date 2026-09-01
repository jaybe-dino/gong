/**
 * 인스타 핸들 정규화.
 *
 * 세 소스를 잇는 공통 자연키는 인스타 핸들 하나뿐이라, 매칭 전에 표기 차이를 없앤다.
 * 소문자화하고 `.`, `_`, `-`, 공백을 제거한다. `@` 접두사와 URL 형태도 벗겨낸다.
 *
 * 주의: 맘캘린더의 슬러그(`de-elisa-shop`)는 `.` 과 `_` 를 모두 `-` 로 치환한 결과라
 * 역변환이 불가능하다. 슬러그는 매칭 키로 쓰지 않고 상세 페이지의 실제 @핸들만 쓴다.
 * 이 함수는 그 규칙을 강제하지 못하므로, 임포터가 슬러그 컬럼을 키로 지정하는 것을 막는다.
 */
export function normHandle(input: string): string {
  return String(input ?? "")
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[._\-\s]/g, "");
}

/** 표시용 핸들: @ 와 URL 만 벗기고 원 표기는 보존한다. */
export function cleanHandle(input: string): string {
  return String(input ?? "")
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/^@/, "");
}

export const IG = "https://www.instagram.com/";
export const igUrl = (handle: string) => IG + cleanHandle(handle);

/**
 * 두 핸들의 유사도(0~1). 임포트 중복 검사에 쓴다.
 * 정규화 후 동일하면 1.0, 아니면 정규화된 문자열의 Levenshtein 기반 유사도.
 */
export function handleSimilarity(a: string, b: string): number {
  const x = normHandle(a);
  const y = normHandle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const d = levenshtein(x, y);
  return 1 - d / Math.max(x.length, y.length);
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  const cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur.slice();
  }
  return prev[n];
}
