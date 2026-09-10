import { all, one, run } from "./db";
import { hasTable } from "./schema";

/**
 * 개선 제보.
 *
 * 화면 오른쪽 아래 버튼에서 들어오고, 왼쪽 메뉴의 목록에서 처리한다.
 * 제보하는 사람과 고치는 사람이 다르므로, 재현에 필요한 것을 제보 시점에
 * 자동으로 담는다 — 나중에 물어보면 이미 그 화면이 아니다.
 */

export const KINDS = [
  { key: "bug", label: "오류" },
  { key: "improve", label: "개선" },
  { key: "question", label: "문의" },
] as const;

/**
 * 상태.
 *
 * 요청과 완료만 두면 "봤는지" 를 알 수 없어 같은 제보가 반복된다. 보류는
 * 조용히 사라지는 것과 구분하려고 둔다 — 안 하기로 한 것도 결정이다.
 */
export const STATUSES = [
  { key: "open", label: "요청", tone: "k-warn" },
  { key: "planned", label: "확인됨", tone: "k-acc" },
  { key: "doing", label: "개발중", tone: "k-acc" },
  { key: "done", label: "완료", tone: "k-ok" },
  { key: "wontfix", label: "보류", tone: "" },
] as const;

export type StatusKey = (typeof STATUSES)[number]["key"];

export const KIND_LABEL: Record<string, string> =
  Object.fromEntries(KINDS.map((k) => [k.key, k.label]));
export const STATUS_LABEL: Record<string, string> =
  Object.fromEntries(STATUSES.map((s) => [s.key, s.label]));
export const STATUS_TONE: Record<string, string> =
  Object.fromEntries(STATUSES.map((s) => [s.key, s.tone]));

/** 끝난 상태. done_at 이 있어야 하고, 목록에서 기본으로 접힌다. */
export function isClosed(status: string): boolean {
  return status === "done" || status === "wontfix";
}

export interface FeedbackRow {
  id: string;
  title: string;
  body: string;
  kind: string;
  status: string;
  page_path: string | null;
  page_title: string | null;
  context: Record<string, unknown>;
  note: string | null;
  author: string | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  images: number;
}

const SELECT = `
  SELECT f.id, f.title, f.body, f.kind, f.status, f.page_path, f.page_title,
         f.context, f.note, u.name AS author,
         to_char(f.created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
         to_char(f.updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at,
         to_char(f.done_at,    'YYYY-MM-DD HH24:MI') AS done_at,
         (SELECT count(*)::int FROM feedback_image i WHERE i.feedback_id = f.id) AS images
    FROM feedback f
    LEFT JOIN app_user u ON u.id = f.created_by`;

/**
 * 목록. 기본은 진행 중인 것만 — 끝난 것이 쌓이면 남은 일이 안 보인다.
 */
export async function list(status?: string): Promise<FeedbackRow[]> {
  if (!(await hasTable("feedback"))) return [];
  if (status && status !== "all") {
    return all<FeedbackRow>(`${SELECT} WHERE f.status=$1 ORDER BY f.created_at DESC`, [status]);
  }
  if (status === "all") {
    return all<FeedbackRow>(`${SELECT} ORDER BY f.created_at DESC`);
  }
  return all<FeedbackRow>(
    `${SELECT} WHERE f.status NOT IN ('done','wontfix') ORDER BY f.created_at DESC`);
}

export async function counts(): Promise<Record<string, number>> {
  if (!(await hasTable("feedback"))) return {};
  const rows = await all<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM feedback GROUP BY status`);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  out.all = rows.reduce((a, r) => a + r.n, 0);
  out.open_total = (out.open ?? 0) + (out.planned ?? 0) + (out.doing ?? 0);
  return out;
}

export async function get(id: string): Promise<FeedbackRow | null> {
  if (!(await hasTable("feedback"))) return null;
  return (await one<FeedbackRow>(`${SELECT} WHERE f.id=$1`, [id])) ?? null;
}

export async function images(id: string) {
  if (!(await hasTable("feedback_image"))) return [];
  return all<{ id: string; mime: string; filename: string | null; size_bytes: number }>(
    `SELECT id, mime, filename, size_bytes FROM feedback_image
      WHERE feedback_id=$1 ORDER BY created_at`, [id]);
}

export async function imageBytes(imageId: string) {
  if (!(await hasTable("feedback_image"))) return null;
  return (await one<{ mime: string; bytes: Buffer }>(
    `SELECT mime, bytes FROM feedback_image WHERE id=$1`, [imageId])) ?? null;
}

/** 화면이 올려도 되는 첨부의 한계. 넘으면 받지 않는다. */
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export interface NewFeedback {
  title: string;
  body: string;
  kind: string;
  pagePath: string | null;
  pageTitle: string | null;
  context: unknown;
  files: { mime: string; filename: string | null; bytes: Buffer }[];
}

export async function create(input: NewFeedback, userId: string | null): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO feedback (title, body, kind, page_path, page_title, context, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [input.title, input.body, input.kind, input.pagePath, input.pageTitle,
     JSON.stringify(input.context ?? {}), userId]);

  for (const f of input.files.slice(0, MAX_IMAGES)) {
    await run(
      `INSERT INTO feedback_image (feedback_id, mime, bytes, filename, size_bytes)
       VALUES ($1,$2,$3,$4,$5)`,
      [row!.id, f.mime, f.bytes, f.filename, f.bytes.length]);
  }
  return row!.id;
}

/**
 * 상태 변경.
 *
 * done_at 은 상태와 함께 움직여야 한다 — 스키마 제약이 어긋난 조합을 거부하므로
 * 여기서 같이 맞춘다. 완료를 되돌리면 완료 시각도 지운다.
 */
export async function setStatus(id: string, status: StatusKey): Promise<void> {
  await run(
    `UPDATE feedback
        SET status=$2,
            done_at = CASE WHEN $2 IN ('done','wontfix') THEN COALESCE(done_at, now()) ELSE NULL END,
            updated_at = now()
      WHERE id=$1`,
    [id, status]);
}

export async function setNote(id: string, note: string): Promise<void> {
  await run(`UPDATE feedback SET note=$2, updated_at=now() WHERE id=$1`,
            [id, note.trim() || null]);
}

export async function remove(id: string): Promise<void> {
  await run(`DELETE FROM feedback WHERE id=$1`, [id]);
}
