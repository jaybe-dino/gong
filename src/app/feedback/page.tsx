import Shell from "@/components/Shell";
import { Card, Empty, Note, Pill } from "@/components/ui";
import { hasTable } from "@/lib/schema";
import * as fb from "@/lib/feedback";
import { changeStatus, removeFeedback, saveNote } from "./actions";

export const dynamic = "force-dynamic";

/**
 * 개선 제보 목록.
 *
 * 상태를 요청 → 확인됨 → 개발중 → 완료로 나눈다. 제보한 사람이 "봤는지" 를
 * 알 수 있어야 같은 제보가 반복되지 않는다. 그래서 상태 버튼을 목록 안에
 * 그대로 둔다 — 상세로 들어가야 바꿀 수 있으면 아무도 안 바꾼다.
 */

const VIEWS = [
  { key: "", label: "진행 중", countKey: "open_total" },
  { key: "open", label: "요청", countKey: "open" },
  { key: "planned", label: "확인됨", countKey: "planned" },
  { key: "doing", label: "개발중", countKey: "doing" },
  { key: "done", label: "완료", countKey: "done" },
  { key: "wontfix", label: "보류", countKey: "wontfix" },
  { key: "all", label: "전체", countKey: "all" },
];

function Ctx({ ctx }: { ctx: Record<string, unknown> }) {
  const trace = Array.isArray(ctx.trace) ? (ctx.trace as { path: string }[]) : [];
  const errors = Array.isArray(ctx.errors) ? (ctx.errors as { t: string; msg: string; src?: string }[]) : [];
  const line = [ctx.viewport, ctx.tz, ctx.lang].filter(Boolean).join(" · ");
  return (
    <details className="fbdet">
      <summary>재현 정보</summary>
      <div className="fbdetb">
        {line && <p className="mono">{line}</p>}
        {typeof ctx.ua === "string" && <p className="mono fbua">{ctx.ua}</p>}
        {trace.length > 0 && (
          <p className="mono">
            거쳐 온 화면: {trace.map((v) => v.path).join(" → ")}
          </p>
        )}
        {errors.length > 0 && (
          <div className="fberrs">
            <b>자바스크립트 오류 {errors.length}건</b>
            <ul>
              {errors.map((e, i) => (
                <li key={i} className="mono">
                  {e.msg}{e.src ? ` (${e.src})` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>;
}) {
  const { v = "" } = await searchParams;
  const ready = await hasTable("feedback");

  if (!ready) {
    return (
      <Shell path="/feedback" title="개선 제보" sub="스키마 적용 필요">
        <Card title="아직 준비되지 않았습니다">
          <div className="card-b">
            <Note tone="warn">
              제보 표가 없습니다. <a href="/setup">초기 설정</a> 의 「스키마 적용」을 눌러
              마이그레이션을 적용하면 이 화면이 동작합니다. 데이터는 보존됩니다.
            </Note>
          </div>
        </Card>
      </Shell>
    );
  }

  const [rows, counts] = await Promise.all([fb.list(v || undefined), fb.counts()]);
  const shots = await Promise.all(rows.map((r) => (r.images ? fb.images(r.id) : [])));

  return (
    <Shell path="/feedback" title="개선 제보"
           sub={`진행 중 ${counts.open_total ?? 0}건 · 전체 ${counts.all ?? 0}건`}>
      <Card title="상태" hint="오른쪽 아래 「개선사항 제보」 버튼으로 들어옵니다">
        <div className="card-b">
          <div className="fbtabs">
            {VIEWS.map((t) => (
              <a key={t.key} href={t.key ? `/feedback?v=${t.key}` : "/feedback"}
                 className={`fbtab${v === t.key ? " on" : ""}`}>
                {t.label}
                <em className="mono">{counts[t.countKey] ?? 0}</em>
              </a>
            ))}
          </div>
        </div>
      </Card>

      {rows.length === 0 ? (
        <Card title="제보 없음">
          <div className="card-b">
            <Empty>
              이 보기에는 제보가 없습니다. 화면 오른쪽 아래 <b>「개선사항 제보」</b> 버튼으로
              어느 화면에서든 남길 수 있습니다.
            </Empty>
          </div>
        </Card>
      ) : (
        rows.map((r, i) => (
          <div className="card fbcard" key={r.id} id={r.id}>
            <div className="card-h">
              <div className="fbtitle">
                <Pill tone={fb.STATUS_TONE[r.status] || ""}>{fb.STATUS_LABEL[r.status]}</Pill>
                <Pill tone="">{fb.KIND_LABEL[r.kind]}</Pill>
                <b>{r.title}</b>
              </div>
              <span className="fbmeta mono">
                {r.author ?? "익명"} · {r.created_at}
                {r.done_at && ` · 완료 ${r.done_at}`}
              </span>
            </div>

            <div className="card-b">
              {r.body && <pre className="fbtext">{r.body}</pre>}

              <p className="fbwhere mono">
                {r.page_path
                  ? <>제보한 화면 <a href={r.page_path}>{r.page_path}</a>
                      {r.page_title ? ` · ${r.page_title}` : ""}</>
                  : "화면 정보 없음"}
              </p>

              {shots[i].length > 0 && (
                <div className="fbimgs">
                  {shots[i].map((im) => (
                    <a key={im.id} href={`/api/feedback/image/${im.id}`}
                       target="_blank" rel="noopener noreferrer">
                      {/* 첨부 크기가 제각각이라 next/image 의 고정 크기가 맞지 않는다 */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/feedback/image/${im.id}`} alt={im.filename ?? "첨부"} />
                    </a>
                  ))}
                </div>
              )}

              <Ctx ctx={r.context ?? {}} />

              {r.note && (
                <div className="fbnote">
                  <b>처리 메모</b>
                  <pre>{r.note}</pre>
                </div>
              )}

              <div className="fbactions">
                {fb.STATUSES.filter((s) => s.key !== r.status).map((s) => (
                  <form action={changeStatus} key={s.key}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="status" value={s.key} />
                    <button className="btn sm" type="submit">→ {s.label}</button>
                  </form>
                ))}
                <form action={removeFeedback} className="fbdel">
                  <input type="hidden" name="id" value={r.id} />
                  <button className="btn sm danger" type="submit">삭제</button>
                </form>
              </div>

              <form action={saveNote} className="fbnoteform">
                <input type="hidden" name="id" value={r.id} />
                <input name="note" defaultValue={r.note ?? ""}
                       placeholder="처리 메모 — 무엇을 어떻게 고쳤는지, 왜 보류인지" />
                <button className="btn sm" type="submit">메모 저장</button>
              </form>
            </div>
          </div>
        ))
      )}
    </Shell>
  );
}
