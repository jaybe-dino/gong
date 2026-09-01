import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Funnel, Note, Pill, Scroller } from "@/components/ui";
import { all, one } from "@/lib/db";
import { startSend } from "@/lib/actions";
import { defaultCampaign } from "@/lib/fit-cache";
import { buildSegment, DEFAULT_SEGMENT, runGate } from "@/lib/policy";
import { fmt } from "@/lib/format";
import { addDays, today } from "@/lib/clock";

export const dynamic = "force-dynamic";

const STEPS: [number, string, string][] = [
  [1, "1 · 대상", "세그먼트 확정"],
  [2, "2 · 문안", "템플릿 · 미리보기"],
  [3, "3 · 발송", "정책 게이트 통과"],
];

export default async function SendPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; campaign?: string; sent?: string; blocked?: string }>;
}) {
  const sp = await searchParams;
  const ref = today();
  const campaign = defaultCampaign(sp.campaign ? Number(sp.campaign) : undefined);
  const step = [1, 2, 3].includes(Number(sp.step)) ? Number(sp.step) : 1;

  const seg = buildSegment(campaign, DEFAULT_SEGMENT, ref);
  const gate = runGate(seg, "email");

  const brand = one<{ name: string; commission_pct: number | null; starts_on: string; ends_on: string }>(
    `SELECT b.name, c.commission_pct, c.starts_on, c.ends_on FROM campaign c LEFT JOIN brand b ON b.id=c.brand_id WHERE c.id=?`,
    [campaign.id],
  );
  const sender = one<{ identifier: string }>(`SELECT identifier FROM sender_account WHERE channel='email' AND status='ok' ORDER BY id LIMIT 1`);
  const token = one<{ reply_token: string }>(`SELECT reply_token FROM campaign WHERE id=?`, [campaign.id])!.reply_token;
  const senders = all<{ identifier: string; daily_cap: number; sent_today: number }>(
    `SELECT identifier, daily_cap, sent_today FROM sender_account WHERE channel='email' AND status!='suspended'`,
  );

  const stepLink = (n: number) => `/send?step=${n}&campaign=${campaign.id}`;
  const emailN = seg.byChannel.email.length;
  const dmN = seg.byChannel.ig_dm.length;
  const inpockN = seg.byChannel.inpock.length;
  const noContact = seg.dropped.filter((d) => d.reason === "연락처 없음").length;

  return (
    <Shell path="/send" title="제안 발송" sub={campaign.name}>
      <section className="screen">
        <div className="steps">
          {STEPS.map(([n, a, b]) => (
            <Link key={n} href={stepLink(n)} aria-current={step === n ? "step" : undefined} scroll={false}>
              <b>{a}</b>
              <span>{b}</span>
            </Link>
          ))}
        </div>

        {sp.sent && (
          <Note>
            <b>{fmt(Number(sp.sent))}건이 발송 큐에 들어갔습니다.</b> 발송 기록과 캠페인 타깃이 생성됐고, 이메일이 없는
            대상은 작업 큐로 넘어갔습니다. <Link href="/dashboard">대시보드</Link>에서 확인하세요.
          </Note>
        )}
        {sp.blocked && (
          <Note tone="stop">
            <b>게이트에서 막혔습니다.</b> 아래 실패 항목을 해소해야 발송이 시작됩니다.
          </Note>
        )}

        {step === 1 && (
          <>
            <div className="cols c2">
              <Card title="세그먼트" hint={campaign.name}>
                <div className="card-b">
                  <dl className="kv">
                    <dt>캠페인 카테고리</dt>
                    <dd>{campaign.category} (+ 인접 카테고리 가중 적용)</dd>
                    <dt>카테고리 점유율</dt>
                    <dd>관련 카테고리 20% 이상</dd>
                    <dt>팔로워</dt>
                    <dd>{fmt(DEFAULT_SEGMENT.followersMin)} ~ {fmt(DEFAULT_SEGMENT.followersMax)}</dd>
                    <dt>적합도</dt>
                    <dd>{DEFAULT_SEGMENT.minFit}점 이상</dd>
                    <dt>타이밍</dt>
                    <dd>마지막 공구 경과일 ≥ 평균 간격 × {DEFAULT_SEGMENT.timingRatioMin}</dd>
                    <dt>브랜드 충돌</dt>
                    <dd>최근 {DEFAULT_SEGMENT.conflictWindowDays}일 같은 카테고리 브랜드 진행 시 제외</dd>
                    <dt>쿨다운</dt>
                    <dd>이메일 {DEFAULT_SEGMENT.cooldownEmailDays}일 · DM {DEFAULT_SEGMENT.cooldownDmDays}일 내 컨택 이력 제외</dd>
                  </dl>
                </div>
              </Card>

              <Card title="대상 산출" hint="이 숫자는 지금 DB 를 실제로 훑어 계산한 값입니다">
                <div className="card-b">
                  <Funnel
                    steps={seg.funnel.map((f, i) => ({
                      label: f.label,
                      count: f.delta != null ? Math.abs(f.delta) : f.count,
                      sub: f.delta != null ? `→ ${fmt(f.count)}` : undefined,
                      strong: i === seg.funnel.length - 1,
                    }))}
                  />
                  <div style={{ marginTop: 14 }}>
                    <Note>
                      연락처 없음 <b>{fmt(noContact)}명</b>은 최종 대상에서 빠지지만 버려지지 않습니다. 발송을 시작하면
                      인포크 제안 큐로 자동 분기됩니다.
                    </Note>
                  </div>
                </div>
              </Card>
            </div>

            <Card title="채널 분배" hint="채널 정책 표가 실행 방식을 결정합니다">
              <Scroller wide>
                <table>
                  <thead><tr><th>채널</th><th>대상</th><th>실행</th><th>일 상한</th><th>소요</th></tr></thead>
                  <tbody>
                    <tr>
                      <td>이메일</td>
                      <td className="num">{fmt(emailN)}</td>
                      <td><Pill tone="k-ok">자동 시퀀스</Pill></td>
                      <td className="num">{gate.capacity} ({senders.length}계정)</td>
                      <td className="num">{gate.days}일</td>
                    </tr>
                    <tr>
                      <td>인스타 DM</td>
                      <td className="num">{fmt(dmN)}</td>
                      <td><Pill tone="k-warn">작업 큐 (사람)</Pill></td>
                      <td className="num">
                        {one<{ n: number }>(`SELECT COALESCE(SUM(daily_cap - sent_today),0) AS n FROM sender_account WHERE channel='ig_dm' AND status='ok'`)!.n}
                      </td>
                      <td className="num">—</td>
                    </tr>
                    <tr>
                      <td>인포크 제안</td>
                      <td className="num">{fmt(inpockN)}</td>
                      <td><Pill tone="k-warn">작업 큐 (사람)</Pill></td>
                      <td>—</td>
                      <td className="num">—</td>
                    </tr>
                  </tbody>
                </table>
              </Scroller>
            </Card>

            <Card title="제외된 대상" hint={`${fmt(seg.dropped.length)}명 · 사유별`}>
              <Scroller>
                <table>
                  <thead><tr><th>사유</th><th>인원</th><th>예시</th></tr></thead>
                  <tbody>
                    {Object.entries(
                      seg.dropped.reduce<Record<string, string[]>>((acc, d) => {
                        const key = d.reason.replace(/\d+\/\d+일/, "쿨다운 기간 내").replace(/\d+일 전 진행/, "최근 진행");
                        (acc[key] ??= []).push(d.handle);
                        return acc;
                      }, {}),
                    )
                      .sort((a, b) => b[1].length - a[1].length)
                      .map(([reason, handles]) => (
                        <tr key={reason}>
                          <td>{reason}</td>
                          <td className="num">{fmt(handles.length)}</td>
                          <td className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                            {handles.slice(0, 3).map((h) => `@${h}`).join(", ")}
                            {handles.length > 3 ? " …" : ""}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </Scroller>
            </Card>

            <div style={{ display: "flex", gap: 8 }}>
              <Link className="btn pri" href={stepLink(2)}>문안 작성</Link>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="cols c2">
              <Card title="템플릿" hint="티어별로 분리 · 마이크로 선택됨">
                <div className="card-b">
                  <div className="filterbar" style={{ marginBottom: 14 }}>
                    {["나노/마이크로", "마이크로", "메가", "에이전시"].map((t) => (
                      <span className="chip" key={t} aria-pressed={t === "마이크로"}>{t}</span>
                    ))}
                  </div>
                  <ul className="tight">
                    <li>
                      변수: <code className="mono">{"{{name}}"}</code> <code className="mono">{"{{handle}}"}</code>{" "}
                      <code className="mono">{"{{last_gb_brand}}"}</code> <code className="mono">{"{{cadence}}"}</code>{" "}
                      <code className="mono">{"{{product}}"}</code>
                    </li>
                    <li>
                      Spintax: <code className="mono">{"{{RANDOM|안녕하세요|반갑습니다}}"}</code> — 수신자마다 문장이
                      달라집니다
                    </li>
                    <li>링크는 1개만. 추적 파라미터는 어트리뷰션 토큰 하나로 통합</li>
                    <li>제목 A/B 2안이 자동으로 절반씩 배분됩니다</li>
                  </ul>
                  <div style={{ marginTop: 14 }}>
                    <Note tone="warn">
                      <b>(광고) 표기가 자동 주입됩니다.</b> 채널 정책 표의 <code className="mono">ad_label</code> 이 1
                      이라 템플릿에서 지울 수 없습니다. 전송자 명칭·연락처·수신거부 방법도 렌더러가 붙입니다.
                    </Note>
                  </div>
                </div>
              </Card>

              <div className="mailbox">
                <div className="mailhead">
                  <div>
                    <b>보내는 사람</b>{" "}
                    <span className="mono">지은 (Dinostudio) &lt;{sender?.identifier ?? "partner@dinostudio.kr"}&gt;</span>
                  </div>
                  <div>
                    <b>Reply-To</b> <code>partner+cm_{token}@dinostudio.kr</code>
                  </div>
                  <div>
                    <b>제목</b> (광고) <span className="var">{"{{name}}"}</span>님, {brand?.name} 공동구매 제안드립니다
                  </div>
                </div>
                <div className="mailbody">
                  {`안녕하세요 `}
                  <span className="var">{"{{name}}"}</span>
                  {`님, Dinostudio 파트너십 담당 지은입니다.

`}
                  <span className="var">{"{{last_gb_brand}}"}</span>
                  {` 공구를 인상 깊게 봤습니다. ${campaign.category} 카테고리에서 꾸준히 `}
                  <span className="var">{"{{cadence}}"}</span>
                  {`일 간격으로 공구를 열어오신 걸 보고 연락드립니다.

${brand?.starts_on}부터 ${brand?.ends_on}까지 진행하는 `}
                  <b>{brand?.name} 공동구매</b>
                  {`를 함께 하실 수 있을지 여쭙습니다.

· 수수료 ${brand?.commission_pct ?? 18}% (업계 평균 12~15%)
· 샘플 무상 제공, 상세페이지·소재 일체 제공
· 정산은 판매 종료 후 10일 이내

관심 있으시면 이 메일에 회신만 주셔도 됩니다. 조건은 조정 가능합니다.

감사합니다.`}
                </div>
                <div className="mailfoot">
                  Dinostudio (주) · 서울시 성동구 … · 02-000-0000 · {sender?.identifier}
                  <br />
                  수신을 원하지 않으시면 <u>수신거부</u>를 눌러주세요. 수신거부는 무료이며 2일 내 처리됩니다.
                  <br />
                  <span style={{ color: "var(--accent-ink)" }}>List-Unsubscribe · One-Click 헤더 자동 삽입됨</span>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Link className="btn" href={stepLink(1)}>이전</Link>
              <Link className="btn pri" href={stepLink(3)}>정책 게이트 검사</Link>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="cols c2">
              <Card title="정책 게이트" hint="전부 통과해야 발송됩니다">
                <div className="card-b">
                  <div className="gate">
                    {gate.checks.map((c) => (
                      <div className="grow" key={c.label}>
                        <span className={`gmark ${c.pass ? "p" : "b"}`}>{c.pass ? "✓" : "✕"}</span>
                        <span>{c.label}</span>
                        <Pill tone={c.tone}>{c.note}</Pill>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>

              <Card title="발송 계획">
                <div className="card-b">
                  <dl className="kv">
                    <dt>대상</dt>
                    <dd>
                      <b>{fmt(emailN)}명</b> (이메일) + {fmt(dmN + inpockN)}명 작업 큐
                    </dd>
                    <dt>발신 계정</dt>
                    <dd>{senders.length}개 순환 · 오늘 가용 {gate.capacity}건</dd>
                    <dt>발송 시간</dt>
                    <dd>평일 09:00 ~ 18:00</dd>
                    <dt>간격</dt>
                    <dd>평균 4분 + 랜덤 지터 최대 3분</dd>
                    <dt>완료 예상</dt>
                    <dd>{gate.days <= 1 ? "오늘" : addDays(ref, gate.days - 1)}</dd>
                    <dt>시퀀스</dt>
                    <dd>4스텝 / 12일 · 회신 시 즉시 중단</dd>
                  </dl>
                  <div style={{ marginTop: 14 }}>
                    <Note>
                      발송 중 스팸 신고율이 경보선을 넘으면 볼륨이 줄고, 중단선을 넘으면 <b>전체 발송이 자동 중단</b>
                      됩니다. 임계값은 채널 정책 화면의 서킷브레이커 표에 있습니다.
                    </Note>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                    <Link className="btn" href={stepLink(2)}>이전</Link>
                    <form action={startSend}>
                      <input type="hidden" name="campaignId" value={campaign.id} />
                      <button className="btn pri" type="submit" disabled={!gate.allPass || emailN === 0}>
                        {emailN === 0 ? "발송할 대상이 없습니다" : `${fmt(emailN)}건 발송 시작`}
                      </button>
                    </form>
                  </div>
                </div>
              </Card>
            </div>
          </>
        )}
      </section>
    </Shell>
  );
}
