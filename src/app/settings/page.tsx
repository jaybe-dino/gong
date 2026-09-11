import Shell from "@/components/Shell";
import { Card, Empty, Note, Pill, Scroller } from "@/components/ui";
import { hasTable, schemaState } from "@/lib/schema";
import * as sa from "@/lib/google-sa";
import * as settings from "@/lib/settings";
import { checkDomain, type DnsRecordCheck } from "@/lib/jobs/dns-check";
import {
  addMailbox, dnsTest, makeDefault, probeMailbox, receiveTest,
  removeMailbox, savePace, saveSettings, sendTest, setEnforceCap, toggleMailbox,
} from "./actions";
import * as pace from "@/lib/pacing";
import { sendingIdentity } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 계정 연동 설정.
 *
 * 이 화면이 답해야 하는 것은 하나다 — "지금 메일이 진짜로 나가는가".
 * 그래서 상태를 세 층으로 나눠 보여준다.
 *   1. 서비스 계정 키가 서버에 있는가        (없으면 전부 dry-run)
 *   2. 도메인 위임이 붙었는가                (연결 점검이 답한다)
 *   3. 도메인 DNS 가 발송에 적합한가          (SPF·DKIM·DMARC·MX)
 * 하나라도 비면 그 자리에서 무엇을 해야 하는지 적는다.
 */

const TEST_LABEL: Record<string, string> = {
  probe: "연결 점검", send: "발송 테스트", receive: "수신 테스트", dns: "DNS 점검",
};

