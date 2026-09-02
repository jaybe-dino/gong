import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Empty, IgLink, Note, Pill, Scroller } from "@/components/ui";
import { all, one } from "@/lib/db";
import { completeTask, reportBlock } from "@/lib/actions";
import { senders } from "@/lib/queries";
import { CHANNEL_LABEL, fmt, fol } from "@/lib/format";

export const dynamic = "force-dynamic";

const CHANNELS: [string, string][] = [
  ["all", "전체"], ["instagram_dm", "인스타 DM"], ["inpock_offer", "인포크 제안"], ["linktree_form", "링크트리 폼"],
];

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ channel?: string }> }) {
  const sp = await searchParams;
  const channel = CHANNELS.some(([k]) => k === sp.channel) ? sp.channel! : "all";

  const [counts, tasks, dmSenders, done] = await Promise.all([
    all<{ channel: string; n: string }>(
      `SELECT channel, count(*) AS n FROM outreach_task WHERE state IN ('queued','claimed') GROUP BY channel`),
    all<{
      id: string; channel: string; rendered_body: string; rendered_subject: string | null;
      due_at: string; target_url: string | null; handle: string; display_name: string;
      followers: number | null; campaign: string; sender: string | null; sender_status: string | null;
    }>(
      `SELECT t.id, t.channel, t.rendered_body, t.rendered_subject,
              to_char(t.due_at,'MM-DD HH24:MI') AS due_at, t.target_url,
              sa.handle, c.display_name,
              (SELECT followers FROM account_snapshot s WHERE s.social_account_id=sa.id ORDER BY s.captured_at DESC LIMIT 1) AS followers,
              cp.name AS campaign, snd.identifier AS sender,
              CASE WHEN snd.paused_until > now() THEN 'paused' ELSE 'ok' END AS sender_status
         FROM outreach_task t
         JOIN campaign_member m ON m.id = t.campaign_member_id
         JOIN creator c ON c.id = m.creator_id
         JOIN social_account sa ON sa.creator_id = c.id
         JOIN campaign cp ON cp.id = m.campaign_id
         LEFT JOIN sender snd ON snd.id = t.sender_id
        WHERE t.state IN ('queued','claimed') ${channel === "all" ? "" : "AND t.channel = $1"}
        ORDER BY t.due_at LIMIT 40`,
      channel === "all" ? [] : [channel]),
    senders("instagram_dm"),
    one<{ n: string }>(`SELECT count(*) AS n FROM outreach_task WHERE state='sent'`),
  ]);

  const byChannel = Object.fromEntries(counts.map((c) => [c.channel, Number(c.n)]));
  const total = counts.reduce((a, b) => a + Number(b.n), 0);

  const tone = (ch: string) =>
    ch === "instagram_dm" ? "k-warn" : ch === "email" ? "k-ok" : "k-acc";

  return (
    <Shell path="/queue" title="작업 큐" sub={`사람이 처리하는 ${fmt(total)}건 · 처리 완료 ${fmt(done?.n)}건`}>
      <section className="screen">
        <div className="filterbar">
          {CHANNELS.map(([k, label]) => (
            <Link key={k} className="chip" href={k === "all" ? "/queue" : `/queue?channel=${k}`} aria-pressed={channel === k} scroll={false}>
              {label} {k === "all" ? total : (byChannel[k] ?? 0)}
            </Link>
          ))}
          <span className="spacer" />
          {dmSenders.map((s) => (
            <span key={s.id} className="senderchip"
                  style={s.paused_until ? { background: "var(--stop-soft)", borderColor: "var(--stop)" } : undefined}>
              <i style={s.paused_until ? { background: "var(--stop)" } : undefined} />
              {s.identifier} {s.paused_until ? "정지" : `${s.sent_today}/${s.current_cap}`}
            </span>
          ))}
        </div>

        <Note tone="warn">
          <b>이 큐는 사람이 처리합니다.</b> Instagram Messaging API 는 상대가 먼저 메시지를 보낸 뒤에야 24시간 창이
          열립니다 — 임의의 핸들에 첫 DM 을 보내는 엔드포인트가 존재하지 않습니다. 시스템은 대상 선별·문안 생성·상한
          강제·기록만 담당합니다. 문안은 복사해서 쓰고, 즉흥 작문은 하지 않습니다.
        </Note>

        <Card title="배급된 작업" hint="완료 처리하면 발신 계정 사용량이 올라가고 메시지 기록이 남습니다">
          {tasks.length === 0 ? <Empty>대기 중인 작업이 없습니다.</Empty> : (
            <Scroller wide>
              <table>
                <thead><tr><th>대상</th><th>채널</th><th>발신</th><th>문안</th><th>예정</th><th>처리</th></tr></thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <IgLink handle={t.handle}><b>@{t.handle}</b></IgLink><br />
                        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{t.display_name} · {fol(t.followers)} · {t.campaign}</span>
                      </td>
                      <td><Pill tone={tone(t.channel)}>{CHANNEL_LABEL[t.channel] ?? t.channel}</Pill></td>
                      <td className="mono">{t.sender ?? "—"}</td>
                      <td style={{ maxWidth: 320, fontSize: 11.5, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>
                        {t.rendered_body.slice(0, 160)}{t.rendered_body.length > 160 ? "…" : ""}
                      </td>
                      <td className="num">{t.due_at}</td>
                      <td>
                        <form action={completeTask}>
                          <input type="hidden" name="id" value={t.id} />
                          <button className="btn sm" type="submit">
                            {t.channel === "instagram_dm" ? "복사 후 완료" : "발송 완료"}
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          )}
        </Card>

        <div className="cols c2">
          <Card title="발송 간격" hint="계정 안전을 위한 분산">
            <div className="card-b">
              <ul className="tight">
                <li>같은 계정의 연속 발송 사이 <b>5~10분 랜덤 간격</b></li>
                <li>업무시간(평일 09~18시 KST) 내에서만 배급 — <code className="mono">nextBusinessSlot()</code></li>
                <li>계정 연령별 상한: <code className="mono">current_cap</code> 이 <code className="mono">daily_cap</code> 까지 3주에 걸쳐 램프업</li>
                <li>문안은 spintax 로 매 건 다른 문장 — 동일 문구 반복이 탐지 신호입니다</li>
              </ul>
            </div>
          </Card>
          <Card title="사고 신고" hint="액션 블록이 뜨면 즉시 신고">
            <div className="card-b">
              <p className="lede" style={{ marginBottom: 12 }}>
                신고 즉시 해당 계정이 24시간 정지되고, 그 계정에 배급된 잔여 작업이 회수되어 다른 계정으로 재배정됩니다.
                서킷브레이커의 <code className="mono">ig_action_block</code> 값도 함께 올라갑니다.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {dmSenders.filter((s) => !s.paused_until).map((s) => (
                  <form action={reportBlock} key={s.id}>
                    <input type="hidden" name="senderId" value={s.id} />
                    <button className="btn danger" type="submit">{s.identifier} 액션 블록 신고</button>
                  </form>
                ))}
                {dmSenders.every((s) => s.paused_until) && (
                  <span style={{ fontSize: 12, color: "var(--ink-3)" }}>모든 DM 계정이 이미 정지 상태입니다.</span>
                )}
              </div>
            </div>
          </Card>
        </div>
      </section>
    </Shell>
  );
}
