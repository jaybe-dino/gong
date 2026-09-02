import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Empty, Funnel, Note, Pill, Scroller } from "@/components/ui";
import { startSend } from "@/lib/actions";
import { defaultCampaign, getCampaign, listCampaigns } from "@/lib/queries";
import { evaluateCandidate, loadCampaignInfo, loadGateInputs, loadSendCandidates } from "@/lib/outreach";
import { CHECK_LABEL } from "@/lib/policy-gate";
import { CHANNEL_LABEL, fmt } from "@/lib/format";

export const dynamic = "force-dynamic";

const STEPS: [number, string, string][] = [
  [1, "1 · 대상", "세그먼트 확정"],
  [2, "2 · 문안", "템플릿 · 미리보기"],
  [3, "3 · 발송", "정책 게이트 통과"],
];

export default async function SendPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; campaign?: string; sent?: string; blocked?: string; tasks?: string }>;
}) {
  const sp = await searchParams;
  const campaign = sp.campaign ? await getCampaign(sp.campaign) : await defaultCampaign();
  const step = [1, 2, 3].includes(Number(sp.step)) ? Number(sp.step) : 1;
  const campaigns = await listCampaigns();

  if (!campaign) {
    return <Shell path="/send" title="제안 발송"><section className="screen"><Card><Empty>캠페인이 없습니다.</Empty></Card></section></Shell>;
  }

  const info = (await loadCampaignInfo(campaign.id))!;
  const [inputs, candidates] = await Promise.all([loadGateInputs(), loadSendCandidates(campaign.id)]);
  const now = new Date();
  const evaluated = candidates.map((c) => evaluateCandidate(c, info, inputs, now));

  const passed = evaluated.filter((e) => e.gate.ok);
  const autoSend = passed.filter((e) => e.policy.automation_mode === "auto");
  const manual = passed.filter((e) => e.policy.automation_mode === "manual_task");
  const blocked = evaluated.filter((e) => !e.gate.ok);

  // 막힌 사유별 집계 — 게이트 순서대로 줄어드는 퍼널이 된다.
  const byCheck = new Map<string, number>();
  for (const e of blocked) byCheck.set(e.gate.blocked!.check, (byCheck.get(e.gate.blocked!.check) ?? 0) + 1);
  const CHECK_ORDER = ["circuit_breaker", "suppression", "consent", "channel_cold", "night_window", "sender_cap", "cooldown", "ad_label", "unsubscribe"];
  let running = candidates.length;
  const funnel = [{ label: "캠페인 대상", count: running, sub: undefined as string | undefined }];
  for (const ch of CHECK_ORDER) {
    const n = byCheck.get(ch) ?? 0;
    if (!n) continue;
    running -= n;
    funnel.push({ label: `− ${CHECK_LABEL[ch] ?? ch}`, count: running, sub: `−${n}` });
  }
  funnel.push({ label: "최종 발송 대상", count: passed.length, sub: undefined });

  const sample = passed[0] ?? evaluated[0];
  const gateSample = sample?.gate;
  const stepLink = (n: number) => `/send?step=${n}&campaign=${campaign.id}`;
  const cap = inputs.sender ? Math.max(0, inputs.sender.current_cap - inputs.sender.sent_today) : 0;
  const days = cap > 0 ? Math.ceil(autoSend.length / cap) : 0;

  return (
    <Shell path="/send" title="제안 발송" sub={campaign.name}>
      <section className="screen">
        <div className="steps">
          {STEPS.map(([n, a, b]) => (
            <Link key={n} href={stepLink(n)} aria-current={step === n ? "step" : undefined} scroll={false}>
              <b>{a}</b><span>{b}</span>
            </Link>
          ))}
        </div>

        {sp.sent != null && (
          <Note>
            <b>{fmt(sp.sent)}건을 발송했고 {fmt(sp.tasks ?? 0)}건을 작업 큐로 보냈습니다.</b>{" "}
            게이트에 막힌 {fmt(sp.blocked ?? 0)}건은 <Link href="/policy">채널 정책 화면의 차단 기록</Link>에서 사유를 볼 수 있습니다.
          </Note>
        )}

        <form className="filterbar" method="get" action="/send">
          <input type="hidden" name="step" value={step} />
          <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>캠페인</span>
          <select className="sel" name="campaign" defaultValue={campaign.id} aria-label="캠페인">
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="btn sm" type="submit">적용</button>
        </form>

        {step === 1 && (
          <>
            <div className="cols c2">
              <Card title="세그먼트" hint={campaign.name}>
                <div className="card-b">
                  <dl className="kv">
                    <dt>대상</dt><dd>이 캠페인의 <code className="mono">engine_state &gt; 0</code> 멤버 {fmt(candidates.length)}명</dd>
                    <dt>카테고리</dt><dd>{campaign.category}</dd>
                    <dt>기간</dt><dd>{campaign.sale_from} ~ {campaign.sale_to}</dd>
                    <dt>수수료</dt><dd>{campaign.commission_rate ? `${Number(campaign.commission_rate)}%` : "협의"}</dd>
                    <dt>게이트</dt><dd>8단계 · 하나라도 실패하면 발송하지 않고 사유를 남깁니다</dd>
                  </dl>
                  <div style={{ marginTop: 14 }}>
                    <Note>
                      대상 선별은 <Link href="/campaigns">캠페인 화면</Link>에서 적합도·타이밍을 보고 담습니다.
                      이 화면은 <b>담긴 대상이 실제로 나갈 수 있는지</b>만 판정합니다.
                    </Note>
                  </div>
                </div>
              </Card>

              <Card title="대상 산출" hint="지금 DB 를 실제로 훑어 게이트를 돌린 결과입니다">
                <div className="card-b">
                  {candidates.length === 0 ? <Empty>이 캠페인에 살아 있는 대상이 없습니다.</Empty> : (
                    <Funnel steps={funnel.map((f, i) => ({ ...f, strong: i === funnel.length - 1 }))} />
                  )}
                </div>
              </Card>
            </div>

            <Card title="채널 분배" hint="channel_policy 의 automation_mode 가 실행 방식을 결정합니다">
              <Scroller wide>
                <table>
                  <thead><tr><th>채널</th><th>대상</th><th>실행</th><th>오늘 가용</th><th>소요</th></tr></thead>
                  <tbody>
                    <tr>
                      <td>이메일</td><td className="num">{fmt(autoSend.length)}</td>
                      <td><Pill tone="k-ok">자동 시퀀스</Pill></td>
                      <td className="num">{cap} ({inputs.sender?.identifier ?? "계정 없음"})</td>
                      <td className="num">{days || "—"}일</td>
                    </tr>
                    {["instagram_dm", "inpock_offer", "linktree_form"].map((ch) => {
                      const n = manual.filter((e) => e.channel === ch).length;
                      if (!n) return null;
                      return (
                        <tr key={ch}>
                          <td>{CHANNEL_LABEL[ch]}</td><td className="num">{fmt(n)}</td>
                          <td><Pill tone="k-warn">작업 큐 (사람)</Pill></td>
                          <td>—</td><td>—</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Scroller>
            </Card>

            {blocked.length > 0 && (
              <Card title="막힌 대상" hint={`${fmt(blocked.length)}명 · 사유별`}>
                <Scroller>
                  <table>
                    <thead><tr><th>막힌 검사</th><th>인원</th><th>예시 사유</th></tr></thead>
                    <tbody>
                      {[...byCheck.entries()].sort((a, b) => b[1] - a[1]).map(([check, n]) => (
                        <tr key={check}>
                          <td><Pill tone="k-stop">{CHECK_LABEL[check] ?? check}</Pill></td>
                          <td className="num">{fmt(n)}</td>
                          <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                            {blocked.find((e) => e.gate.blocked!.check === check)?.gate.blocked!.detail}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroller>
              </Card>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <Link className="btn pri" href={stepLink(2)}>문안 확인</Link>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="cols c2">
              <Card title="템플릿" hint="렌더러가 실제로 만드는 문안입니다">
                <div className="card-b">
                  <ul className="tight">
                    <li>변수 치환 <code className="mono">{"{{name}}"}</code> <code className="mono">{"{{cadence}}"}</code> <code className="mono">{"{{last_gb_brand}}"}</code></li>
                    <li>Spintax <code className="mono">{"{{RANDOM|안녕하세요|반갑습니다}}"}</code> — 수신자마다 문장이 달라집니다</li>
                    <li>(광고) 표기 · 전송자 정보 · 수신거부는 <b>렌더러가 붙입니다</b>. 템플릿에서 지울 수 없습니다</li>
                    <li>&quot;광/고&quot;, &quot;AD&quot; 같은 변칙 표기가 감지되면 렌더러가 <b>예외를 던져 발송을 막습니다</b></li>
                  </ul>
                  {sample?.rendered && (
                    <div style={{ marginTop: 14 }}>
                      <Note>
                        <b>주입된 헤더</b>
                        <br />
                        {Object.entries(sample.rendered.headers).map(([k, v]) => (
                          <code className="mono" key={k} style={{ display: "block", fontSize: 11 }}>{k}: {v}</code>
                        ))}
                        {Object.keys(sample.rendered.headers).length === 0 && "이 채널은 수신거부 헤더가 필요 없습니다."}
                      </Note>
                    </div>
                  )}
                </div>
              </Card>

              <div className="mailbox">
                <div className="mailhead">
                  <div><b>보내는 사람</b>{" "}
                    <span className="mono">{inputs.sender?.display_name ?? "Dinostudio"} &lt;{inputs.sender?.identifier ?? "partner@dinostudio.kr"}&gt;</span></div>
                  <div><b>Reply-To</b> <code>partner+cm_&#123;token&#125;@dinostudio.kr</code></div>
                  <div><b>제목</b> {sample?.rendered?.subject ?? "(제목 없음)"}</div>
                  {sample && <div style={{ fontSize: 11, color: "var(--ink-3)" }}>미리보기 대상 @{sample.cand.handle}</div>}
                </div>
                <div className="mailbody">{sample?.rendered?.body ?? "렌더링할 대상이 없습니다."}</div>
                {sample?.rendered?.warnings.length ? (
                  <div className="mailfoot">
                    {sample.rendered.warnings.map((w, i) => <div key={i} style={{ color: "var(--warn)" }}>⚠ {w}</div>)}
                  </div>
                ) : null}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Link className="btn" href={stepLink(1)}>이전</Link>
              <Link className="btn pri" href={stepLink(3)}>정책 게이트 검사</Link>
            </div>
          </>
        )}

        {step === 3 && (
          <div className="cols c2">
            <Card title="정책 게이트" hint="8단계 · 전부 통과해야 발송됩니다">
              <div className="card-b">
                {!gateSample ? <Empty>평가할 대상이 없습니다.</Empty> : (
                  <div className="gate">
                    {gateSample.passed.map((p) => (
                      <div className="grow" key={p.check}>
                        <span className="gmark p">✓</span>
                        <span>{CHECK_LABEL[p.check] ?? p.check}</span>
                        <Pill tone="k-ok">{p.note}</Pill>
                      </div>
                    ))}
                    {gateSample.blocked && (
                      <div className="grow">
                        <span className="gmark b">✕</span>
                        <span>{CHECK_LABEL[gateSample.blocked.check] ?? gateSample.blocked.check}</span>
                        <Pill tone="k-stop">{gateSample.blocked.detail}</Pill>
                      </div>
                    )}
                  </div>
                )}
                {gateSample?.warnings.length ? (
                  <div style={{ marginTop: 12 }}>
                    <Note tone="warn">{gateSample.warnings.join(" · ")}</Note>
                  </div>
                ) : null}
              </div>
            </Card>

            <Card title="발송 계획">
              <div className="card-b">
                <dl className="kv">
                  <dt>자동 발송</dt><dd><b>{fmt(autoSend.length)}명</b> (이메일)</dd>
                  <dt>작업 큐</dt><dd>{fmt(manual.length)}명 (사람이 처리)</dd>
                  <dt>게이트 차단</dt><dd>{fmt(blocked.length)}명</dd>
                  <dt>발신 계정</dt><dd>{inputs.sender?.identifier ?? "없음"} · 오늘 가용 {cap}건</dd>
                  <dt>발송 시간</dt><dd>평일 09:00 ~ 18:00 KST</dd>
                  <dt>완료 예상</dt><dd>{days <= 1 ? "오늘" : `${days}일`}</dd>
                </dl>
                <div style={{ marginTop: 14 }}>
                  <Note>
                    발송 시점에 게이트를 <b>한 번 더</b> 돌립니다. 이 화면을 보는 사이 수신거부가 등재될 수 있기
                    때문입니다. 막힌 건은 <code className="mono">gate_block</code> 에 사유가 남습니다.
                  </Note>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <Link className="btn" href={stepLink(2)}>이전</Link>
                  <form action={startSend}>
                    <input type="hidden" name="campaignId" value={campaign.id} />
                    <button className="btn pri" type="submit" disabled={passed.length === 0}>
                      {passed.length === 0 ? "발송할 대상이 없습니다" : `${fmt(passed.length)}건 발송 시작`}
                    </button>
                  </form>
                </div>
              </div>
            </Card>
          </div>
        )}
      </section>
    </Shell>
  );
}
