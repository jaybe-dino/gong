import Shell from "@/components/Shell";
import { Card, Note, Pill, Scroller } from "@/components/ui";
import { all } from "@/lib/db";
import { CHANNEL_LABEL, fmt } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function PolicyPage() {
  const policies = all<{
    channel: string; cold_allowed: number; execution: string; night_block: string | null;
    ad_label: number; unsub_required: number; daily_cap: number | null; cooldown_days: number;
  }>(`SELECT * FROM channel_policy`);

  const circuits = all<{ label: string; value: number; warn_at: number; stop_at: number | null; unit: string; action: string; key: string }>(
    `SELECT key, label, value, warn_at, stop_at, unit, action FROM circuit_metric`,
  );

  const suppressions = all<{ identifier: string; kind: string; reason: string; scope: string; created_at: string }>(
    `SELECT identifier, kind, reason, scope, created_at FROM suppression ORDER BY created_at DESC LIMIT 25`,
  );
  const supTotal = all<{ n: number }>(`SELECT COUNT(*) AS n FROM suppression`)[0].n;

  const provenance = all<{ value: string; source_desc: string; collected_at: string; collected_by: string; note: string | null }>(
    `SELECT value, source_desc, collected_at, collected_by, note FROM contact_point ORDER BY collected_at DESC LIMIT 12`,
  );

  const senders = all<{ identifier: string; channel: string; daily_cap: number; sent_today: number; age_days: number; status: string; ramp_day: number | null }>(
    `SELECT identifier, channel, daily_cap, sent_today, age_days, status, ramp_day FROM sender_account ORDER BY channel, id`,
  );

  const execLabel: Record<string, string> = { auto: "자동", manual_queue: "작업 큐", auto_after_consent: "자동 (동의 후)" };
  const kindLabel: Record<string, string> = { email: "이메일", handle: "IG 핸들", domain: "도메인" };

  return (
    <Shell path="/policy" title="채널 정책 · 발신 계정" sub="컴플라이언스 설정">
      <section className="screen">
        <Card title="채널 정책" hint="코드가 아니라 이 표가 발송 워커를 통제합니다">
          <Scroller wide>
            <table>
              <thead>
                <tr>
                  <th>채널</th><th>콜드 허용</th><th>실행 방식</th><th>야간 차단</th>
                  <th>(광고) 표기</th><th>수신거부</th><th>일 상한</th><th>쿨다운</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => (
                  <tr key={p.channel}>
                    <td><b>{CHANNEL_LABEL[p.channel] ?? p.channel}</b></td>
                    <td>{p.cold_allowed ? <Pill tone="k-ok">허용</Pill> : <Pill tone="k-stop">불가</Pill>}</td>
                    <td>{execLabel[p.execution] ?? p.execution}</td>
                    <td className="num">{p.night_block ?? "—"}</td>
                    <td>{p.ad_label ? "필수" : "—"}</td>
                    <td>{p.unsub_required ? "필수" : "—"}</td>
                    <td className="num">{p.daily_cap ?? "—"}</td>
                    <td className="num">{p.cooldown_days}일</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
        </Card>

        <Card title="발신 계정" hint="계정 연령별 상한 — 30일 미만 10→20 / 30~180일 30 / 180일+ 50~75">
          <Scroller wide>
            <table>
              <thead>
                <tr><th>계정</th><th>채널</th><th>연령</th><th>오늘</th><th>일 상한</th><th>잔여</th><th>상태</th></tr>
              </thead>
              <tbody>
                {senders.map((s) => (
                  <tr key={s.identifier}>
                    <td className="mono">{s.identifier}</td>
                    <td>{s.channel === "email" ? "이메일" : "IG DM"}</td>
                    <td className="num">{s.age_days}일</td>
                    <td className="num">{s.sent_today}</td>
                    <td className="num">{s.daily_cap}</td>
                    <td className="num">{s.status === "suspended" ? 0 : Math.max(0, s.daily_cap - s.sent_today)}</td>
                    <td>
                      {s.status === "ok" ? <Pill tone="k-ok">정상</Pill>
                        : s.status === "ramping" ? <Pill tone="k-warn">램프업 D{s.ramp_day}</Pill>
                        : <Pill tone="k-stop">24h 정지</Pill>}
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
                <thead><tr><th>지표</th><th>경보</th><th>조치</th><th>현재</th></tr></thead>
                <tbody>
                  {circuits.map((m) => {
                    const bad = m.key === "inbox" ? m.value < m.warn_at : m.value >= m.warn_at;
                    return (
                      <tr key={m.label}>
                        <td>{m.label}</td>
                        <td className="num">{m.warn_at}{m.unit}</td>
                        <td>{m.action}</td>
                        <td className="num" style={{ color: bad ? "var(--stop)" : "var(--ok)" }}>
                          {m.value}{m.unit}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Scroller>
          </Card>

          <Card title="수신거부 · 연락 금지" hint={`채널 무관 즉시 반영 · 총 ${fmt(supTotal)}건`}>
            <Scroller>
              <table>
                <thead><tr><th>식별자</th><th>유형</th><th>사유</th><th>범위</th><th>등록</th></tr></thead>
                <tbody>
                  {suppressions.map((s) => (
                    <tr key={s.identifier}>
                      <td className="mono">{s.identifier}</td>
                      <td>{kindLabel[s.kind] ?? s.kind}</td>
                      <td>{s.reason}</td>
                      <td>{s.scope === "all" ? "전 채널" : "이메일"}</td>
                      <td className="num">{s.created_at.slice(5, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
            <div className="card-b" style={{ borderTop: "1px solid var(--line)" }}>
              <Note tone="stop">
                수신거부는 <b>영구</b>입니다. 스키마에 만료일 컬럼이 없어 설정할 수 없습니다. 수신거부 회피·방해는
                형사처벌 대상입니다.
              </Note>
            </div>
          </Card>
        </div>

        <Card title="개인정보 수집 출처 조회" hint="크리에이터가 문의하면 즉시 답할 수 있어야 합니다">
          <Scroller wide>
            <table>
              <thead><tr><th>연락처</th><th>수집 출처</th><th>수집 일시</th><th>수집자</th><th>근거 메모</th></tr></thead>
              <tbody>
                {provenance.map((p) => (
                  <tr key={p.value}>
                    <td className="mono">{p.value}</td>
                    <td>{p.source_desc}</td>
                    <td className="num">{p.collected_at}</td>
                    <td>{p.collected_by}</td>
                    <td>{p.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
        </Card>
      </section>
    </Shell>
  );
}
