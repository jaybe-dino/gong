"use server";

import { revalidatePath } from "next/cache";
import * as fb from "@/lib/feedback";
import { hasTable } from "@/lib/schema";

const JAY = "00000000-0000-0000-0000-0000000000aa";

/**
 * 제보 접수.
 *
 * 위젯이 fetch 대신 서버 액션을 부른다 — 같은 배포 안이라 인증 쿠키가 그대로
 * 실리고, 라우트를 따로 열지 않아도 된다.
 *
 * 예외를 던지지 않고 결과를 돌려준다. 위젯은 화면 위에 떠 있는 작은 창이라
 * 오류 화면으로 넘어가면 사용자가 쓰던 내용이 통째로 사라진다.
 */
export async function submitFeedback(
  form: FormData,
): Promise<{ id?: string; error?: string }> {
  if (!(await hasTable("feedback"))) {
    return { error: "제보 표가 아직 없습니다. 초기 설정에서 스키마를 적용해 주세요." };
  }

  const title = String(form.get("title") ?? "").trim();
  if (!title) return { error: "제목을 적어 주세요." };
  if (title.length > 200) return { error: "제목이 너무 깁니다 (200자까지)." };

  const body = String(form.get("body") ?? "").trim();
  if (body.length > 20000) return { error: "내용이 너무 깁니다." };

  const kindRaw = String(form.get("kind") ?? "improve");
  const kind = fb.KINDS.some((k) => k.key === kindRaw) ? kindRaw : "improve";

  // 화면이 보낸 값이라 그대로 믿지 않는다. 깨진 JSON 이 와도 제보는 남아야 한다.
  let context: unknown = {};
  try {
    const raw = String(form.get("context") ?? "{}");
    if (raw.length <= 200_000) context = JSON.parse(raw);
  } catch { context = { parse_error: true }; }

  const files: { mime: string; filename: string | null; bytes: Buffer }[] = [];
  for (const entry of form.getAll("images")) {
    if (!(entry instanceof File)) continue;
    if (!fb.ALLOWED_MIME.includes(entry.type)) {
      return { error: `지원하지 않는 형식입니다 (${entry.type || "알 수 없음"}).` };
    }
    if (entry.size > fb.MAX_IMAGE_BYTES) {
      return { error: `이미지 한 장이 너무 큽니다 (${Math.round(entry.size / 1024)}KB).` };
    }
    files.push({
      mime: entry.type,
      filename: entry.name ? entry.name.slice(0, 120) : null,
      bytes: Buffer.from(await entry.arrayBuffer()),
    });
    if (files.length >= fb.MAX_IMAGES) break;
  }

  try {
    const id = await fb.create({
      title, body, kind,
      pagePath: String(form.get("pagePath") ?? "") || null,
      pageTitle: String(form.get("pageTitle") ?? "") || null,
      context, files,
    }, JAY);
    revalidatePath("/feedback");
    return { id };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * 목록 화면의 상태 변경. 여기서만 done_at 이 함께 움직인다.
 *
 * redirect 하지 않는다. revalidatePath 만 하면 액션 응답에 갱신된 화면이 실려
 * 오므로 제자리에서 바뀌고, 보고 있던 필터(진행 중·완료 등)도 그대로 남는다.
 * 같은 화면으로 redirect 하면 필터가 초기화되고, 클라이언트 라우터 캐시를
 * 거치므로 갱신이 한 박자 늦을 여지도 생긴다.
 */
export async function changeStatus(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  const status = String(form.get("status") ?? "");
  if (!id || !fb.STATUSES.some((s) => s.key === status)) return;
  await fb.setStatus(id, status as fb.StatusKey);
  revalidatePath("/feedback");
}

export async function saveNote(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  if (!id) return;
  await fb.setNote(id, String(form.get("note") ?? ""));
  revalidatePath("/feedback");
}

export async function removeFeedback(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  if (!id) return;
  await fb.remove(id);
  revalidatePath("/feedback");
}
