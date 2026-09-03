import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

/**
 * CSV 양식 내려받기.
 *
 * 헤더 이름을 사람이 옮겨 적으면 오타가 난다. 오타 난 컬럼은 조용히 무시되고
 * (임포터는 아는 이름만 읽는다) 그 필드가 통째로 비어서 들어온다 — 예를 들어
 * email 을 emial 로 적으면 2만 명이 연락처 없이 들어온다. 파일로 준다.
 */
const FILES: Record<string, { file: string; name: string }> = {
  creators: { file: "template-creators.csv", name: "인플루언서_양식.csv" },
  deals: { file: "template-deals.csv", name: "공구_양식.csv" },
};

export async function GET(_req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  const meta = FILES[kind];
  if (!meta) return new Response("not found", { status: 404 });

  const p = path.join(process.cwd(), "samples", meta.file);
  if (!fs.existsSync(p)) return new Response("template missing", { status: 500 });

  // BOM 을 붙인다. 엑셀이 UTF-8 CSV 를 BOM 없이 열면 한글 헤더가 깨지고,
  // 사용자는 헤더를 직접 고치다가 이름을 틀린다.
  const body = "﻿" + fs.readFileSync(p, "utf8");
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      "Cache-Control": "no-store",
    },
  });
}
