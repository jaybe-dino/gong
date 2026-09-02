import { NextResponse } from "next/server";
import { one, run, tx } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * 원클릭 수신거부 (RFC 8058).
 *
 * 모든 발송 메일의 List-Unsubscribe 헤더가 이 URL 을 가리킨다. 이 라우트가 없으면
 * 게이트는 통과하는데 실제 링크는 404 가 되어 §50② 회피에 해당할 수 있다.
 *
 *  POST — 메일 클라이언트의 원클릭. 확인 없이 즉시 처리하고 200 을 돌려준다.
 *  GET  — 사람이 링크를 눌렀을 때. 바로 해지하지 않고 버튼을 보여준다.
 *         메일 스캐너가 링크를 미리 열어보는 것만으로 해지되면 안 되기 때문이다.
 */

interface Target {
  member_id: string;
  creator_id: string;
  display_name: string;
  handle: string;
  campaign_name: string;
  already: boolean;
}

async function findTarget(token: string): Promise<Target | undefined> {
  return one<Target>(
    `SELECT cm.id AS member_id, cm.creator_id, c.display_name, sa.handle, cp.name AS campaign_name,
            EXISTS (SELECT 1 FROM suppression s
                     WHERE s.identifier_type='creator_id' AND s.identifier_val = cm.creator_id::text) AS already
       FROM campaign_member cm
       JOIN creator c ON c.id = cm.creator_id
       JOIN social_account sa ON sa.creator_id = c.id AND sa.platform='instagram'
       JOIN campaign cp ON cp.id = cm.campaign_id
      WHERE cm.reply_token = $1 OR cm.reply_token = $2`,
    [token, `cm_${token}`],
  );
}

/** 전 채널 영구 차단 + 진행 중 시퀀스 중단. */
async function suppress(t: Target) {
  await tx(async (c) => {
    for (const [type, sql] of [
      ["creator_id", `SELECT $1::text`],
      ["ig_handle", `SELECT handle FROM social_account WHERE creator_id=$1`],
      ["email", `SELECT value_norm FROM contact_point WHERE creator_id=$1 AND channel='email'`],
    ] as const) {
      await c.query(
        `INSERT INTO suppression (identifier_type, identifier_val, channels, reason)
         SELECT $2, v, '{}', 'unsubscribe' FROM (${sql}) AS x(v) WHERE v IS NOT NULL
         ON CONFLICT DO NOTHING`,
        [t.creator_id, type],
      );
    }
    await c.query(`UPDATE contact_point SET consent_status='opt_out' WHERE creator_id=$1`, [t.creator_id]);
    await c.query(
      `UPDATE campaign_member
          SET engine_state=-4, next_action_at=NULL, dropped_at=now(), drop_reason='수신거부(원클릭)',
              stage_id=(SELECT id FROM pipeline_stage WHERE key='dropped')
        WHERE creator_id=$1 AND engine_state > 0`,
      [t.creator_id],
    );
    await c.query(`UPDATE outreach_task SET state='skipped', skip_reason='수신거부'
                    WHERE campaign_member_id IN (SELECT id FROM campaign_member WHERE creator_id=$1)
                      AND state IN ('queued','claimed')`, [t.creator_id]);
  });

  await run(
    `INSERT INTO message_event (message_id, type, meta)
     SELECT m.id, 'unsubscribe', $2 FROM message m
      WHERE m.campaign_member_id=$1 AND m.direction='out'
      ORDER BY m.sent_at DESC LIMIT 1`,
    [t.member_id, JSON.stringify({ via: "one_click" })],
  );
  await run(
    `INSERT INTO audit_log (actor_kind, entity, entity_id, action, reason)
     VALUES ('system','creator',$1,'unsubscribe','원클릭 수신거부')`,
    [t.creator_id],
  );
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const t = await findTarget(token);
  // 토큰이 틀려도 200 을 준다. 유효/무효를 알려주면 토큰을 긁어볼 수 있다.
  if (t && !t.already) await suppress(t);

  // 메일 클라이언트의 원클릭(RFC 8058)은 본문을 읽지 않는다. 사람이 버튼을 눌렀을 때만
  // 완료 페이지를 돌려준다 — Accept 로 구분한다.
  const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
  if (!wantsHtml) return new NextResponse("OK", { status: 200 });

  return new NextResponse(
    page(`<h1>수신거부가 완료되었습니다</h1>
          <p>앞으로 이 주소로 제안 메일을 보내지 않습니다. 처리는 영구적이며 되돌릴 수 없습니다.</p>`),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const t = await findTarget(token);
  const done = !t || t.already;

  const body = done
    ? `<h1>수신거부가 완료되었습니다</h1>
       <p>앞으로 이 주소로 제안 메일을 보내지 않습니다. 처리는 영구적이며 되돌릴 수 없습니다.</p>`
    : `<h1>수신거부</h1>
       <p><b>${esc(t.display_name)}</b> 님, 아래 버튼을 누르면 Dinostudio 의 모든 제안 메일 수신이
          영구적으로 중단됩니다. 무료이며 즉시 처리됩니다.</p>
       <form method="post"><button type="submit">수신거부하기</button></form>
       <p class="muted">이 링크를 실수로 여신 것이라면 창을 닫으시면 됩니다. 버튼을 누르기 전에는
          아무것도 처리되지 않습니다.</p>`;

  return new NextResponse(page(body), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function page(inner: string) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>수신거부 — Dinostudio</title>
<style>
  :root{color-scheme:light}
  body{margin:0;background:#fff;color:#0F1518;display:grid;place-items:center;min-height:100vh;
       font:15px/1.7 "IBM Plex Sans KR","Apple SD Gothic Neo",system-ui,sans-serif;word-break:keep-all}
  main{max-width:34rem;padding:40px 24px}
  h1{font-size:20px;margin:0 0 12px}
  p{margin:0 0 14px;color:#4B5860}
  .muted{font-size:13px;color:#7A888E}
  button{font:inherit;font-weight:600;background:#0E6E73;color:#fff;border:0;border-radius:3px;
         padding:10px 20px;cursor:pointer}
  button:hover{filter:brightness(1.08)}
  footer{margin-top:28px;font-size:12px;color:#7A888E;border-top:1px solid #E3E9E7;padding-top:14px}
</style></head><body><main>${inner}
<footer>${esc(process.env.MAIL_ORG_NAME ?? "Dinostudio (주)")} · ${esc(process.env.MAIL_BASE_ADDRESS ?? "partner@dinostudio.kr")}</footer>
</main></body></html>`;
}
