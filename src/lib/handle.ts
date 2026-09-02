/**
 * 인스타 핸들 정규화.
 *
 * 세 소스의 공통 자연키는 핸들 하나뿐인데 소스마다 표기가 다르다.
 *   momcalendar  /s/de-elisa-shop   ← '.' 과 '_' 를 모두 '-' 로 치환 (역변환 불가)
 *   09pangpang   /account/9306      ← 숫자 ID
 *   insta-gong   /influencers/{uuid}
 *
 * 그래서 슬러그는 절대 매칭 키로 쓰지 않는다. 상세 페이지 본문의 실제 @handle 만 쓴다.
 */

export const IG_BASE = "https://www.instagram.com/";

/** 인스타 핸들 규칙: 영소문자/숫자/밑줄/마침표, 1~30자 */
export const HANDLE_RE = /^[a-z0-9._]{1,30}$/;

export function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let h = String(raw).trim().toLowerCase();
  h = h.replace(/^(https?:\/\/)?(www\.)?instagram\.com\//, "");
  h = h.split(/[?#]/)[0];
  h = h.replace(/\/+$/, "");
  h = h.replace(/^@/, "");
  if (!h || !HANDLE_RE.test(h)) return null;
  return h;
}

export function instagramUrl(handle: string | null | undefined): string | null {
  const h = normalizeHandle(handle);
  return h ? IG_BASE + h : null;
}

/** 화면에서 링크를 만들 때. 정규화에 실패해도 원문을 살려 붙인다. */
export function igUrl(handle: string): string {
  return instagramUrl(handle) ?? IG_BASE + String(handle).replace(/^@/, "");
}

/**
 * momcalendar 슬러그는 '.'/'_' 정보를 잃는다.
 * 기존 DB 와 대조하는 후보 생성용으로만 쓰고, 새 레코드 생성 키로는 쓰지 않는다.
 */
export function slugCandidates(slug: string | null | undefined): string[] {
  if (!slug) return [];
  const s = String(slug).trim().toLowerCase().replace(/\.html?$/, "");
  const parts = s.split("-");
  if (parts.length === 1) return HANDLE_RE.test(s) ? [s] : [];
  const out = new Set<string>();
  const total = Math.min(1 << (parts.length - 1), 256); // 조합 폭발 방지
  for (let mask = 0; mask < total; mask++) {
    let acc = parts[0];
    for (let i = 1; i < parts.length; i++) {
      acc += ((mask >> (i - 1)) & 1 ? "_" : ".") + parts[i];
    }
    out.add(acc);
  }
  out.add(s);
  out.add(parts.join(""));
  return [...out].filter((h) => HANDLE_RE.test(h));
}

/** 슬러그만 있고 실제 핸들이 없을 때 임포터가 남기는 경고 */
export function slugWarning(slug: string | null | undefined): string | null {
  if (!slug || !String(slug).includes("-")) return null;
  return (
    `슬러그 '${slug}' 는 '.' 과 '_' 를 구분할 수 없습니다. ` +
    `상세 페이지의 실제 @핸들 컬럼을 매칭 키로 지정하세요.`
  );
}

/** dedupe 비교용: 구분자를 제거한 비교 키 */
export function comparisonKey(handle: string | null | undefined): string | null {
  const h = normalizeHandle(handle);
  return h ? h.replace(/[._]/g, "") : null;
}
