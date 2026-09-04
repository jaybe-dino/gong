import Shell from "@/components/Shell";
import { Card, Empty, Note, Pill, Scroller } from "@/components/ui";
import { hasTable } from "@/lib/schema";
import * as sa from "@/lib/google-sa";
import * as settings from "@/lib/settings";
import { checkDomain, type DnsRecordCheck } from "@/lib/jobs/dns-check";
import {
  addMailbox, dnsTest, makeDefault, probeMailbox, receiveTest,
  removeMailbox, saveSettings, sendTest, toggleMailbox,
} from "./actions";

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
  const ready = await hasTable("mailbox");
  const id = sa.identity();

  const [values, srcs, boxes, tests] = await Promise.all([
    settings.getAll(),
    settings.sources(),
    ready ? sa.mailboxes() : Promise.resolve([]),
    (await hasTable("mail_test")) ? settings.recentTests(10) : Promise.resolve([]),
  ]);
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

        {!ready && (
          <Note tone="stop">
            <code className="mono">008_mailbox.sql</code> 이 아직 적용되지 않았습니다.{" "}
            <a href="/setup">초기 설정</a> 에서 마이그레이션을 적용한 뒤 다시 오세요.
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
