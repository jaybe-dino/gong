"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { commitStep, finalizeImport, matchStep, type StepResult } from "@/lib/actions";

/**
 * 임포트 진행 구동기.
 *
 * 이 프로젝트의 화면은 전부 서버 컴포넌트이고 상호작용은 폼으로 한다. 여기만 예외다 —
 * 1.9만 행을 한 요청에 처리할 수 없어서 청크로 나눠 돌리는데, 사용자가 '계속' 버튼을
 * 네 번 누르게 하는 대신 화면이 스스로 이어 돌린다.
 *
 * 각 청크는 서버 액션이다. 중간에 탭을 닫아도 처리한 행은 DB 에 남고, 다시 들어오면
 * 남은 지점부터 이어진다.
 */
export default function Progress({
  batchId,
  phase,
  label,
}: {
  batchId: string;
  phase: "match" | "commit";
  label: string;
}) {
  const router = useRouter();
  const [st, setSt] = useState<StepResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tail, setTail] = useState<{ events: number; excluded: number } | null>(null);
  const running = useRef(false);

  useEffect(() => {
    if (running.current) return;
    running.current = true;
    let cancelled = false;

    (async () => {
      try {
        for (let guard = 0; guard < 500; guard++) {
          const r = phase === "match" ? await matchStep(batchId) : await commitStep(batchId);
          if (cancelled) return;
          setSt(r);
          if (r.done) {
            if (phase === "commit") setTail(await finalizeImport(batchId));
            router.refresh();
            return;
          }
        }
        setErr("진행이 끝나지 않습니다. 남은 행을 확인하세요.");
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [batchId, phase, router]);

  const pct = st && st.total > 0 ? Math.round((st.processed / st.total) * 100) : 0;

  return (
    <div className="prog" role="status" aria-live="polite">
      <div className="prog-top">
        <b>{err ? "중단됨" : st?.done ? `${label} 완료` : label}</b>
        {st ? (
          <span className="mono">
            {st.processed.toLocaleString("ko-KR")} / {st.total.toLocaleString("ko-KR")}행
          </span>
        ) : (
          <span className="mono">준비 중…</span>
        )}
      </div>
      <div className="prog-bar">
        <i style={{ width: `${err ? 100 : pct}%` }} className={err ? "bad" : undefined} />
      </div>
      {err ? <p className="prog-note bad">{err}</p> : null}
      {st?.note ? <p className="prog-note">{st.note}</p> : null}
      {tail ? (
        <p className="prog-note">
          변화 이벤트 {tail.events.toLocaleString("ko-KR")}건 · 브랜드 충돌 자동 제외{" "}
          {tail.excluded.toLocaleString("ko-KR")}건
        </p>
      ) : null}
      {!err && !st?.done ? (
        <p className="prog-note">
          창을 닫아도 처리한 행은 남습니다. 다시 들어오면 이어서 진행합니다.
        </p>
      ) : null}
    </div>
  );
}
