import { NextResponse } from "next/server";
import { imageBytes } from "@/lib/feedback";

/**
 * 첨부 이미지.
 *
 * 데이터 URI 로 페이지에 박으면 목록 HTML 이 수 MB 가 된다. 주소로 내려서
 * 브라우저가 캐시하게 둔다.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("not found", { status: 404 });

  const row = await imageBytes(id);
  if (!row) return new NextResponse("not found", { status: 404 });

  return new NextResponse(new Uint8Array(row.bytes), {
    headers: {
      "content-type": row.mime,
      // 내용이 바뀌지 않는 첨부다. 인증 뒤에 있으므로 private 으로 둔다.
      "cache-control": "private, max-age=31536000, immutable",
      "content-disposition": "inline",
    },
  });
}
