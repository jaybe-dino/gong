import crypto from "node:crypto";
import { all, one, run } from "./db";
import { hasColumn, hasTable } from "./schema";

/**
 * 열람·클릭 추적.
 *
 * 켜면 도달률이 떨어진다. 그래서 발송마다 고르게 하고 기본값은 꺼 둔다.
 *   · 열람 픽셀은 1x1 이미지를 숨겨 넣는 짓이라 필터가 좋아하지 않는다.
 *     Gmail 은 이미지를 자기 프록시로 받아 캐시하므로 수치가 부풀거나,
 *     반대로 이미지 차단 설정에서는 아예 잡히지 않는다 — 방향만 보는 지표다.
 *   · 클릭 추적은 링크를 우리 도메인으로 바꿔치기하므로, 원 도메인의 평판을
 *     우리 도메인 평판으로 갈아 끼운다.
 *
 * 리다이렉트 대상을 URL 파라미터로 받지 않는다. /t/c/{token}?u=<아무주소> 는
 * 열린 리다이렉터가 되어 우리 도메인의 신뢰를 빌려 피싱에 쓰인다. 발송할 때
 * 링크를 blast_link 에 담고 번호로만 가리킨다.
 */

export function newTrackToken(): string {
  return crypto.randomBytes(12).toString("hex");
}

/** 1x1 투명 GIF. 픽셀 요청에 돌려준다. */
export const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/**
 * 본문의 링크를 추적 링크로 바꾼다.
 *
 * 수신거부 링크는 건드리지 않는다 — 그건 법으로 동작해야 하는 링크이고,
 * 추적을 거치게 만들면 클릭이 기록에 남아 "수신거부를 눌렀는지" 가 우리 쪽
 * 분석 데이터가 된다. 그럴 이유가 없다.
 */
