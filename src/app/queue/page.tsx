import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Empty, IgLink, Note, Pill, Scroller } from "@/components/ui";
import { all, one } from "@/lib/db";
import { completeTask, reportBlock } from "@/lib/actions";
import { fmt, fol } from "@/lib/format";

export const dynamic = "force-dynamic";

const KINDS: [string, string][] = [
  ["all", "전체"],
  ["ig_dm", "인스타 DM"],
  ["inpock", "인포크 제안"],
  ["reply_check", "회신 확인"],
];

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const sp = await searchParams;
  const kind = KINDS.some((k) => k[0] === sp.kind) ? sp.kind! : "all";

  const counts = Object.fromEntries(
    all<{ kind: string; n: number }>(`SELECT kind, COUNT(*) AS n FROM task WHERE status='pending' GROUP BY kind`).map((r) => [r.kind, r.n]),
  ) as Record<string, number>;
  const totalPending = Object.values(counts).reduce((a, b) => a + b, 0);

  const tasks = all<{
    id: number; kind: string; body: string; scheduled_at: string;
    handle: string; name: string; category: string | null; followers: number | null;
    sender: string | null; sender_status: string | null; camp: string | null; score: number | null;
  }>(
    `SELECT t.id, t.kind, t.body, t.scheduled_at,
            a.handle, c.display_name AS name, c.primary_category AS category,
            (SELECT followers FROM account_snapshot s WHERE s.account_id=a.id ORDER BY s.observed_at DESC LIMIT 1) AS followers,
            sa.identifier AS sender, sa.status AS sender_status,
            cp.name AS camp,
            (SELECT score FROM fit_cache f WHERE f.creator_id=c.id AND f.campaign_id=t.campaign_id) AS score
       FROM task t
       JOIN creator c ON c.id = t.creator_id
       JOIN social_account a ON a.creator_id = c.id AND a.is_primary=1
       LEFT JOIN sender_account sa ON sa.id = t.sender_id
       LEFT JOIN campaign cp ON cp.id = t.campaign_id
      WHERE t.status='pending' ${kind === "all" ? "" : "AND t.kind = ?"}
      ORDER BY t.scheduled_at LIMIT 40`,
    kind === "all" ? [] : [kind],
  );

  const senders = all<{ id: number; identifier: string; sent_today: number; daily_cap: number; status: string }>(
    `SELECT id, identifier, sent_today, daily_cap, status FROM sender_account WHERE channel='ig_dm'`,
  );
  const doneToday = one<{ n: number }>(`SELECT COUNT(*) AS n FROM task WHERE status='done'`)!.n;

  const kindPill = (k: string) =>
    k === "ig_dm" ? <Pill tone="k-warn">IG DM</Pill> : k === "inpock" ? <Pill tone="k-acc">인포크</Pill> : <Pill tone="k-vio">회신 확인</Pill>;

  return (
    <Shell path="/queue" title="작업 큐" sub={`사람이 처리하는 ${fmt(totalPending)}건 · 처리 완료 ${fmt(doneToday)}건`}>
      <section className="screen">
        <div className="filterbar">
          {KINDS.map(([k, label]) => (
            <Link key={k} className="chip" href={k === "all" ? "/queue" : `/queue?kind=${k}`} aria-pressed={kind === k} scroll={false}>
              {label} {k === "all" ? totalPending : (counts[k] ?? 0)}
            </Link>
          ))}
          <span className="spacer" />
          {senders.map((s) => (
            <span
              key={s.id}
              className="senderchip"
              style={s.status === "suspended" ? { background: "var(--stop-soft)", borderColor: "var(--stop)" } : undefined}
            >
              <i style={s.status === "suspended" ? { background: "var(--stop)" } : undefined} />
              {s.identifier} {s.status === "suspended" ? "정지" : `${s.sent_today}/${s.daily_cap}`}
            </span>
          ))}
        </div>

        <Note tone="warn">
          <b>이 큐는 사람이 처리합니다.</b> 인스타 공식 API 로는 콜드 DM 을 보낼 수 없어, 시스템은 대상 선별·문안
          생성·상한 강제·기록만 담당합니다. 문안은 복사해서 쓰고, 즉흥 작문은 하지 않습니다.
        </Note>

        <Card title="배급된 작업" hint="완료 처리하면 발신 계정 사용량이 올라가고 발송 기록이 남습니다">
          {tasks.length === 0 ? (
            <Empty>대기 중인 작업이 없습니다.</Empty>
          ) : (
            <Scroller wide>
              <table>
                <thead>
                  <tr><th>대상</th><th>채널</th><th>발신</th><th>문안</th><th>예정</th><th>처리</th></tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <IgLink handle={t.handle}><b>@{t.handle}</b></IgLink>
                        <br />
                        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                          {t.category ?? "—"} · {fol(t.followers)}
                          {t.score != null ? ` · 적합도 ${t.score}` : ""}
                        </span>
                      </td>
                      <td>{kindPill(t.kind)}</td>
                      <td className="mono">{t.sender ?? "—"}</td>
                      <td style={{ maxWidth: 300, fontSize: 11.5, color: "var(--ink-2)" }}>{t.body}</td>
                      <td className="num">{t.scheduled_at.slice(11)}</td>
                      <td>
                        <form action={completeTask}>
                          <input type="hidden" name="id" value={t.id} />
                          <button className="btn sm" type="submit">
                            {t.kind === "inpock" ? "발송 완료" : t.kind === "reply_check" ? "확인 완료" : "복사 후 완료"}
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
                <li>업무시간(09~18시) 내에서만 배급</li>
                <li>계정 연령별 상한: 30일 미만 10→20 / 30~180일 30 / 180일+ 50</li>
                <li>문안은 spintax 로 매 건 다른 문장 — 동일 문구 반복이 탐지 신호입니다</li>
              </ul>
            </div>
          </Card>
          <Card title="사고 신고" hint="액션 블록이 뜨면 즉시 신고">
            <div className="card-b">
              <p className="lede" style={{ marginBottom: 12 }}>
                신고 즉시 해당 계정이 24시간 정지되고, 그 계정에 배급된 잔여 작업이 회수되어 다른 계정으로 재배정됩니다.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {senders
                  .filter((s) => s.status !== "suspended")
                  .map((s) => (
                    <form action={reportBlock} key={s.id}>
                      <input type="hidden" name="senderId" value={s.id} />
                      <button className="btn danger" type="submit">
                        {s.identifier} 액션 블록 신고
                      </button>
                    </form>
                  ))}
                {senders.every((s) => s.status === "suspended") && (
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
