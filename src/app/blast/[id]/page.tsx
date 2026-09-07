import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/components/Shell";
import { Card, Empty, IgLink, Note, Pill, Scroller } from "@/components/ui";
import { fmt, fol } from "@/lib/format";
import * as B from "@/lib/blast";
import * as track from "@/lib/tracking";
import SendRunner from "./SendRunner";
import { confirmTargets, goStep, saveContent, saveTargets, testSend } from "../actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 발송 마법사 — 채널 · 대상 · 문안 · 발송 · 결과.
 *
 * 한 화면에 단계만 바뀐다. 캠페인을 먼저 만들고 대상을 담고 시퀀스를 기다리는
 * 기존 흐름은 여러 번에 걸친 아웃리치용으로 남겨 두고, 여기서는 "지금 이
 * 사람들에게 이 내용을 보낸다" 만 한다.
 */

const STEPS: [number, string][] = [
  [1, "발송 방식"], [2, "대상 정리"], [3, "내용 작성"], [4, "발송"], [5, "결과"],
];

export default async function BlastPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ step?: string; msg?: string; kind?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const b = await B.getBlast(id);
  if (!b) notFound();

  const ch = B.channelSpec(b.channel);
  const step = [1, 2, 3, 4, 5].includes(Number(sp.step)) ? Number(sp.step) : 2;

  const [count, preview, boxes, res] = await Promise.all([
    step === 2 ? B.countTargets(b.channel, b.filters) : Promise.resolve(0),
    step === 2 ? B.previewTargets(b.channel, b.filters, 10) : Promise.resolve([]),
    ch.auto ? B.sendableMailboxes() : Promise.resolve([]),
    step >= 4 ? B.results(id) : Promise.resolve(null),
  ]);
  // 4단계는 "실제로 나가는 그대로" 를 보여준다 — 법정 표기까지 붙은 상태로.
  const final = step === 4 ? await B.previewFinal(id) : null;
  const pre = step === 4 ? await B.preflight(id) : null;
  const [tr, links, people] = step === 5
    ? await Promise.all([track.summary(id), track.linkStats(id), track.engaged(id)])
    : [null, [], []];

  const f = b.filters ?? {};

  return (
    <Shell path="/blast" title={b.name} sub={`${ch.label} · ${STEPS[step - 1][1]}`}>
      <section className="screen blast">
        <div className="steps">
          {STEPS.map(([n, label]) => (
            <Link key={n} href={`/blast/${id}?step=${n}`} aria-current={step === n ? "step" : undefined} scroll={false}>
              <b>{n} · {label}</b>
            </Link>
          ))}
        </div>

        {sp.msg && <Note tone={sp.kind === "err" ? "stop" : undefined}>{sp.msg}</Note>}

        {/* ── 2단계 · 대상 ─────────────────────────────── */}
        {step === 2 && (
          <>
            <Card title="발송 대상 고르기" hint={ch.hint}>
              <div className="card-b">
                <form action={saveTargets}>
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="channel" value={b.channel} />

                  <div className="grid">
                    <label className="field">
                      <span>카테고리</span>
                      <select name="category" defaultValue={f.category ?? ""}>
                        <option value="">전체</option>
                        {B.CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </label>

                    <label className="field">
                      <span>최소 팔로워</span>
                      <input name="minFollowers" type="number" min="0" step="1000"
                             defaultValue={f.minFollowers ?? ""} placeholder="예: 5000" />
                    </label>

                    <label className="field">
                      <span>최근 연락 제외 (일)</span>
                      <input name="cooldownDays" type="number" min="0" step="1"
                             defaultValue={f.cooldownDays ?? 30} placeholder="30" />
                    </label>

                    <label className="field">
                      <span>최대 인원</span>
                      <input name="limit" type="number" min="1" step="10"
                             defaultValue={f.limit ?? ""} placeholder="비우면 전체" />
                    </label>

                    <fieldset className="field wide">
                      <span>연락 등급 (티어)</span>
                      <div className="chips">
                        {B.TIERS.map((t) => (
                          <label key={t} className="chk">
                            <input type="checkbox" name="tiers" value={t}
                                   defaultChecked={f.tiers?.includes(t)} />
                            <span>{t}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <label className="chk wide">
                      <input type="checkbox" name="gongguOnly" value="1" defaultChecked={f.gongguOnly} />
                      <span>공구 이력 징후가 있는 대상만</span>
                    </label>

                    {ch.auto && (
                      <label className="field wide">
                        <span>보낼 메일함 *</span>
                        <select name="mailbox" defaultValue={b.mailbox_email ?? ""} required>
                          <option value="">— 고르세요 —</option>
                          {boxes.map((m) => (
                            <option key={m.email} value={m.email}>
                              {m.email}{m.is_default ? " (기본)" : ""}
                            </option>
                          ))}
                        </select>
                        {boxes.length === 0 && (
                          <small style={{ color: "var(--stop)" }}>
                            등록된 메일함이 없습니다. <a href="/settings">설정</a> 에서 먼저 등록하세요.
                          </small>
                        )}
                      </label>
                    )}
                  </div>

                  <div className="foot">
                    <button className="btn" type="submit">조건 적용 · 인원 세기</button>
                    <span className="hint">
                      수신거부·연락 금지 대상은 어떤 조건에서도 제외됩니다. 조건을 바꾸면{" "}
                      <b>이 버튼을 눌러야</b> 아래 인원수와 확정 대상에 반영됩니다.
                    </span>
                  </div>
                </form>
              </div>
            </Card>

            <Card
              title="대상 확인"
              hint={`조건에 맞는 ${fmt(count)}명 · 팔로워 상위 ${preview.length}명 미리보기`}
              right={
                count > 0 ? (
                  <form action={confirmTargets}>
                    <input type="hidden" name="id" value={id} />
                    <button className="btn pri" type="submit">{fmt(count)}명으로 확정 →</button>
                  </form>
                ) : undefined
              }
            >
              {preview.length === 0 ? (
                <div className="card-b"><Empty>조건에 맞는 대상이 없습니다. 필터를 넓혀 보세요.</Empty></div>
              ) : (
                <Scroller wide>
                  <table>
                    <thead><tr><th>크리에이터</th><th>팔로워</th><th>티어</th><th>카테고리</th><th>연락처</th></tr></thead>
                    <tbody>
                      {preview.map((r) => (
                        <tr key={r.creator_id}>
                          <td><IgLink handle={r.handle}><b>@{r.handle}</b></IgLink></td>
                          <td className="num">{fol(r.followers)}</td>
                          <td>{r.outreach_tier ?? "—"}</td>
                          <td style={{ fontSize: 11.5 }}>{r.categories ?? "—"}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{r.contact ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroller>
              )}
            </Card>
          </>
        )}

        {/* ── 3단계 · 내용 ─────────────────────────────── */}
        {step === 3 && (
          <>
            {/*
              문안과 테스트 발송을 한 폼에 둔다. 폼을 나누면 테스트가 "저장된"
              문안으로 나가서, 방금 고친 문장이 아닌 것을 확인하게 된다.
              버튼마다 formAction 으로 갈라 보낸다.
            */}
            <form action={saveContent}>
              <input type="hidden" name="id" value={id} />

              <Card title="보낼 내용" hint={`확정 대상 ${fmt(b.target_count)}명`}>
                <div className="card-b">
                  {ch.auto && (
                    <label className="field">
                      <span>제목</span>
                      <input name="subject" defaultValue={b.subject ?? ""}
                             placeholder="{{name}} 님, 9월 리빙 공구 제안드립니다" />
                    </label>
                  )}
                  <label className="field" style={{ marginTop: 10 }}>
                    <span>본문 (텍스트)</span>
                    <textarea name="body" rows={10} defaultValue={b.body ?? ""}
                              placeholder={"안녕하세요 {{name}} 님,\n\n{{org}} 입니다.\n\n…"} />
                    <small style={{ color: "var(--ink-3)", fontSize: 11 }}>
                      비워 두고 아래 HTML 만 쓰면 텍스트 버전을 자동으로 만들어 줍니다.
                    </small>
                  </label>

                  <label className="field" style={{ marginTop: 12 }}>
                    <span>본문 (HTML · 이미지)</span>
                    <textarea name="html" rows={12} defaultValue={b.body_html ?? ""}
                              placeholder={'<p>안녕하세요 {{name}} 님,</p>\n<p><img src="https://…/banner.jpg" alt="9월 리빙 공구" width="560" /></p>\n<p><a href="https://…">상세 보기</a></p>'} />
                    <small style={{ color: "var(--ink-3)", fontSize: 11 }}>
                      채우면 HTML 과 텍스트를 함께 보냅니다 (multipart/alternative). 이미지는{" "}
                      <code className="mono">&lt;img src=&quot;https://…&quot;&gt;</code> 로 넣으세요.
                    </small>
                  </label>
                  <div className="foot">
                    <button className="btn pri" type="submit">문안 저장</button>
                    <span className="hint">
                      치환 변수: {B.VARS.map((v) => `{{${v.key}}} ${v.label}`).join(" · ")}
                    </span>
                  </div>
                </div>
              </Card>

              <Card title="이미지 넣는 법" hint="첨부·base64 대신 링크로">
                <div className="card-b">
                  <Note tone="warn">
                    <b>이미지를 메일에 끼워 넣지 마세요.</b> base64 로 본문에 박거나 첨부로 붙이면 용량이
                    커지고 스팸 판정이 크게 나빠집니다. 이미지는 <b>어딘가에 올려 두고 주소로 참조</b>하는
                    것이 표준입니다 — 위 HTML 칸에{" "}
                    <code className="mono">&lt;img src=&quot;https://…&quot; width=&quot;560&quot; alt=&quot;설명&quot;&gt;</code>.
                    <br /><br />
                    올릴 곳이 없으면 인스타 게시물 이미지 주소나 브랜드가 준 상세페이지 이미지를 쓰면
                    됩니다. <b>alt 는 반드시 넣으세요</b> — 대다수 메일 클라이언트가 이미지를 기본
                    차단하므로, alt 가 없으면 받는 사람에게 빈 사각형만 보입니다. 텍스트 본문만으로도
                    말이 되게 쓰는 것이 안전합니다.
                  </Note>
                </div>
              </Card>

              <Card title="열람 · 클릭 추적" hint="켜면 도달률이 떨어집니다">
                <div className="card-b">
                  <div className="chips" style={{ marginBottom: 10, gap: 18 }}>
                    <label className="chk">
                      <input type="checkbox" name="trackOpens" value="1" defaultChecked={b.track_opens} />
                      <span>열람 추적 (1x1 픽셀)</span>
                    </label>
                    <label className="chk">
                      <input type="checkbox" name="trackClicks" value="1" defaultChecked={b.track_clicks} />
                      <span>클릭 추적 (링크 치환)</span>
                    </label>
                  </div>
                  <Note tone="warn">
                    <b>둘 다 기본 꺼짐입니다. 켜면 스팸 판정이 나빠집니다.</b>
                    <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.9 }}>
                      <li>
                        <b>열람 추적</b>은 1x1 투명 이미지를 숨겨 넣는 방식이라 필터가 싫어합니다. Gmail 은
                        이미지를 자기 프록시로 받아 캐시하므로 수치가 부풀고, 이미지 차단 설정에서는 아예
                        잡히지 않습니다 — <b>정확한 값이 아니라 방향만 보는 지표</b>입니다.
                      </li>
                      <li>
                        <b>클릭 추적</b>은 링크를 우리 도메인으로 바꿔치기하므로, 원 도메인의 평판 대신 갓
                        만든 우리 도메인 평판이 걸립니다. 대신 열람보다 훨씬 정확합니다.
                      </li>
                    </ul>
                    <br />
                    첫 몇 번은 둘 다 끄고 도달률부터 확보하시고, 안정되면 <b>클릭만</b> 켜는 순서를
                    권합니다. HTML 본문이 없으면 둘 다 동작하지 않습니다 (텍스트 메일에는 넣을 자리가 없습니다).
                  </Note>
                </div>
              </Card>

              <Card title="광고성 정보 표기" hint="도달률과 법규가 정면으로 부딪히는 자리입니다">
                <div className="card-b">
                  <label className="chk" style={{ marginBottom: 10 }}>
                    <input type="checkbox" name="isAd" value="1" defaultChecked={b.is_ad} />
                    <span><b>영리목적 광고성 정보입니다</b> — 제목에 (광고), 본문에 수신거부 안내를 붙입니다</span>
                  </label>
                  <Note tone="warn">
                    <b>이건 형이 판단해야 하는 항목입니다.</b> 네이버·다음·Gmail 은 제목의 <code className="mono">(광고)</code>
                    를 보고 광고·스팸함으로 보냅니다 — 필터의 <b>의도된 동작</b>입니다. 그래서 표기를 붙이면
                    대다수가 광고함으로 가고, 떼면 도달률은 오르지만 정보통신망법 §50 위반 위험을 집니다
                    (수신 동의 없는 영리목적 광고성 정보는 제목에 (광고) 표기가 필수, 위반 시 과태료).
                    둘 다 만족하는 선택지는 없습니다.
                    <br /><br />
                    판단 기준은 <b>내용</b>입니다. 상품·할인·판매를 알리는 메일이면 광고성 정보입니다. 특정
                    크리에이터에게 개별 조건으로 제휴를 문의하는 1:1 거래 제안은 다르게 볼 여지가 있지만,
                    그 판단은 법률 검토를 받으시는 편이 안전합니다. 애매하면 켜 두세요.
                  </Note>
                </div>
              </Card>

              <Card title="테스트 발송" hint="실제 대상이 아니라 우리가 받아봅니다">
                <div className="card-b">
                  <div className="filterbar" style={{ gap: 8 }}>
                    <input name="to" type="email" placeholder="받을 주소 (내 메일)" aria-label="테스트 수신 주소" />
                    <button className="btn" type="submit" formAction={testSend}>
                      위 문안으로 한 통 보내기
                    </button>
                  </div>
                  <Note>
                    <b>지금 화면에 있는 문안</b>을 그대로 보냅니다 (저장도 같이 됩니다). 치환 변수는{" "}
                    <b>첫 대상의 실제 값</b>으로 채웁니다 — 빈 칸으로 보내면{" "}
                    <code className="mono">{"{{name}}"} 님</code> 이 그대로 나가는지 알 수 없습니다.
                    {!ch.auto && <> 이 채널은 자동 발송이 아니지만, 문안 확인용으로 메일로 보내 드립니다.</>}
                  </Note>
                  <Note tone="warn">
                    <b>우리 도메인 주소로 테스트하면 스팸 판정을 확인할 수 없습니다.</b> 같은 Workspace 안에서
                    주고받는 메일은 필터를 거의 거치지 않고 들어옵니다 — 통로가 열렸다는 것만 알려주고,
                    실제로 받은편지함에 꽂히는지는 알려주지 않습니다. <b>네이버·다음·Gmail 주소</b> 각각으로
                    한 통씩 보내서 어느 폴더에 들어가는지 직접 확인하세요.
                  </Note>
                </div>
              </Card>
            </form>

            <div className="foot">
              <form action={goStep}>
                <input type="hidden" name="id" value={id} />
                <input type="hidden" name="step" value="4" />
                <button className="btn pri" type="submit" disabled={!b.body?.trim()}>발송 단계로 →</button>
              </form>
              {!b.body?.trim() && <span className="hint">본문을 저장해야 넘어갈 수 있습니다.</span>}
            </div>
          </>
        )}

        {/* ── 4단계 · 발송 ─────────────────────────────── */}
        {step === 4 && (
          <>
            <Card title="발송 전 확인">
              <div className="card-b">
                <dl className="kv" style={{ gridTemplateColumns: "104px 1fr" }}>
                  <dt>방식</dt><dd>{ch.label}{ch.auto ? " · 자동 발송" : " · 작업 큐"}</dd>
                  <dt>대상</dt><dd><b>{fmt(b.target_count)}명</b></dd>
                  {ch.auto && <><dt>발신함</dt><dd className="mono">{b.mailbox_email ?? "기본 발신함"}</dd></>}
                  <dt>제목</dt><dd>{final?.subject ?? b.subject ?? "—"}</dd>
                </dl>
                <pre className="mono preview">{final?.body ?? b.body}</pre>
                {final?.html && (
                  <>
                    <div className="kv" style={{ marginTop: 14, gridTemplateColumns: "104px 1fr" }}>
                      <dt>HTML</dt>
                      <dd>
                        보냅니다 (multipart/alternative)
                        {b.track_opens && " · 열람 추적 켜짐"}
                        {b.track_clicks && " · 클릭 추적 켜짐"}
                      </dd>
                    </div>
                    <pre className="mono preview" style={{ maxHeight: 220 }}>{final.html}</pre>
                  </>
                )}
                {ch.auto && (
                  <Note>
                    <b>(광고) 표기와 수신거부 안내는 자동으로 붙습니다</b> — 정보통신망법 §50 이고, 빼면
                    과태료 대상이며 Gmail·네이버가 스팸으로 분류합니다. 위 미리보기가 실제로 나가는
                    그대로이며, 치환 값은 첫 대상의 것입니다.
                  </Note>
                )}
                {final?.warnings.length ? (
                  <Note tone="warn">{final.warnings.join(" · ")}</Note>
                ) : null}
              </div>
            </Card>

            {pre && !pre.ok ? (
              <Card title="발송할 수 없습니다" hint="아래를 먼저 채우세요">
                <div className="card-b">
                  <Note tone="stop">
                    <b>{pre.blockers.length}가지가 막고 있습니다.</b>
                    <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.9 }}>
                      {pre.blockers.map((x) => <li key={x}>{x}</li>)}
                    </ul>
                  </Note>
                  <a className="btn pri" href="/settings">설정 열기 →</a>
                </div>
              </Card>
            ) : (
              <Card title={ch.auto ? "발송" : "작업 큐에 넣기"}>
                {pre?.warnings.length ? (
                  <div className="card-b" style={{ paddingBottom: 0 }}>
                    <Note tone="warn">{pre.warnings.join(" · ")}</Note>
                  </div>
                ) : null}
                <SendRunner blastId={id} total={b.target_count} auto={ch.auto} />
              </Card>
            )}
          </>
        )}

        {/* ── 5단계 · 결과 ─────────────────────────────── */}
        {step === 5 && res && (
          <>
            <Card title="발송 결과" hint={b.sent_at ? `${b.sent_at} 발송` : undefined}>
              <div className="card-b">
                <div className="kpis">
                  {[
                    ["발송 완료", res.sent],
                    ["작업 큐", res.queued],
                    ["dry-run", res.dryRun],
                    ["회신", res.replied],
                    ["반송", res.bounced],
                    ["수신거부", res.optedOut],
                  ].map(([label, n]) => (
                    <div className="kpi" key={String(label)}>
                      <span>{label}</span>
                      <b className="mono">{fmt(n as number)}</b>
                    </div>
                  ))}
                </div>
                {res.dryRun > 0 && (
                  <Note tone="warn">
                    <b>{fmt(res.dryRun)}건이 dry-run 입니다 — 실제로 나가지 않았습니다.</b>{" "}
                    <code className="mono">GOOGLE_SA_KEY_JSON</code> 이 없거나 발신함이 지정되지 않았습니다.{" "}
                    <a href="/settings">설정</a> 에서 확인하세요.
                  </Note>
                )}
                {res.queued > 0 && (
                  <Note>
                    작업 큐에 {fmt(res.queued)}건이 쌓였습니다. <a href="/queue">작업 큐</a> 에서 문안을 복사해
                    상대 폼에 붙여넣으세요.
                  </Note>
                )}
              </div>
            </Card>

            {(b.track_opens || b.track_clicks) && tr && (
              <Card title="열람 · 클릭" hint={`발송 ${fmt(tr.sent)}건 기준`}>
                <div className="card-b">
                  <div className="kpis">
                    {[
                      ["열람한 사람", tr.opened, tr.sent ? `${Math.round((tr.opened / tr.sent) * 100)}%` : null],
                      ["열람 횟수", tr.openEvents, null],
                      ["클릭한 사람", tr.clicked, tr.sent ? `${Math.round((tr.clicked / tr.sent) * 100)}%` : null],
                      ["클릭 횟수", tr.clickEvents, null],
                    ].map(([label, n, pct]) => (
                      <div className="kpi" key={String(label)}>
                        <span>{label}</span>
                        <b className="mono">{fmt(n as number)}</b>
                        {pct ? <em>{pct as string}</em> : null}
                      </div>
                    ))}
                  </div>
                  <Note>
                    열람 수는 <b>정확한 값이 아닙니다</b> — Gmail 이 이미지를 프록시로 캐시하면 부풀고,
                    이미지 차단 설정에서는 열어도 잡히지 않습니다. 클릭이 훨씬 믿을 만한 신호입니다.
                  </Note>
                </div>
              </Card>
            )}

            {links.length > 0 && (
              <Card title="링크별 클릭" hint="무엇을 눌렀는지가 열람률보다 쓸모 있습니다">
                <Scroller wide>
                  <table>
                    <thead><tr><th>링크</th><th>클릭 수</th><th>누른 사람</th></tr></thead>
                    <tbody>
                      {links.map((l) => (
                        <tr key={l.url}>
                          <td className="mono" style={{ fontSize: 11 }}>{l.url}</td>
                          <td className="num">{fmt(l.clicks)}</td>
                          <td className="num">{fmt(l.people)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroller>
              </Card>
            )}

            {people.length > 0 && (
              <Card title="반응한 대상" hint="회신이 없어도 관심 있는 사람을 골라낼 수 있습니다">
                <Scroller wide>
                  <table>
                    <thead><tr><th>크리에이터</th><th>열람</th><th>클릭</th><th>첫 열람</th><th>마지막 클릭</th></tr></thead>
                    <tbody>
                      {people.map((x) => (
                        <tr key={x.handle}>
                          <td><IgLink handle={x.handle}><b>@{x.handle}</b></IgLink></td>
                          <td className="num">{fmt(x.opens)}</td>
                          <td className="num">{x.clicks > 0 ? <b style={{ color: "var(--ok)" }}>{fmt(x.clicks)}</b> : "—"}</td>
                          <td className="num">{x.first_open ?? "—"}</td>
                          <td className="num">{x.last_click ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroller>
              </Card>
            )}

            <Card title="회신 확인" hint="회신은 통합 인박스로 자동 매핑됩니다">
              <div className="card-b">
                <p className="lede" style={{ margin: "0 0 12px" }}>
                  회신이 오면 Reply-To 플러스 주소의 토큰으로 어느 대상인지 즉시 붙습니다. 부재중 자동응답은
                  답장으로 세지 않습니다.
                </p>
                <a className="btn pri" href="/inbox">통합 인박스 열기 →</a>
              </div>
            </Card>
          </>
        )}
      </section>
    </Shell>
  );
}