export function rewriteLinks(
  html: string, links: string[], baseUrl: string, token: string,
): string {
  return html.replace(/(<a\b[^>]*\bhref=)(["'])([^"']+)\2/gi, (m, pre, q, url) => {
    const u = String(url);
    if (!/^https?:\/\//i.test(u)) return m;          // mailto·anchor 는 그대로
    if (u.includes("/u/") && u.startsWith(baseUrl)) return m;  // 수신거부는 예외
    let idx = links.indexOf(u);
    if (idx < 0) { links.push(u); idx = links.length - 1; }
    return `${pre}${q}${baseUrl}/t/c/${token}/${idx}${q}`;
  });
}

export function pixelTag(baseUrl: string, token: string): string {
  // width/height 를 1 로 두고 alt 를 비운다. display:none 은 필터가 더 싫어한다.
  return `<img src="${baseUrl}/t/o/${token}" width="1" height="1" alt="" style="border:0" />`;
}

/** 발송의 링크 표를 갈아 끼운다. 다시 보낼 때 번호가 어긋나면 안 된다. */
export async function saveLinks(blastId: string, links: string[]): Promise<void> {
  await run(`DELETE FROM blast_link WHERE blast_id=$1`, [blastId]);
  for (const [idx, url] of links.entries()) {
    await run(
      `INSERT INTO blast_link (blast_id, idx, url) VALUES ($1,$2,$3)
       ON CONFLICT (blast_id, idx) DO UPDATE SET url=EXCLUDED.url`,
      [blastId, idx, url]);
  }
}

export interface Hit {
  messageId: string;
  url?: string;
}

/**
 * 열람 기록. 같은 사람이 여러 번 열면 여러 건이 쌓인다 — 첫 열람과 재열람을
 * 구분할 수 있어야 하므로 유니크를 걸지 않는다.
 */
export async function recordOpen(token: string, ua: string | null): Promise<Hit | null> {
  if (!(await hasColumn("message", "track_token"))) return null;
  const m = await one<{ id: string }>(`SELECT id FROM message WHERE track_token=$1`, [token]);
  if (!m) return null;
  await run(
    `INSERT INTO message_event (message_id, type, meta) VALUES ($1,'open',$2)`,
    [m.id, JSON.stringify({ ua: ua?.slice(0, 200) ?? null })]);
  return { messageId: m.id };
}

export async function recordClick(
  token: string, idx: number, ua: string | null,
): Promise<Hit | null> {
  if (!(await hasColumn("message", "track_token")) || !(await hasTable("blast_link"))) return null;
  const row = await one<{ id: string; blast_id: string | null }>(
    `SELECT id, blast_id FROM message WHERE track_token=$1`, [token]);
  if (!row?.blast_id) return null;

  const link = await one<{ url: string }>(
    `SELECT url FROM blast_link WHERE blast_id=$1 AND idx=$2`, [row.blast_id, idx]);
  if (!link) return null;

  await run(
    `INSERT INTO message_event (message_id, type, meta) VALUES ($1,'click',$2)`,
    [row.id, JSON.stringify({ url: link.url, ua: ua?.slice(0, 200) ?? null })]);
  return { messageId: row.id, url: link.url };
}

export interface TrackSummary {
  sent: number;
  opened: number;
  clicked: number;
  openEvents: number;
  clickEvents: number;
}

/**
 * 발송별 집계.
 *
 * 열람·클릭은 "몇 명" 과 "몇 번" 이 다르다. 한 사람이 다섯 번 열면 열람 1명 ·
 * 5회다. 둘을 섞으면 열람률이 100%를 넘는다.
 */
export async function summary(blastId: string): Promise<TrackSummary> {
  const zero = { sent: 0, opened: 0, clicked: 0, openEvents: 0, clickEvents: 0 };
  if (!(await hasColumn("message", "blast_id"))) return zero;
  return (await one<TrackSummary>(
    `SELECT
       (SELECT count(*)::int FROM message WHERE blast_id=$1 AND status='sent') AS sent,
       (SELECT count(DISTINCT m.id)::int FROM message m
          JOIN message_event e ON e.message_id=m.id AND e.type='open'
         WHERE m.blast_id=$1) AS opened,
       (SELECT count(DISTINCT m.id)::int FROM message m
          JOIN message_event e ON e.message_id=m.id AND e.type='click'
         WHERE m.blast_id=$1) AS clicked,
       (SELECT count(*)::int FROM message m
          JOIN message_event e ON e.message_id=m.id AND e.type='open'
         WHERE m.blast_id=$1) AS "openEvents",
       (SELECT count(*)::int FROM message m
          JOIN message_event e ON e.message_id=m.id AND e.type='click'
         WHERE m.blast_id=$1) AS "clickEvents"`,
    [blastId])) ?? zero;
}

/**
 * 링크별 클릭. 무엇을 눌렀는지가 열람률보다 쓸모 있다.
 *
 * "누른 사람" 은 이벤트가 있는 메시지만 센다. 그냥 count(DISTINCT m.id) 로
 * 세면 발송 대상 전원이 잡혀서, 클릭 2회에 누른 사람 3명 같은 값이 나온다
 * (실제로 그렇게 나왔다) — 사람 수가 횟수를 넘으면 표를 믿을 수 없다.
 */
export async function linkStats(blastId: string) {
  if (!(await hasTable("blast_link"))) return [];
  return all<{ url: string; clicks: number; people: number }>(
    `SELECT l.url,
            count(e.id)::int AS clicks,
            count(DISTINCT e.message_id)::int AS people
       FROM blast_link l
       LEFT JOIN message_event e
              ON e.type='click' AND e.meta->>'url' = l.url
             AND e.message_id IN (SELECT id FROM message WHERE blast_id = l.blast_id)
      WHERE l.blast_id=$1
      GROUP BY l.url
      ORDER BY clicks DESC, l.url`,
    [blastId]);
}

/** 누가 열었고 눌렀는지. 회신 없이도 관심 있는 대상을 골라낼 수 있다. */
export async function engaged(blastId: string, limit = 30) {
  if (!(await hasColumn("message", "blast_id"))) return [];
  return all<{
    handle: string; display_name: string; opens: number; clicks: number;
    first_open: string | null; last_click: string | null;
  }>(
    `SELECT sa.handle, c.display_name,
            count(*) FILTER (WHERE e.type='open')::int  AS opens,
            count(*) FILTER (WHERE e.type='click')::int AS clicks,
            to_char(min(e.occurred_at) FILTER (WHERE e.type='open'),'MM-DD HH24:MI')  AS first_open,
            to_char(max(e.occurred_at) FILTER (WHERE e.type='click'),'MM-DD HH24:MI') AS last_click
       FROM message m
       JOIN message_event e ON e.message_id = m.id AND e.type IN ('open','click')
       JOIN campaign_member cm ON cm.id = m.campaign_member_id
       JOIN creator c ON c.id = cm.creator_id
       JOIN social_account sa ON sa.creator_id = c.id AND sa.platform='instagram'
      WHERE m.blast_id=$1
      GROUP BY sa.handle, c.display_name
      ORDER BY clicks DESC, opens DESC
      LIMIT $2`,
    [blastId, limit]);
}
