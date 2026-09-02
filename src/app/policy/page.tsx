import Shell from "@/components/Shell";
import { Card, Note, Pill, Scroller } from "@/components/ui";
import { all } from "@/lib/db";
import { breakers, channelPolicies, senders } from "@/lib/queries";
import { AUTOMATION_LABEL, CHANNEL_LABEL, fmt, SOURCE_TYPE_LABEL, SUPPRESSION_KIND, SUPPRESSION_REASON } from "@/lib/format";
import { CHECK_LABEL } from "@/lib/policy-gate";

export const dynamic = "force-dynamic";

export default async function PolicyPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();

  const [pol, brs, snd, sup, supTotal, blocks, provenance] = await Promise.all([
    channelPolicies(),
    breakers(),
    senders(),
    all<{ identifier_type: string; identifier_val: string; reason: string; channels: string[]; created_at: string; expires_at: string | null }>(
      `SELECT identifier_type, identifier_val, reason, channels,
              to_char(created_at,'YYYY-MM-DD') AS created_at,
              to_char(expires_at,'YYYY-MM-DD') AS expires_at
         FROM suppression ORDER BY created_at DESC LIMIT 25`),
    all<{ n: string }>(`SELECT count(*) AS n FROM suppression`),
    all<{ failed_check: string; detail: string; channel: string; occurred_at: string; handle: string | null }>(
      `SELECT g.failed_check, g.detail, g.channel,
              to_char(g.occurred_at,'MM-DD HH24:MI') AS occurred_at, sa.handle
         FROM gate_block g
         LEFT JOIN campaign_member m ON m.id = g.campaign_member_id
         LEFT JOIN social_account sa ON sa.creator_id = m.creator_id
        ORDER BY g.occurred_at DESC LIMIT 15`),
    all<{ value: string; channel: string; source_type: string; source_url: string; collected_at: string; collected_by: string; collect_note: string | null; consent_status: string; display_name: string }>(
      `SELECT cp.value, cp.channel, cp.source_type, cp.source_url,
              to_char(cp.collected_at,'YYYY-MM-DD') AS collected_at,
              u.name AS collected_by, cp.collect_note, cp.consent_status, c.display_name
         FROM contact_point cp
         JOIN creator c ON c.id = cp.creator_id
         JOIN app_user u ON u.id = cp.collected_by
        ${q ? `WHERE cp.value ILIKE $1 OR c.display_name ILIKE $1
                  OR EXISTS (SELECT 1 FROM social_account sa WHERE sa.creator_id=c.id AND sa.handle ILIKE $1)` : ""}
        ORDER BY cp.collected_at DESC LIMIT 12`,
      q ? [`%${q}%`] : []),
  ]);

  return (
    <Shell path="/policy" title="채널 정책 · 발신 계정" sub="컴플라이언스 설정">
      <section className="screen">
        <Card title="채널 정책" hint="코드가 아니라 이 표가 발송 워커를 통제합니다">
          <Scroller wide>
            <table>
              <thead>
                <tr><th>채널</th><th>콜드 허용</th><th>실행 방식</th><th>야간 차단</th><th>(광고) 표기</th><th>수신거부</th><th>일 상한</th><th>쿨다운</th></tr>
              </thead>
              <tbody>
                {pol.map((p) => (
                  <tr key={p.channel}>
                    <td><b>{CHANNEL_LABEL[p.channel] ?? p.channel}</b></td>
                    <td>{p.allows_cold ? <Pill tone="k-ok">허용</Pill> : <Pill tone="k-stop">불가</Pill>}</td>
                    <td>{AUTOMATION_LABEL[p.automation_mode] ?? p.automation_mode}</td>
                    <td className="num">{p.night_block ? `${p.night_from_hour}–${p.night_to_hour}` : "—"}</td>
                    <td>{p.requires_ad_label ? "필수" : "—"}</td>
                    <td>{p.requires_optout ? "필수" : "—"}</td>
                    <td className="num">{p.default_daily_cap ?? "—"}</td>
                    <td className="num">{p.cooldown_days}일</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
          <div className="card-b" style={{ borderTop: "1px solid var(--line)" }}>
            <Note>
              <b>콜드 불가 = 시스템이 자동으로 보내지 않는다</b>는 선언입니다. 금지가 아니라 라우팅입니다 —{" "}
              <code className="mono">automation_mode=manual_task</code> 인 채널은 발송기가 건드리지 못하고 전부 작업
              큐로 갑니다. 인스타 Messaging API 는 상대가 먼저 보낸 뒤 24시간 창이 열려야 회신할 수 있어, 임의의
              핸들에 첫 DM 을 보내는 엔드포인트 자체가 없습니다.
            </Note>
          </div>
        </Card>

        <Card title="발신 계정" hint="daily_cap 은 목표치이고, 실제 상한은 램프업된 current_cap 입니다">
          <Scroller wide>
            <table>
              <thead><tr><th>계정</th><th>채널</th><th>연령</th><th>오늘</th><th>현재 상한</th><th>목표</th><th>잔여</th><th>상태</th></tr></thead>
              <tbody>
                {snd.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.identifier}</td>
                    <td>{s.channel === "email" ? "이메일" : "IG DM"}</td>
                    <td className="num">{s.account_age_d ?? "—"}일</td>
                    <td className="num">{s.sent_today}</td>
                    <td className="num">{s.current_cap}</td>
                    <td className="num">{s.daily_cap}</td>
                    <td className="num">{s.paused_until ? 0 : Math.max(0, s.current_cap - s.sent_today)}</td>
                    <td>
                      {s.paused_until ? <Pill tone="k-stop">정지 · {s.pause_reason ?? "사유 미기재"}</Pill>
                        : s.current_cap < s.daily_cap ? <Pill tone="k-warn">램프업 중</Pill>
                        : <Pill tone="k-ok">정상</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
        </Card>

        <div className="cols c2">
          <Card title="서킷브레이커">
            <Scroller>
              <table>
                <thead><tr><th>지표</th><th>경보</th><th>중단</th><th>조치</th><th>현재</th></tr></thead>
                <tbody>
                  {brs.map((m) => (
                    <tr key={m.metric}>
                      <td>{m.metric}</td>
                      <td className="num">{m.warn_at ?? "—"}</td>
                      <td className="num">{m.halt_at ?? "—"}</td>
                      <td>{m.action}</td>
                      <td className="num" style={{ color: m.is_tripped ? "var(--stop)" : "var(--ok)" }}>{m.current_value ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          </Card>

          <Card title="수신거부 · 연락 금지" hint={`영구 · 총 ${fmt(supTotal[0]?.n)}건`}>
            <Scroller wide>
              <table>
                <thead><tr><th>식별자</th><th>유형</th><th>사유</th><th>범위</th><th>등록</th><th>만료</th></tr></thead>
                <tbody>
                  {sup.map((s) => (
                    <tr key={`${s.identifier_type}:${s.identifier_val}`}>
                      <td className="mono">{s.identifier_val}</td>
                      <td>{SUPPRESSION_KIND[s.identifier_type] ?? s.identifier_type}</td>
                      <td>{SUPPRESSION_REASON[s.reason] ?? s.reason}</td>
                      <td>{!s.channels?.length ? "전 채널" : s.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(", ")}</td>
                      <td className="num">{s.created_at}</td>
                      <td className="num">{s.expires_at ?? <Pill tone="k-stop">영구</Pill>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
            <div className="card-b" style={{ borderTop: "1px solid var(--line)" }}>
              <Note tone="stop">
                수신거부와 연락 금지는 <b>영구</b>입니다. 스키마의{" "}
                <code className="mono">unsub_is_permanent</code> 제약이 만료일 설정을 막습니다 — 코드로 우회할 수
                없습니다.
              </Note>
            </div>
          </Card>
        </div>

        <Card title="발송 차단 기록" hint="왜 안 나갔는지 언제든 답할 수 있어야 합니다">
          {blocks.length === 0 ? (
            <div className="card-b" style={{ color: "var(--ink-3)", fontSize: 12.5 }}>
              아직 게이트에 막힌 발송이 없습니다.
            </div>
          ) : (
            <Scroller wide>
              <table>
                <thead><tr><th>일시</th><th>대상</th><th>채널</th><th>막힌 검사</th><th>사유</th></tr></thead>
                <tbody>
                  {blocks.map((b, i) => (
                    <tr key={i}>
                      <td className="num">{b.occurred_at}</td>
                      <td className="mono">{b.handle ? `@${b.handle}` : "—"}</td>
                      <td>{CHANNEL_LABEL[b.channel] ?? b.channel}</td>
                      <td><Pill tone="k-stop">{CHECK_LABEL[b.failed_check] ?? b.failed_check}</Pill></td>
                      <td style={{ fontSize: 11.5 }}>{b.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          )}
        </Card>

        <Card title="개인정보 수집 출처 조회" hint="크리에이터가 문의하면 즉시 답할 수 있어야 합니다 (개인정보보호법 §20)">
          <div className="card-b">
            <form className="filterbar" style={{ marginBottom: 14 }} method="get" action="/policy">
              <div className="search">
                <span className="mono" style={{ color: "var(--ink-3)" }}>⌕</span>
                <input name="q" defaultValue={q} placeholder="핸들 · 이름 · 이메일로 조회" aria-label="출처 조회" />
              </div>
              <button className="btn sm" type="submit">조회</button>
            </form>
            <Scroller wide>
              <table>
                <thead><tr><th>연락처</th><th>채널</th><th>수집 출처</th><th>원본 URL</th><th>수집 일시</th><th>수집자</th><th>동의</th></tr></thead>
                <tbody>
                  {provenance.map((p, i) => (
                    <tr key={i}>
                      <td className="mono">{p.value}</td>
                      <td>{CHANNEL_LABEL[p.channel] ?? p.channel}</td>
                      <td>{SOURCE_TYPE_LABEL[p.source_type] ?? p.source_type}{p.collect_note ? ` · ${p.collect_note}` : ""}</td>
                      <td style={{ fontSize: 11, color: "var(--ink-3)" }}>{p.source_url}</td>
                      <td className="num">{p.collected_at}</td>
                      <td>{p.collected_by}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{p.consent_status}</td>
                    </tr>
                  ))}
                  {provenance.length === 0 && <tr><td colSpan={7} className="empty">조회 결과가 없습니다.</td></tr>}
                </tbody>
              </table>
            </Scroller>
            <Note>
              <code className="mono">contact_point.source_type · source_url · collected_by</code> 는 NOT NULL 입니다.
              수집 출처를 진술할 수 없는 연락처는 <b>저장 자체가 되지 않습니다</b> — 소급이 불가능한 유일한 데이터라
              스키마로 강제합니다.
            </Note>
          </div>
        </Card>
      </section>
    </Shell>
  );
}
