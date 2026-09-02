import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Empty, Note, Pill, Scroller } from "@/components/ui";
import { all, one } from "@/lib/db";
import { commitImport, decideMerge, uploadCsv } from "@/lib/actions";
import { SOURCES, type SourceKey } from "@/lib/importer";
import { fmt, SOURCE_FULL } from "@/lib/format";

export const dynamic = "force-dynamic";

const STEPS: [number, string, string][] = [
  [1, "1 · 소스 선택", "어디서 온 파일인가"],
  [2, "2 · 컬럼 매핑", "우리 스키마에 붙이기"],
  [3, "3 · 중복 검사", "병합 대상 확인 (dry-run)"],
  [4, "4 · 반영", "커밋 결과"],
];

const ERRORS: Record<string, string> = {
  nofile: "파일이 선택되지 않았습니다.",
  badsource: "알 수 없는 소스입니다.",
  empty: "데이터 행이 없습니다. 헤더만 있는 파일인지 확인하세요.",
};

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; src?: string; batch?: string; err?: string; created?: string; merged?: string; skipped?: string; events?: string }>;
}) {
  const sp = await searchParams;
  const step = [1, 2, 3, 4].includes(Number(sp.step)) ? Number(sp.step) : 1;
  const src = (sp.src && sp.src in SOURCES ? sp.src : "pangpang") as SourceKey;
  const profile = SOURCES[src];

  const batch = sp.batch
    ? await one<Batch>(`SELECT ${BATCH_COLS} FROM import_batch WHERE id=$1`, [sp.batch])
    : await one<Batch>(`SELECT ${BATCH_COLS} FROM import_batch WHERE state='dry_run' ORDER BY created_at DESC LIMIT 1`);

  const [candidates, history] = await Promise.all([
    batch
      ? all<{ id: string; incoming: { handle: string; line: number; handleChanged: boolean }; score: string; evidence: string; decision: string | null; candidate_handle: string | null; candidate_name: string | null }>(
          `SELECT mc.id, mc.incoming, mc.score, mc.evidence, mc.decision,
                  sa.handle AS candidate_handle, c.display_name AS candidate_name
             FROM merge_candidate mc
             LEFT JOIN creator c ON c.id = mc.candidate_id
             LEFT JOIN social_account sa ON sa.creator_id = c.id
            WHERE mc.batch_id=$1 ORDER BY (mc.incoming->>'line')::int`,
          [batch.id])
      : Promise.resolve([]),
    all<{ id: string; source: string; filename: string; observed_at: string; rows_read: number; rows_new: number; rows_merged: number; rows_review: number; rows_error: number; state: string; uploader: string }>(
      `SELECT b.id, b.source, b.filename, to_char(b.observed_at,'YYYY-MM-DD HH24:MI') AS observed_at,
              b.rows_read, b.rows_new, b.rows_merged, b.rows_review, b.rows_error, b.state,
              COALESCE(u.name,'—') AS uploader
         FROM import_batch b LEFT JOIN app_user u ON u.id=b.uploaded_by
        ORDER BY b.observed_at DESC LIMIT 12`),
  ]);

  const link = (n: number) => `/import?step=${n}&src=${src}${batch ? `&batch=${batch.id}` : ""}`;
  const decided = candidates.filter((c) => c.decision).length;

  return (
    <Shell path="/import" title="데이터 임포트" sub="CSV 업로드 → 정규화 → 병합">
      <section className="screen">
        <div className="steps">
          {STEPS.map(([n, a, b]) => (
            <Link key={n} href={link(n)} aria-current={step === n ? "step" : undefined} scroll={false}>
              <b>{a}</b><span>{b}</span>
            </Link>
          ))}
        </div>

        {sp.err && <Note tone="stop">{ERRORS[sp.err] ?? "업로드에 실패했습니다."}</Note>}

        {step === 1 && (
          <form action={uploadCsv}>
            <div className="srccards" style={{ marginBottom: 16 }}>
              {(Object.keys(SOURCES) as SourceKey[]).map((k) => (
                <label key={k} className="srccard" aria-pressed={k === src}>
                  <input type="radio" name="source" value={k} defaultChecked={k === src} style={{ marginRight: 6 }} />
                  <b style={{ display: "inline" }}>{SOURCES[k].name}</b> <code>{SOURCES[k].site}</code>
                  <p>{SOURCES[k].blurb}</p>
                </label>
              ))}
            </div>

            <label className="dropzone">
              <b>CSV 파일 선택</b>
              <span>헤더가 있는 UTF-8 CSV. 원문·이미지는 저장하지 않고 파생 지표와 링크백만 보관합니다.</span>
              <input type="file" name="file" accept=".csv,text/csv" required style={{ marginTop: 12 }} />
            </label>

            <div style={{ marginTop: 16 }}>
              <Note tone="stop">
                <b>업로드 전 확인.</b> 세 사이트 모두 이용약관에서 자동 수집과 데이터 재사용을 금지합니다. 이
                임포터는 사람이 내려받은 파일을 올리는 경로만 제공하며, 상업적 재배포 전에는 각 사이트와 제휴
                협의를 권합니다.
              </Note>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn pri" type="submit">업로드 후 중복 검사 (dry-run)</button>
              <Link className="btn" href={link(2)}>컬럼 매핑 먼저 보기</Link>
              <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                테스트용 샘플: <code className="mono">samples/pangpang.csv · ingong.csv · momcal.csv</code>
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
                    <span><b>{f.target}</b> {f.note && <span style={{ color: "var(--ink-3)" }}>{f.note}</span>}</span>
                    <Pill tone={f.rule === "parse" ? "k-warn" : f.rule === "keep" ? "k-acc" : "k-ok"}>
                      {f.rule === "parse" ? "파싱 규칙" : f.rule === "keep" ? "보존" : "자동"}
                    </Pill>
                  </div>
                ))}
              </div>
            </Card>

            {profile.forbiddenKeys?.map((f) => (
              <Note tone="warn" key={f.column}>
                <b><code className="mono">{f.column}</code> 은 매칭 키로 쓸 수 없습니다.</b> {f.reason}
              </Note>
            ))}

            <Note>
              <b>필드 서바이버십.</b> 같은 필드를 여러 소스가 주면 소스별 우선순위로 판정합니다 — 팔로워·팔로잉·게시물은
              공구팡팡, 30·90일 딜 수와 평균 간격은 인공, 브랜드와 큐레이션 플래그는 맘캘린더가 이깁니다. 각 소스가
              기여하는 고유 필드가 달라 하나로 대체되지 않기 때문입니다.
            </Note>

            <div style={{ display: "flex", gap: 8 }}>
              <Link className="btn" href={link(1)}>이전</Link>
              <Link className="btn pri" href={link(3)}>중복 검사 결과</Link>
            </div>
          </>
        )}

        {step === 3 && (
          !batch ? (
            <Card><Empty>분석된 배치가 없습니다. <Link href={link(1)}>1단계</Link>에서 CSV 를 올리세요.</Empty></Card>
          ) : (
            <>
              <div className="kpis">
                <div className="kpi"><span className="lab">읽은 행</span><div className="val">{fmt(batch.rows_read)}</div></div>
                <div className="kpi"><span className="lab">신규</span><div className="val" style={{ color: "var(--ok)" }}>{fmt(batch.rows_new)}</div></div>
                <div className="kpi"><span className="lab">자동 병합</span><div className="val">{fmt(batch.rows_merged)}<small>≥0.95</small></div></div>
                <div className="kpi"><span className="lab">검토 필요</span><div className="val" style={{ color: "var(--warn)" }}>{fmt(batch.rows_review)}<small>0.80~0.95</small></div></div>
                <div className="kpi"><span className="lab">오류</span><div className="val" style={{ color: "var(--stop)" }}>{fmt(batch.rows_error)}</div></div>
              </div>

              <Card title="검토 큐" hint={`${SOURCE_FULL[batch.source] ?? batch.source} · ${batch.filename} · 사람이 판단해야 하는 ${fmt(candidates.length)}건`}>
                {candidates.length === 0 ? <Empty>검토가 필요한 행이 없습니다.</Empty> : (
                  <Scroller wide>
                    <table>
                      <thead><tr><th>행</th><th>유입</th><th>매칭 후보</th><th>점수</th><th>근거</th><th>처리</th></tr></thead>
                      <tbody>
                        {candidates.map((c) => (
                          <tr key={c.id} style={c.decision ? { opacity: 0.5 } : undefined}>
                            <td className="num">{c.incoming?.line ?? "—"}</td>
                            <td className="mono">@{c.incoming?.handle}</td>
                            <td className="mono">
                              {c.candidate_handle ? `@${c.candidate_handle}` : "—"}
                              {c.candidate_name && <><br /><span style={{ fontSize: 11, color: "var(--ink-3)" }}>{c.candidate_name}</span></>}
                            </td>
                            <td className="num">{Number(c.score).toFixed(2)}</td>
                            <td style={{ fontSize: 11.5 }}>
                              {c.evidence}
                              {c.incoming?.handleChanged && <> <Pill tone="k-warn">핸들 변경</Pill></>}
                            </td>
                            <td>
                              {c.decision ? (
                                <Pill tone={c.decision === "merge" ? "k-ok" : "k-mute"}>
                                  {c.decision === "merge" ? "병합 예정" : "분리 예정"}
                                </Pill>
                              ) : (
                                <span style={{ display: "flex", gap: 4 }}>
                                  <form action={decideMerge}>
                                    <input type="hidden" name="id" value={c.id} />
                                    <input type="hidden" name="decision" value="merge" />
                                    <button className="btn sm" type="submit">병합</button>
                                  </form>
                                  <form action={decideMerge}>
                                    <input type="hidden" name="id" value={c.id} />
                                    <input type="hidden" name="decision" value="split" />
                                    <button className="btn sm" type="submit">분리</button>
                                  </form>
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Scroller>
                )}
              </Card>

              {batch.rows_error > 0 && (
                <Note tone="warn">
                  <b>오류 {fmt(batch.rows_error)}건은 저장하지 않습니다.</b> 핸들이 없는 행과 슬러그만 있는 행이
                  여기 들어옵니다. 슬러그는 <code className="mono">.</code> 과 <code className="mono">_</code> 를
                  구분할 수 없어 매칭 키가 될 수 없습니다.
                </Note>
              )}

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Link className="btn" href={link(2)}>이전</Link>
                {batch.state === "committed" ? <Pill tone="k-ok">이미 반영된 배치입니다</Pill> : (
                  <form action={commitImport}>
                    <input type="hidden" name="batchId" value={batch.id} />
                    <button className="btn pri" type="submit">
                      {fmt(batch.rows_new + batch.rows_merged + decided)}건 반영
                    </button>
                  </form>
                )}
                <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                  미처리 검토 행 {fmt(candidates.length - decided)}건은 반영되지 않고 큐에 남습니다.
                </span>
              </div>
            </>
          )
        )}

        {step === 4 && (
          <>
            <Card>
              <div className="card-b" style={{ textAlign: "center", padding: "44px 20px" }}>
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 30, fontWeight: 600, color: "var(--ok)" }}>
                  {fmt(Number(sp.created ?? 0) + Number(sp.merged ?? 0))}
                </div>
                <div style={{ marginTop: 6, fontSize: 14 }}>건 반영 완료</div>
                <p className="lede" style={{ margin: "12px auto 0", maxWidth: "52ch" }}>
                  신규 {fmt(sp.created ?? 0)}명이 추가되고 {fmt(sp.merged ?? 0)}명의 스냅샷이 갱신됐습니다.
                  미처리 {fmt(sp.skipped ?? 0)}건은 검토 큐에 남아 있고, 변화 이벤트 {fmt(sp.events ?? 0)}건이 생성됐습니다.
                </p>
                <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 18 }}>
                  <Link className="btn" href={link(3)}>검토 큐로</Link>
                  <Link className="btn" href="/watch">변화 감지 보기</Link>
                  <Link className="btn pri" href="/influencers">인플루언서 DB 보기</Link>
                </div>
              </div>
            </Card>

            <Card title="임포트 이력">
              <Scroller wide>
                <table>
                  <thead><tr><th>일시</th><th>소스</th><th>파일</th><th>행</th><th>신규</th><th>병합</th><th>검토</th><th>오류</th><th>담당</th><th>상태</th></tr></thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td className="num">{h.observed_at}</td>
                        <td>{SOURCE_FULL[h.source] ?? h.source}</td>
                        <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{h.filename}</td>
                        <td className="num">{fmt(h.rows_read)}</td>
                        <td className="num">{fmt(h.rows_new)}</td>
                        <td className="num">{fmt(h.rows_merged)}</td>
                        <td className="num">{fmt(h.rows_review)}</td>
                        <td className="num">{fmt(h.rows_error)}</td>
                        <td>{h.uploader}</td>
                        <td>{h.state === "committed" ? <Pill tone="k-ok">반영됨</Pill> : <Pill tone="k-warn">dry-run</Pill>}</td>
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

const BATCH_COLS = `id, source, filename, rows_read, rows_new, rows_merged, rows_review, rows_error, state,
  to_char(observed_at,'YYYY-MM-DD HH24:MI') AS observed_at`;

interface Batch {
  id: string; source: string; filename: string;
  rows_read: number; rows_new: number; rows_merged: number; rows_review: number; rows_error: number;
  state: string; observed_at: string;
}
