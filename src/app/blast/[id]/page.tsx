import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/components/Shell";
import { Card, Empty, IgLink, Note, Pill, Scroller } from "@/components/ui";
import { fmt, fol } from "@/lib/format";
import * as B from "@/lib/blast";
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
                    <span>본문</span>
                    <textarea name="body" rows={14} defaultValue={b.body ?? ""}
                              placeholder={"안녕하세요 {{name}} 님,\n\n{{org}} 입니다.\n\n…"} />
                  </label>
                  <div className="foot">
                    <button className="btn pri" type="submit">문안 저장</button>
                    <span className="hint">
                      치환 변수: {B.VARS.map((v) => `{{${v.key}}} ${v.label}`).join(" · ")}
                    </span>
                  </div>
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
                  <dt>제목</dt><dd>{b.subject ?? "—"}</dd>
                </dl>
                <pre className="mono preview">{b.body}</pre>
              </div>
            </Card>

            <Card title={ch.auto ? "발송" : "작업 큐에 넣기"}>
              <SendRunner blastId={id} total={b.target_count} auto={ch.auto} />
            </Card>
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
