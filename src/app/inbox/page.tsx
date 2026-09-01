import Link from "next/link";
import Shell from "@/components/Shell";
import { Empty, IgLink, Note, Pill } from "@/components/ui";
import { all, one } from "@/lib/db";
import { classifyThread } from "@/lib/actions";
import { creatorMetrics } from "@/lib/metrics";
import { fmt, STAGE_LABEL, STAGE_TONE } from "@/lib/format";
import { defaultCampaign } from "@/lib/fit-cache";
import { today } from "@/lib/clock";

export const dynamic = "force-dynamic";

const CLASSIFICATIONS = [
  "1 관심 있음",
  "2 조건 문의",
  "3 일정 확정",
  "-1 지금은 아님 (6개월 후 재큐잉)",
  "-2 관심 없음",
  "-3 담당자 아님 / 소속사",
  "-4 연락 금지 (영구 차단)",
];

const FILTERS: [string, string][] = [
  ["all", "전체"],
  ["unclassified", "미분류"],
  ["open", "열린 건"],
];

function classTone(cls: string | null): [string, string] {
  if (!cls) return ["k-mute", "미분류"];
  const code = cls.split(" ")[0];
  const label = cls.slice(code.length + 1).replace(/\s*\(.*\)$/, "");
  if (code === "3") return ["k-ok", label];
  if (code === "1" || code === "2") return ["k-acc", label];
  if (code === "-1") return ["k-warn", label];
  if (code === "-3") return ["k-vio", label];
  return ["k-stop", label];
}

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ t?: string; f?: string }> }) {
  const sp = await searchParams;
  const filter = FILTERS.some((f) => f[0] === sp.f) ? sp.f! : "all";

  const threads = all<{
    id: number; thread_key: string; classification: string | null; assignee: string | null;
    last_at: string; sla_due_at: string | null; reply_to: string;
    handle: string; name: string; creator_id: number; camp: string | null; campaign_id: number | null;
    preview: string; sequence_state: string;
  }>(
    `SELECT t.id, t.thread_key, t.classification, t.assignee, t.last_at, t.sla_due_at, t.reply_to,
            a.handle, c.display_name AS name, c.id AS creator_id,
            cp.name AS camp, t.campaign_id, t.sequence_state,
            (SELECT body FROM message m WHERE m.thread_id=t.id ORDER BY m.sent_at DESC LIMIT 1) AS preview
       FROM thread t
       JOIN creator c ON c.id=t.creator_id
       JOIN social_account a ON a.creator_id=c.id AND a.is_primary=1
       LEFT JOIN campaign cp ON cp.id=t.campaign_id
      ORDER BY t.last_at DESC`,
  );

  const shown = threads.filter((t) => {
    if (filter === "unclassified") return !t.classification;
    if (filter === "open") return !t.classification || !t.classification.startsWith("-");
    return true;
  });

  const current = shown.find((t) => String(t.id) === sp.t) ?? shown[0] ?? threads[0];
  const messages = current
    ? all<{ direction: string; sender: string; body: string; sent_at: string }>(
        `SELECT direction, sender, body, sent_at FROM message WHERE thread_id=? ORDER BY sent_at`,
        [current.id],
      )
    : [];

  const m = current ? creatorMetrics(current.creator_id) : null;
  const target = current
    ? one<{ stage: string; gmv: number }>(`SELECT stage, gmv FROM campaign_target WHERE campaign_id=? AND creator_id=?`, [
        current.campaign_id,
        current.creator_id,
      ])
    : undefined;
  const fit = current
    ? one<{ score: number; excluded: number }>(`SELECT score, excluded FROM fit_cache WHERE campaign_id=? AND creator_id=?`, [
        current.campaign_id ?? defaultCampaign().id,
        current.creator_id,
      ])
    : undefined;

  const link = (o: { t?: number; f?: string }) => {
    const u = new URLSearchParams();
    if (o.t ?? current?.id) u.set("t", String(o.t ?? current!.id));
    const f = o.f ?? filter;
    if (f !== "all") u.set("f", f);
    return `/inbox?${u.toString()}`;
  };

  return (
    <Shell path="/inbox" title="통합 인박스" sub={`partner@dinostudio.kr · 스레드 ${fmt(threads.length)}건`}>
      <section className="screen">
        <Note>
          <b>회사 메일 한 개로 돕니다.</b> 발송·수신 모두 <code className="mono">partner@dinostudio.kr</code> 이고,
          Reply-To 의 <code className="mono">+cm_&#123;token&#125;</code> 플러스 주소가 회신을 자동으로
          캠페인·크리에이터에 연결합니다. 담당자별 주소를 따로 만들지 않아 대화가 개인 메일함에 흩어지지 않습니다.
        </Note>

        <div className="inbox">
          <div className="ilist">
            <div className="ifilter">
              {FILTERS.map(([k, label]) => (
                <Link key={k} className="chip" href={`/inbox?f=${k}`} aria-pressed={filter === k} scroll={false}>
                  {label}{" "}
                  {k === "all" ? threads.length : k === "unclassified" ? threads.filter((t) => !t.classification).length : threads.filter((t) => !t.classification || !t.classification.startsWith("-")).length}
                </Link>
              ))}
            </div>
            {shown.length === 0 ? (
              <Empty>해당하는 스레드가 없습니다.</Empty>
            ) : (
              shown.map((t) => {
                const [tone, label] = classTone(t.classification);
                return (
                  <Link key={t.id} className="ithread" href={link({ t: t.id })} aria-current={current?.id === t.id} scroll={false}>
                    <div className="r1">
                      <b>{t.name}</b>
                      <time>{t.last_at.slice(5, 16)}</time>
                    </div>
                    <p>{t.preview?.split("\n")[0]}</p>
                    <Pill tone={tone}>{label}</Pill>
                  </Link>
                );
              })
            )}
          </div>

          <div className="iconv">
            {!current ? (
              <Empty>스레드를 선택하세요.</Empty>
            ) : (
              <>
                <div className="iconv-h">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b style={{ fontSize: 13.5 }}>{current.name}</b>{" "}
                    <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      <IgLink handle={current.handle} />
                    </span>
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      {current.camp ?? "미배정"} · Reply-To <span className="mono">{current.reply_to}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)" }} className="mono">
                      threadId {current.thread_key} · 담당 {current.assignee ?? "미배정"}
                    </div>
                  </div>
                  <Pill tone={classTone(current.classification)[0]}>{classTone(current.classification)[1]}</Pill>
                </div>

                <div className="iconv-b">
                  {messages.map((msg, i) => (
                    <div className={`msg ${msg.direction}`} key={i}>
                      <div className="mh">
                        <span>{msg.sender}</span>
                        <span>{msg.sent_at}</span>
                      </div>
                      {msg.body}
                    </div>
                  ))}
                </div>

                <form className="iconv-f" action={classifyThread}>
                  <input type="hidden" name="threadId" value={current.id} />
                  <select className="sel" name="classification" aria-label="회신 분류" defaultValue={current.classification ?? ""}>
                    <option value="">회신 분류…</option>
                    {CLASSIFICATIONS.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <button className="btn pri sm" type="submit">분류 저장</button>
                  <span className="spacer" />
                  <span style={{ fontSize: 11, color: "var(--ink-3)" }} className="mono">
                    {current.sla_due_at ? `SLA ${current.sla_due_at}` : "SLA 없음"}
                  </span>
                </form>
              </>
            )}
          </div>

          {current && (
            <div className="ictx">
              <div>
                <h5>크리에이터</h5>
                <dl className="kv" style={{ gridTemplateColumns: "68px 1fr" }}>
                  <dt>적합도</dt>
                  <dd className="mono">{fit ? (fit.excluded ? "제외" : fit.score) : "—"}</dd>
                  <dt>평균 간격</dt>
                  <dd className="mono">{m?.cadence ? `${Math.round(m.cadence)}일` : "—"}</dd>
                  <dt>마지막</dt>
                  <dd className="mono">{m?.lastDealDays != null ? `${m.lastDealDays}일 전` : "—"}</dd>
                  <dt>진행 슬롯</dt>
                  <dd className="mono">{m?.slots ?? 0}건</dd>
                </dl>
              </div>
              <div>
                <h5>이 캠페인</h5>
                <dl className="kv" style={{ gridTemplateColumns: "68px 1fr" }}>
                  <dt>스테이지</dt>
                  <dd>{target ? <Pill tone={STAGE_TONE[target.stage]}>{STAGE_LABEL[target.stage]}</Pill> : "—"}</dd>
                  <dt>GMV</dt>
                  <dd className="mono">{fmt(target?.gmv ?? 0)}원</dd>
                </dl>
              </div>
              <div>
                <h5>시퀀스</h5>
                <p style={{ margin: 0, color: "var(--ink-2)", lineHeight: 1.6 }}>
                  {current.sequence_state === "stopped_by_reply"
                    ? "회신이 도착해 자동 중단되었습니다. 남은 폴로업은 발송되지 않습니다."
                    : "4스텝 시퀀스가 진행 중입니다. 회신이 오면 즉시 중단됩니다."}
                </p>
              </div>
              <div>
                <h5>분류가 하는 일</h5>
                <ul className="tight" style={{ fontSize: 11.5, paddingLeft: 15 }}>
                  <li><b>3 일정 확정</b> → 스테이지 확정으로 이동</li>
                  <li><b>2 조건 문의</b> → 협의로 이동</li>
                  <li><b>-1 지금은 아님</b> → 6개월 후 재큐잉 (이탈 아님)</li>
                  <li><b>-4 연락 금지</b> → 수신거부 목록에 영구 등록</li>
                </ul>
              </div>
              <Link className="btn sm" href={`/influencers?open=${current.creator_id}`}>
                통합 프로필 열기
              </Link>
            </div>
          )}
        </div>
      </section>
    </Shell>
  );
}