function statusPill(s: DnsRecordCheck["status"]) {
  if (s === "ok") return <Pill tone="k-ok">정상</Pill>;
  if (s === "missing") return <Pill tone="k-stop">없음</Pill>;
  if (s === "warn") return <Pill tone="k-warn">확인 필요</Pill>;
  return <Pill tone="k-warn">조회 실패</Pill>;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; kind?: string }>;
}) {
  const { msg, kind } = await searchParams;
  const [ready, schema] = await Promise.all([hasTable("mailbox"), schemaState()]);
  const id = sa.identity();

  const [values, srcs, boxes, tests, pacing] = await Promise.all([
    settings.getAll(),
    settings.sources(),
    ready ? sa.mailboxes() : Promise.resolve([]),
    (await hasTable("mail_test")) ? settings.recentTests(10) : Promise.resolve([]),
    pace.overview(),
  ]);
  const ident = await sendingIdentity();
  const enforceCap = await pace.isEnforced();
  // DNS 는 네트워크를 타므로 설정 값이 정해진 뒤에 본다.
  const dns = values["mail.domain"] ? await checkDomain(values["mail.domain"]) : null;

  const active = boxes.filter((b) => b.enabled);
  const def = boxes.find((b) => b.is_default && b.enabled) ?? null;
  const live = Boolean(id && def);

  return (
    <Shell path="/settings" title="계정 연동 · 설정" sub="Google Workspace · 발송 도메인">
      <section className="screen settings">
        {msg && (
          <Note tone={kind === "err" ? "stop" : undefined}>{msg}</Note>
        )}

        {!schema.ready && (
          <Note tone="stop">
            <b>마이그레이션 {schema.pending.length}개가 아직 적용되지 않았습니다.</b>{" "}
            <a href="/setup">초기 설정</a> 에서 <b>1. 스키마 적용</b> 을 누르세요. 그때까지 이 화면의
            메일함 등록·테스트는 동작하지 않고, 발송은 전부 dry-run 입니다.
            <pre className="mono" style={{ margin: "8px 0 0", fontSize: 11.5, whiteSpace: "pre-wrap" }}>
              {schema.pending.join("\n")}
            </pre>
          </Note>
        )}

        <Card
          title="발송 상태"
          hint={live ? "실제로 나갑니다" : "지금은 실제로 나가지 않습니다"}
          right={live ? <Pill tone="k-ok">실발송</Pill> : <Pill tone="k-warn">dry-run</Pill>}
        >
          <div className="card-b">
            <dl className="kv" style={{ gridTemplateColumns: "128px 1fr" }}>
              <dt>서비스 계정 키</dt>
              <dd>{id ? <span className="good">있음</span> : <span className="bad">없음 — 전부 dry-run</span>}</dd>
              <dt>서비스 계정 주소</dt>
              <dd className="mono">{id?.client_email ?? "—"}</dd>
              <dt>클라이언트 ID</dt>
              <dd className="mono">{id?.client_id ?? "—"}</dd>
              <dt>기본 발신함</dt>
              <dd className="mono">{def?.email ?? "—"}</dd>
              <dt>수집 대상</dt>
              <dd>{active.length}개 메일함</dd>
            </dl>

            {!id && (
              <Note tone="stop">
                서버 환경 변수 <code className="mono">GOOGLE_SA_KEY_JSON</code> 에 서비스 계정 키 JSON 전체를{" "}
                <b>한 줄로</b> 넣고 재배포하세요. 이 값은 화면에서 입력하지 않습니다 — 지정 스코프 범위에서 도메인
                전 계정의 메일을 열 수 있는 키라 DB 나 폼에 두지 않습니다.
              </Note>
            )}

            <Note>
              관리 콘솔(<span className="mono">admin.google.com</span> → 보안 → API 제어 → 도메인 전체 위임)에 위
              클라이언트 ID 와 아래 스코프를 <b>한 글자도 다르지 않게</b> 등록해야 합니다. 다르면{" "}
              <code className="mono">unauthorized_client</code> 가 납니다.
              <pre className="mono" style={{ margin: "8px 0 0", fontSize: 11.5, whiteSpace: "pre-wrap" }}>
                {sa.DELEGATION_SCOPES}
              </pre>
            </Note>
          </div>
        </Card>

        <Card
          title="메일함"
          hint="여기에 등록된 주소만 대신할 수 있습니다"
          right={
            <form action={receiveTest}>
              <button className="btn sm" type="submit">수신 테스트</button>
            </form>
          }
        >
          <div className="card-b" style={{ paddingBottom: 0 }}>
            <div className="idbox">
              <div>
                <span>발신 (From)</span>
                <b className="mono">{ident.from ?? "없음 — 아래에서 등록하세요"}</b>
              </div>
              <div>
                <span>회신 수신 (Reply-To)</span>
                <b className="mono">{ident.replyTo}</b>
              </div>
              <div>
                <span>인박스 수집</span>
                <b className="mono">{ident.inboxCount}개 메일함</b>
              </div>
            </div>
            {!ident.replyBoxRegistered && (
              <Note tone="stop">
                <b>회신 주소 {ident.replyTo} 가 이 목록에 없습니다.</b>
                <p style={{ margin: "6px 0 0", lineHeight: 1.8 }}>
                  보내는 메일의 Reply-To 는 <code className="mono">{ident.replyTo}</code> 로 나가는데,
                  통합 인박스는 <b>아래에 등록된 메일함만</b> 읽습니다. 이대로 두면 답장이 와도
                  화면에 들어오지 않습니다. 그 주소를 아래에서 등록하거나,{" "}
                  <b>발신 정보</b>의 「발신 주소」를 등록된 메일함으로 바꾸세요.
                </p>
              </Note>
            )}
          </div>
          <Scroller wide>
            <table>
              <thead>
                <tr><th>주소</th><th>표시명</th><th>수집</th><th>기본 발신</th><th>마지막 점검</th><th>오류</th><th /></tr>
              </thead>
              <tbody>
                {boxes.map((b) => (
                  <tr key={b.email}>
                    <td className="mono">{b.email}</td>
                    <td>{b.label ?? "—"}</td>
                    <td>
                      <form action={toggleMailbox}>
                        <input type="hidden" name="email" value={b.email} />
                        <input type="hidden" name="enabled" value={b.enabled ? "0" : "1"} />
                        <button className="btn sm" type="submit">
                          {b.enabled ? "켜짐" : "꺼짐"}
                        </button>
                      </form>
                    </td>
                    <td>
                      {b.is_default ? <Pill tone="k-ok">기본</Pill> : (
                        <form action={makeDefault}>
                          <input type="hidden" name="email" value={b.email} />
                          <button className="btn sm" type="submit">기본으로</button>
                        </form>
                      )}
                    </td>
                    <td className="num">{b.last_sync_at ?? "—"}</td>
                    <td style={{ fontSize: 11.5, color: "var(--stop)" }}>{b.last_error ?? ""}</td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        <form action={probeMailbox}>
                          <input type="hidden" name="email" value={b.email} />
                          <button className="btn sm" type="submit">연결 점검</button>
                        </form>
                        <form action={removeMailbox}>
                          <input type="hidden" name="email" value={b.email} />
                          <button className="btn sm" type="submit">삭제</button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
                {boxes.length === 0 && (
                  <tr><td colSpan={7} className="empty">등록된 메일함이 없습니다. 아래에서 추가하세요.</td></tr>
                )}
              </tbody>
            </table>
          </Scroller>
          <div className="card-b" style={{ borderTop: "1px solid var(--line)" }}>
            <form action={addMailbox} className="filterbar" style={{ gap: 8 }}>
              <input name="email" placeholder={`main@${values["mail.domain"] || "example.com"}`} aria-label="메일 주소" />
              <input name="label" placeholder="표시명 (선택)" aria-label="표시명" />
              <button className="btn sm" type="submit">메일함 추가</button>
            </form>
            <Note>
              계정을 추가할 때 <b>Google 쪽에서 할 일은 없습니다</b> — 도메인 위임이 되어 있으면 주소만 등록하면
              바로 동작합니다. 단, 같은 Workspace 도메인이어야 합니다.
            </Note>
          </div>
        </Card>

        <div className="cols c2">
          <Card title="발송 테스트" hint="진짜로 한 통 보냅니다">
            <div className="card-b">
              <form action={sendTest} className="filterbar" style={{ gap: 8 }}>
                <input name="to" type="email" placeholder="받는 주소" aria-label="받는 주소" required />
                <button className="btn sm" type="submit">테스트 발송</button>
              </form>
              <Note tone={live ? undefined : "warn"}>
                {live
                  ? `${def!.email} 에서 실제로 발송됩니다.`
                  : "키나 기본 발신함이 없어 dry-run 으로 처리됩니다 — 메일은 나가지 않고 기록만 남습니다."}
              </Note>
            </div>
          </Card>

          <Card
            title="발송 도메인 DNS"
            hint={dns ? (dns.unknown ? "일부 조회 실패" : dns.ok ? "정상" : "조치 필요") : "도메인 미설정"}
            right={
              <form action={dnsTest}>
                <button className="btn sm" type="submit">다시 점검</button>
              </form>
            }
          >
            <Scroller wide>
              <table>
                <thead><tr><th>레코드</th><th>상태</th><th>현재 값</th><th>해야 할 일</th></tr></thead>
                <tbody>
                  {(dns?.checks ?? []).map((c) => (
                    <tr key={c.key}>
                      <td><b>{c.label}</b><br /><span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{c.host}</span></td>
                      <td>{statusPill(c.status)}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{c.found ?? "—"}</td>
                      <td style={{ fontSize: 11.5 }}>{c.note}</td>
                    </tr>
                  ))}
                  {!dns && <tr><td colSpan={4} className="empty">발송 도메인을 먼저 설정하세요.</td></tr>}
                </tbody>
              </table>
            </Scroller>
          </Card>
        </div>

        <Card title="발송량 상한 · 워밍업"
              hint="하루 권장 발송량. 계정 나이에서 계산합니다">
          <div className="card-b">
            <p className="lede" style={{ margin: "0 0 12px" }}>
              하루 권장량은 <b>계정 나이</b>에서 계산합니다. 어제의 두 배를 오늘 보내는 것이
              도메인·계정이 스팸으로 찍히는 가장 흔한 원인이라, 나이에 따라 단계적으로
              올라가는 값을 보여줍니다.
            </p>

            <form action={setEnforceCap} className="enforcebox">
              <label className="chk">
                <input type="checkbox" name="enforce" defaultChecked={enforceCap} />
                <span>
                  <b>권장 상한을 실제로 적용</b>
                  <small>
                    {enforceCap
                      ? "켜져 있습니다 — 오늘 몫을 다 쓰면 발송이 그 자리에서 멈추고, 남은 대상은 내일 이어집니다."
                      : "꺼져 있습니다 — 권장량은 화면에 표시만 하고 발송을 막지 않습니다. 대상 전원에게 나갑니다."}
                  </small>
                </span>
              </label>
              <button className="btn" type="submit">저장</button>
            </form>
            {pacing.length === 0 ? (
              <Empty>
                발신 계정이 아직 없습니다. 메일함을 등록하고 한 번 발송하면 여기에 나타납니다.
              </Empty>
            ) : (
              <div className="cols c2">
                {pacing.map((p) => (
                  <form key={p.senderId ?? p.identifier} action={savePace} className="pacecard">
                    <input type="hidden" name="id" value={p.senderId ?? ""} />
                    <input type="hidden" name="channel" value={p.channel} />
                    <input type="hidden" name="identifier" value={p.identifier} />
                    <div className="pacehead">
                      <b className="mono">{p.identifier}</b>
                      <Pill tone={p.advice ? "k-warn" : "k-ok"}>
                        {p.advice ? "권장량 도달" : `오늘 권장 ${p.remaining}건`}
                      </Pill>
                    </div>
                    <div className="pacewhy" style={{ marginBottom: 10 }}>
                      {p.channel === "email" ? "이메일" : p.channel === "instagram_dm" ? "인스타 DM" : p.channel}
                      {" · "}{p.reason}
                      {p.sentToday > 0 && ` · 오늘 ${p.sentToday}건 보냄`}
                    </div>
                    <div className="cols c2">
                      <label className="field">
                        <span>계정 나이 (일)</span>
                        <input name="age" type="number" min={0} defaultValue={p.ageDays ?? ""} placeholder="예: 14" />
                        <small style={{ color: "var(--ink-3)", fontSize: 11.5 }}>
                          비우면 0일로 봅니다 (가장 보수적)
                        </small>
                      </label>
                      <label className="field">
                        <span>하드 실링 (하루)</span>
                        <input name="cap" type="number" min={1} defaultValue={p.hardCap} />
                        <small style={{ color: "var(--ink-3)", fontSize: 11.5 }}>
                          워밍업 값이 이보다 크면 이 값이 이깁니다
                        </small>
                      </label>
                    </div>
                    <label className="chk" style={{ marginTop: 4 }}>
                      <input type="checkbox" name="warmup" defaultChecked={p.warmup} />
                      <span>워밍업 곡선 사용 (끄면 권장량이 하드 실링과 같아집니다)</span>
                    </label>
                    <button className="btn" type="submit" style={{ marginTop: 10 }}>저장</button>
                  </form>
                ))}
              </div>
            )}
            <Note tone="warn">
              <b>권장 곡선</b>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.85 }}>
                <li>이메일 — 20건/일에서 시작해 7·14·21·30·45·60·90일에 걸쳐
                  30 · 45 · 60 · 90 · 120 · 160 · 250건.</li>
                <li>인스타 DM — 10건에서 시작해 20 · 30 · 40 · 50 · 60 · 70 · 80건.
                  DM 의 천장은 우리가 아니라 인스타그램이 정합니다.</li>
                <li>시간당 권장량도 있습니다 (이메일 40건 · DM 15건) — 하루치를 한꺼번에
                  쏟는 것도 급증 신호입니다.</li>
                <li>단계 사이가 두 배를 넘지 않게 짰습니다. 곡선을 건너뛰고 올리려면
                  워밍업 곡선을 끄고 하드 실링을 직접 올리세요.</li>
              </ul>
            </Note>
          </div>
        </Card>

        <Card title="발신 정보" hint="법정 표기가 비면 게이트가 발송을 막습니다">
          <div className="card-b">
            <form action={saveSettings}>
              <div className="cols c2">
                {settings.SPECS.map((s) => (
                  <label key={s.key} className="field">
                    <span>
                      {s.label}
                      {s.required && <em style={{ color: "var(--stop)" }}> *</em>}{" "}
                      <small className="mono" style={{ color: "var(--ink-3)" }}>
                        {srcs[s.key] === "db" ? "저장됨" : srcs[s.key] === "env" ? `환경변수 ${s.env}` : srcs[s.key] === "default" ? "기본값" : "비어 있음"}
                      </small>
                    </span>
                    <input name={s.key} defaultValue={values[s.key]} placeholder={s.fallback} />
                    {s.hint && <small style={{ color: "var(--ink-3)", fontSize: 11.5 }}>{s.hint}</small>}
                  </label>
                ))}
              </div>
              <button className="btn" type="submit" style={{ marginTop: 12 }}>저장</button>
            </form>
          </div>
        </Card>

        <Card title="테스트 기록" hint="'보냈는데 안 왔다' 를 눈으로 확인할 수 있어야 합니다">
          {tests.length === 0 ? (
            <div className="card-b"><Empty>아직 테스트 기록이 없습니다.</Empty></div>
          ) : (
            <Scroller wide>
              <table>
                <thead><tr><th>일시</th><th>종류</th><th>대상</th><th>결과</th><th>상세</th></tr></thead>
                <tbody>
                  {tests.map((t, i) => (
                    <tr key={i}>
                      <td className="num">{t.at}</td>
                      <td>{TEST_LABEL[t.kind] ?? t.kind}</td>
                      <td className="mono">{t.target ?? "—"}</td>
                      <td>{t.ok ? <Pill tone="k-ok">성공</Pill> : <Pill tone="k-stop">실패</Pill>}</td>
                      <td style={{ fontSize: 11.5 }}>{String(t.detail?.detail ?? "")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          )}
        </Card>
      </section>
    </Shell>
  );
}
