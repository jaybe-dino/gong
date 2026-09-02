/** RFC4180 최소 구현. 따옴표 안의 쉼표·개행·이스케이프된 따옴표를 처리한다. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * 원문을 레코드 단위 문자열로 자른다. 따옴표 안의 개행은 자르지 않는다.
 *
 * 큰 파일을 청크로 올릴 때 쓴다. 그냥 "\n" 으로 쪼개면 따옴표 안에 개행이 든
 * 행(주소·후기 같은 자유 텍스트)이 두 조각으로 갈려서 파싱이 어긋난다.
 * 브라우저와 서버 양쪽에서 쓰므로 이 모듈은 Node 전용 API 를 쓰지 않는다.
 */
export function splitRecords(text: string): string[] {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const out: string[] = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      if (inQuotes && src[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (ch === "\n" && !inQuotes) {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  if (start < src.length) out.push(src.slice(start));
  return out.filter((r) => r.trim() !== "");
}

export function toObjects(rows: string[][]): { headers: string[]; records: Record<string, string>[] } {
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o;
  });
  return { headers, records };
}

/** "10.8만" → 108000, "1,204" → 1204. 반올림된 값은 오차 폭을 함께 돌려준다. */
export function parseFollowers(raw: string): { value: number | null; precision: number } {
  const s = String(raw ?? "").trim().replace(/,/g, "");
  if (!s) return { value: null, precision: 0 };
  let m = s.match(/^([\d.]+)\s*만$/);
  if (m) {
    const n = parseFloat(m[1]);
    // 소수 한 자리까지 표기된 "만" 단위는 ±500 의 반올림 오차를 안는다.
    const decimals = (m[1].split(".")[1] ?? "").length;
    return { value: Math.round(n * 10000), precision: decimals >= 1 ? 500 : 5000 };
  }
  m = s.match(/^([\d.]+)\s*천$/);
  if (m) return { value: Math.round(parseFloat(m[1]) * 1000), precision: 50 };
  m = s.match(/^([\d.]+)\s*[kK]$/);
  if (m) return { value: Math.round(parseFloat(m[1]) * 1000), precision: 50 };
  const n = Number(s);
  return Number.isFinite(n) ? { value: Math.round(n), precision: 0 } : { value: null, precision: 0 };
}

/** "약 1시간 전", "3일 전" → 절대시각 ISO 문자열. */
export function parseRelativeTime(raw: string, now = new Date()): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const m = s.match(/(\d+)\s*(분|시간|일|주|개월)\s*전/);
  if (!m) return null;
  const n = Number(m[1]);
  const ms: Record<string, number> = { 분: 6e4, 시간: 36e5, 일: 864e5, 주: 6048e5, 개월: 2592e6 };
  return new Date(now.getTime() - n * ms[m[2]]).toISOString().slice(0, 19).replace("T", " ");
}
