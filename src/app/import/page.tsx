import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Empty, Note, Pill, Scroller } from "@/components/ui";
import { all, one } from "@/lib/db";
import { applyImport, decideRow, uploadCsv } from "@/lib/actions";
import { SOURCES, type SourceKey } from "@/lib/importer";
import { fmt, SOURCE_FULL } from "@/lib/format";

export const dynamic = "force-dynamic";

const STEPS: [number, string, string][] = [
  [1, "1 · 소스 선택", "어디서 온 파일인가"],
  [2, "2 · 컬럼 매핑", "우리 스키마에 붙이기"],
  [3, "3 · 중복 검사", "병합 대상 확인"],
  [4, "4 · 반영", "결과"],
];

const ERRORS: Record<string, string> = {
  nofile: "파일이 선택되지 않았습니다.",
  badsource: "알 수 없는 소스입니다.",
  empty: "데이터 행이 없습니다. 헤더만 있는 파일인지 확인하세요.",
};

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; src?: string; batch?: string; err?: string; created?: string; updated?: string; skipped?: string }>;
}) {
  const sp = await searchParams;
  const step = [1, 2, 3, 4].includes(Number(sp.step)) ? Number(sp.step) : 1;
  const src = (sp.src && sp.src in SOURCES ? sp.src : "pang") as SourceKey;
  const profile = SOURCES[src];

  const batchId = sp.batch ? Number(sp.batch) : undefined;
  const batch = batchId
    ? one<{ id: number; source: string; filename: string; rows: number; created: number; updated: number; review: number; errors: number; status: string; created_at: string }>(
        `SELECT * FROM import_batch WHERE id = ?`, [batchId],
      )
    : one<{ id: number; source: string; filename: string; rows: number; created: number; updated: number; review: number; errors: number; status: string; created_at: string }>(
        `SELECT * FROM import_batch WHERE status='analyzed' ORDER BY created_at DESC LIMIT 1`,
      );

  const reviewRows = batch
    ? all<{ id: number; line_no: number; raw: string; handle_norm: string | null; score: number | null; reason: string; match_id: number | null; decision: string | null }>(
        `SELECT id, line_no, raw, handle_norm, score, reason, match_id, decision
           FROM import_row WHERE batch_id=? AND verdict='review' ORDER BY line_no`,
        [batch.id],
      )
    : [];

  const matchHandles = Object.fromEntries(
    all<{ id: number; handle: string }>(`SELECT id, handle FROM social_account`).map((r) => [r.id, r.handle]),
  ) as Record<number, string>;

  const history = all<{ created_at: string; source: string; filename: string; rows: number; created: number; updated: number; errors: number; uploaded_by: string; status: string }>(
    `SELECT created_at, source, filename, rows, created, updated, errors, uploaded_by, status
       FROM import_batch ORDER BY created_at DESC LIMIT 12`,
  );

  const link = (n: number) => `/import?step=${n}&src=${src}${batch ? `&batch=${batch.id}` : ""}`;

  return (
    <Shell path="/import" title="데이터 임포트" sub="CSV 업로드 → 정규화 → 병합">
      <section className="screen">
        <div className="steps">
          {STEPS.map(([n, a, b]) => (
            <Link key={n} href={link(n)} aria-current={step === n ? "step" : undefined} scroll={false}>
              <b>{a}</b>
              <span>{b}</span>
            </Link>
          ))}
        </div>

        {sp.err && <Note tone="stop">{ERRORS[sp.err] ?? "업로드에 실패했습니다."}</Note>}

        {step === 1 && (
          <form action={uploadCsv}>
            <div className="srccards" style={{ marginBottom: 16 }}>
              {(Object.keys(SOURCES) as SourceKey[]).map((k) => (
                <label key={k} className="srccard" aria-pressed={k === src}>
                  <input
                    type="radio"
                    name="source"
                    value={k}
                    defaultChecked={k === src}
                    style={{ marginRight: 6 }}
                  />
                  <b style={{ display: "inline" }}>{SOURCES[k].name}</b> <code>{SOURCES[k].site}</code>
                  <p>{SOURCES[k].blurb}</p>
                </label>
              ))}
            </div>

            <label className="dropzone">
              <b>CSV 파일 선택</b>
              <span>헤더가 있는 UTF-8 CSV 를 올리세요. 원문·이미지는 저장하지 않습니다.</span>
              <input type="file" name="file" accept=".csv,text/csv" required style={{ marginTop: 12 }} />
            </label>

            <div style={{ marginTop: 16 }}>
              <Note tone="stop">
                <b>업로드 전 확인.</b> 세 사이트 모두 이용약관에서 자동 수집과 데이터 재사용을 명시적으로
                금지합니다(공구팡팡 제10조, 인공 제7·11조). 이 임포터는 원문·이미지를 저장하지 않고{" "}
                <b>파생 지표와 원본 링크</b>만 보관합니다. 상업적 재배포 전에는 각 사이트와 제휴 협의를 권합니다.
              </Note>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
              <button className="btn pri" type="submit">업로드 후 중복 검사</button>
              <Link className="btn" href={link(2)}>컬럼 매핑 먼저 보기</Link>
              <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                테스트용 샘플: <code className="mono">samples/09pangpang_sample.csv</code>
              </span>
            </div>
          </form>
        )}

        {step === 2 && (
          <>
            <Card title={`컬럼 매핑 — ${profile.name}`} hint="업로드 시 이 규칙으로 자동 추론합니다">
              <div className="card-b">
                {profile.fields.map((f) => (
                  <div className="maprow" key={f.column}>
                    <code>{f.column}</code>
                    <span className="arw">→</span>
                    <span>
                      <b>{f.target}</b>{" "}
                      {f.note && <span style={{ color: "var(--ink-3)" }}>{f.note}</span>}
                    </span>
                    <Pill tone={f.rule === "parse" ? "k-warn" : f.rule === "keep" ? "k-acc" : "k-ok"}>
                      {f.rule === "parse" ? "파싱 규칙" : f.rule === "keep" ? "보존" : "자동"}
                    </Pill>
                  </div>
                ))}
              </div>
            </Card>

            {profile.forbiddenKeys?.map((f) => (
              <Note tone="warn" key={f.column}>
                <b>
                  <code className="mono">{f.column}</code> 은 매칭 키로 쓸 수 없습니다.
                </b>{" "}
                {f.reason}
              </Note>
            ))}

            <Note>
              팔로워 파싱은 반올림 오차를 함께 저장합니다 — <code className="mono">&quot;10.8만&quot;</code> 은
              108,000 이고 정밀도 플래그 ±500 이 붙습니다. 이 오차를 무시하면 중복 검사에서 같은 사람을 다른 사람으로
              판정합니다.
            </Note>

            <div style={{ display: "flex", gap: 8 }}>
              <Link className="btn" href={link(1)}>이전</Link>
              <Link className="btn pri" href={link(3)}>중복 검사 결과</Link>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            {!batch ? (
              <Card>
                <Empty>
                  분석된 배치가 없습니다. <Link href={link(1)}>1단계</Link>에서 CSV 를 올리세요.
                </Empty>
              </Card>
            ) : (
              <>
                <div className="kpis">
                  <div className="kpi"><span className="lab">읽은 행</span><div className="val">{fmt(batch.rows)}</div></div>
                  <div className="kpi"><span className="lab">신규</span><div className="val" style={{ color: "var(--ok)" }}>{fmt(batch.created)}</div></div>
                  <div className="kpi"><span className="lab">자동 병합</span><div className="val">{fmt(batch.updated)}<small>≥0.95</small></div></div>
                  <div className="kpi"><span className="lab">검토 필요</span><div className="val" style={{ color: "var(--warn)" }}>{fmt(batch.review)}<small>0.80~0.95</small></div></div>
                  <div className="kpi"><span className="lab">오류</span><div className="val" style={{ color: "var(--stop)" }}>{fmt(batch.errors)}</div></div>
                </div>

                <Card
                  title="검토 큐"
                  hint={`${SOURCE_FULL[batch.source] ?? batch.source} · ${batch.filename} · 사람이 판단해야 하는 ${fmt(reviewRows.length)}건`}
                >
                  {reviewRows.length === 0 ? (
                    <Empty>검토가 필요한 행이 없습니다.</Empty>
                  ) : (
                    <Scroller wide>
                      <table>
                        <thead>
                          <tr><th>행</th><th>유입 행</th><th>매칭 후보</th><th>점수</th><th>근거</th><th>처리</th></tr>
                        </thead>
                        <tbody>
                          {reviewRows.map((r) => {
                            const raw = JSON.parse(r.raw) as Record<string, string>;
                            const incoming = raw.handle ?? raw.instagram ?? r.handle_norm ?? "—";
                            const candidate = r.match_id ? matchHandles[r.match_id] : (raw.match ?? "—");
                            return (
                              <tr key={r.id} style={r.decision ? { opacity: 0.5 } : undefined}>
                                <td className="num">{r.line_no}</td>
                                <td className="mono">@{String(incoming).replace(/^@/, "")}</td>
                                <td className="mono">@{String(candidate).replace(/^@/, "")}</td>
                                <td className="num">{r.score?.toFixed(2) ?? "—"}</td>
                                <td style={{ fontSize: 11.5 }}>{r.reason}</td>
                                <td>
                                  {r.decision ? (
                                    <Pill tone={r.decision === "merge" ? "k-ok" : "k-mute"}>
                                      {r.decision === "merge" ? "병합 예정" : "분리 예정"}
                                    </Pill>
                                  ) : (
                                    <span style={{ display: "flex", gap: 4 }}>
                                      <form action={decideRow}>
                                        <input type="hidden" name="rowId" value={r.id} />
                                        <input type="hidden" name="decision" value="merge" />
                                        <button className="btn sm" type="submit">병합</button>
                                      </form>
                                      <form action={decideRow}>
                                        <input type="hidden" name="rowId" value={r.id} />
                                        <input type="hidden" name="decision" value="split" />
                                        <button className="btn sm" type="submit">분리</button>
                                      </form>
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </Scroller>
                  )}
                </Card>

                {batch.errors > 0 && (
                  <Note tone="warn">
                    <b>오류 {fmt(batch.errors)}건의 대부분은 핸들 누락입니다.</b> 팔로워만 있고 핸들이 없는 행은 매칭 키가
                    없어 저장하지 않습니다. 소스에서 핸들 컬럼을 다시 받아야 합니다.
                  </Note>
                )}

                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Link className="btn" href={link(2)}>이전</Link>
                  {batch.status === "applied" ? (
                    <Pill tone="k-ok">이미 반영된 배치입니다</Pill>
                  ) : (
                    <form action={applyImport}>
                      <input type="hidden" name="batchId" value={batch.id} />
                      <button className="btn pri" type="submit">
                        {fmt(batch.created + batch.updated + reviewRows.filter((r) => r.decision).length)}건 반영
                      </button>
                    </form>
                  )}
                  <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                    미처리 검토 행은 반영되지 않고 큐에 남습니다.
                  </span>
                </div>
              </>
            )}
          </>
        )}

        {step === 4 && (
          <>
            <Card>
              <div className="card-b" style={{ textAlign: "center", padding: "44px 20px" }}>
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 30, fontWeight: 600, color: "var(--ok)" }}>
                  {fmt(Number(sp.created ?? 0) + Number(sp.updated ?? 0))}
                </div>
                <div style={{ marginTop: 6, fontSize: 14 }}>건 반영 완료</div>
                <p className="lede" style={{ margin: "12px auto 0", maxWidth: "52ch" }}>
                  신규 {fmt(Number(sp.created ?? 0))}명이 인플루언서 DB 에 추가되고,{" "}
                  {fmt(Number(sp.updated ?? 0))}명의 스냅샷이 갱신됐습니다. 미처리 {fmt(Number(sp.skipped ?? 0))}건은
                  검토 큐에 그대로 남아 있습니다.
                </p>
                <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 18 }}>
                  <Link className="btn" href={link(3)}>검토 큐로</Link>
                  <Link className="btn pri" href="/influencers">인플루언서 DB 보기</Link>
                </div>
              </div>
            </Card>

            <Card title="임포트 이력">
              <Scroller wide>
                <table>
                  <thead>
                    <tr><th>일시</th><th>소스</th><th>파일</th><th>행</th><th>신규</th><th>갱신</th><th>오류</th><th>담당</th><th>상태</th></tr>
                  </thead>
                  <tbody>
                    {history.map((h, i) => (
                      <tr key={i}>
                        <td className="num">{h.created_at}</td>
                        <td>{SOURCE_FULL[h.source] ?? h.source}</td>
                        <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{h.filename}</td>
                        <td className="num">{fmt(h.rows)}</td>
                        <td className="num">{fmt(h.created)}</td>
                        <td className="num">{fmt(h.updated)}</td>
                        <td className="num">{fmt(h.errors)}</td>
                        <td>{h.uploaded_by}</td>
                        <td>
                          {h.status === "applied" ? <Pill tone="k-ok">반영됨</Pill> : <Pill tone="k-warn">미반영</Pill>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroller>
            </Card>
          </>
        )}
      </section>
    </Shell>
  );
}
