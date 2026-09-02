import Link from "next/link";
import Shell from "@/components/Shell";
import { Empty, IgLink, Note, Pill } from "@/components/ui";
import { all, one } from "@/lib/db";
import { classifyThread } from "@/lib/actions";
import { fmt, STAGE_TONE } from "@/lib/format";
import { ENGINE_LABEL, INTEREST_CHOICES, INTEREST_LABEL, interestTone } from "@/lib/states";

export const dynamic = "force-dynamic";

const FILTERS: [string, string][] = [["all", "전체"], ["unclassified", "미분류"], ["open", "열린 건"]];

interface ThreadRow {
  member_id: string; thread_key: string | null; reply_token: string | null;
  handle: string; display_name: string; creator_id: string;
  campaign: string; interest_status: number; engine_state: number;
  stage_key: string; stage_label: string; last_at: string; preview: string;
  fit_score: number | null; gmv: string;
}

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ t?: string; f?: string }> }) {
  const sp = await searchParams;
  const filter = FILTERS.some(([k]) => k === sp.f) ? sp.f! : "all";

  const threads = await all<ThreadRow>(
    `SELECT m.id AS member_id, msg.thread_key, m.reply_token,
            sa.handle, c.display_name, c.id AS creator_id,
            cp.name AS campaign, m.interest_status, m.engine_state,
            ps.key AS stage_key, ps.label AS stage_label,
            to_char(msg.last_at,'MM-DD HH24:MI') AS last_at, msg.preview,
            m.fit_score, m.gmv
       FROM campaign_member m
       JOIN creator c ON c.id = m.creator_id
       JOIN social_account sa ON sa.creator_id = c.id
       JOIN campaign cp ON cp.id = m.campaign_id
       JOIN pipeline_stage ps ON ps.id = m.stage_id
       JOIN LATERAL (
         SELECT max(x.sent_at) AS last_at, min(x.thread_key) AS thread_key,
                (array_agg(x.body ORDER BY x.sent_at DESC))[1] AS preview
           FROM message x WHERE x.campaign_member_id = m.id
       ) msg ON msg.last_at IS NOT NULL
      WHERE EXISTS (SELECT 1 FROM message i WHERE i.campaign_member_id=m.id AND i.direction='in')
      ORDER BY msg.last_at DESC LIMIT 60`,
  );

  const shown = threads.filter((t) => {
    if (filter === "unclassified") return !t.interest_status;
    if (filter === "open") return t.engine_state > 0 || t.interest_status >= 0;
    return true;
  });

  const current = shown.find((t) => t.member_id === sp.t) ?? shown[0] ?? threads[0];
  const messages = current
    ? await all<{ direction: string; from_name: string | null; subject: string | null; body: string; sent_at: string; channel: string }>(
        `SELECT direction, from_name, subject, body, to_char(sent_at,'YYYY-MM-DD HH24:MI') AS sent_at, channel
           FROM message WHERE campaign_member_id=$1 ORDER BY sent_at`,
        [current.member_id])
    : [];

  const ctx = current
    ? await one<{ avg_interval_days: string | null; days_since_last: number | null; slots: string; followers: number | null }>(
        `SELECT v.avg_interval_days, v.days_since_last, v.followers,
                (SELECT count(*) FROM deal d WHERE d.creator_id=$1 AND d.status='active'
                   AND NOT d.is_always_on AND d.close_date >= CURRENT_DATE) AS slots
           FROM social_account sa
           LEFT JOIN LATERAL (SELECT * FROM account_snapshot s WHERE s.social_account_id=sa.id ORDER BY s.captured_at DESC LIMIT 1) v ON true
          WHERE sa.creator_id=$1 LIMIT 1`,
        [current.creator_id])
    : undefined;

  const link = (o: { t?: string; f?: string }) => {
    const u = new URLSearchParams();
    const t = o.t ?? current?.member_id;
    if (t) u.set("t", t);
    const f = o.f ?? filter;
    if (f !== "all") u.set("f", f);
    return `/inbox?${u.toString()}`;
  };

  return (
    <Shell path="/inbox" title="통합 인박스" sub={`partner@dinostudio.kr · 회신 스레드 ${fmt(threads.length)}건`}>
      <section className="screen">
        <Note>
          <b>회사 메일 한 개로 돕니다.</b> 발송·수신 모두 <code className="mono">partner@dinostudio.kr</code> 이고,
          Reply-To 의 <code className="mono">partner+cm_&#123;token&#125;@</code> 플러스 주소가 회신을 자동으로
          캠페인·크리에이터에 연결합니다. 매핑 순서는 ① 플러스 주소 토큰 ② Gmail threadId ③ 발신자 이메일입니다.
        </Note>

        <div className="inbox">
          <div className="ilist">
            <div className="ifilter">
              {FILTERS.map(([k, label]) => (
                <Link key={k} className="chip" href={`/inbox?f=${k}`} aria-pressed={filter === k} scroll={false}>
                  {label}{" "}
                  {k === "all" ? threads.length
                    : k === "unclassified" ? threads.filter((t) => !t.interest_status).length
                    : threads.filter((t) => t.engine_state > 0 || t.interest_status >= 0).length}
                </Link>
              ))}
            </div>
            {shown.length === 0 ? <Empty>해당하는 스레드가 없습니다.</Empty> : shown.map((t) => (
              <Link key={t.member_id} className="ithread" href={link({ t: t.member_id })}
                    aria-current={current?.member_id === t.member_id} scroll={false}>
                <div className="r1"><b>{t.display_name}</b><time>{t.last_at}</time></div>
                <p>{t.preview?.split("\n")[0]}</p>
                <Pill tone={interestTone(t.interest_status)}>{INTEREST_LABEL[t.interest_status] ?? "미분류"}</Pill>
              </Link>
            ))}
          </div>

          <div className="iconv">
            {!current ? <Empty>스레드를 선택하세요.</Empty> : (
              <>
                <div className="iconv-h">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b style={{ fontSize: 13.5 }}>{current.display_name}</b>{" "}
                    <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      <IgLink handle={current.handle} />
                    </span>
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      {current.campaign} · Reply-To{" "}
                      <span className="mono">partner+{current.reply_token ?? "cm_?"}@dinostudio.kr</span>
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      threadId {current.thread_key ?? "—"} · 엔진 {ENGINE_LABEL[current.engine_state] ?? current.engine_state}
                    </div>
                  </div>
                  <Pill tone={STAGE_TONE[current.stage_key] ?? "k-mute"}>{current.stage_label}</Pill>
                  <Pill tone={interestTone(current.interest_status)}>{INTEREST_LABEL[current.interest_status] ?? "미분류"}</Pill>
                </div>

                <div className="iconv-b">
                  {messages.map((m, i) => (
                    <div className={`msg ${m.direction}`} key={i}>
                      <div className="mh">
                        <span>{m.from_name ?? (m.direction === "out" ? "Dinostudio" : current.display_name)}</span>
                        <span>{m.sent_at}</span>
                      </div>
                      {m.body}
                    </div>
                  ))}
                </div>

                <form className="iconv-f" action={classifyThread}>
                  <input type="hidden" name="memberId" value={current.member_id} />
                  <select className="sel" name="interest" aria-label="회신 분류" defaultValue={current.interest_status || ""}>
                    <option value="">회신 분류…</option>
                    {INTEREST_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  <button className="btn pri sm" type="submit">분류 저장</button>
                  <span className="spacer" />
                  <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                    {current.engine_state > 0 ? "시퀀스 진행 중" : "시퀀스 종료"}
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
                  <dt>팔로워</dt><dd className="mono">{fmt(ctx?.followers)}</dd>
                  <dt>평균 간격</dt><dd className="mono">{ctx?.avg_interval_days ? `${Math.round(Number(ctx.avg_interval_days))}일` : "—"}</dd>
                  <dt>마지막</dt><dd className="mono">{ctx?.days_since_last != null ? `${ctx.days_since_last}일 전` : "—"}</dd>
                  <dt>진행 슬롯</dt><dd className="mono">{ctx?.slots ?? 0}건</dd>
                </dl>
              </div>
              <div>
                <h5>이 캠페인</h5>
                <dl className="kv" style={{ gridTemplateColumns: "68px 1fr" }}>
                  <dt>스테이지</dt><dd><Pill tone={STAGE_TONE[current.stage_key] ?? "k-mute"}>{current.stage_label}</Pill></dd>
                  <dt>GMV</dt><dd className="mono">{fmt(current.gmv)}원</dd>
                </dl>
              </div>
              <div>
                <h5>분류가 하는 일</h5>
                <ul className="tight" style={{ fontSize: 11.5, paddingLeft: 15 }}>
                  <li><b>3 일정 확정</b> → 스테이지 확정 + 어트리뷰션 토큰 발급</li>
                  <li><b>1·2</b> → 조건 협의로 이동</li>
                  <li><b>-1 지금은 아님</b> → 180일 후 재큐잉 (이탈 아님)</li>
                  <li><b>-4 연락 금지</b> → 핸들·이메일 양쪽 suppression 영구 등재</li>
                  <li><b>-5 부재중</b> → 답장으로 세지 않고 복귀일에 재개</li>
                </ul>
              </div>
              <Link className="btn sm" href={`/influencers?open=${current.creator_id}`}>통합 프로필 열기</Link>
            </div>
          )}
        </div>
      </section>
    </Shell>
  );
}
