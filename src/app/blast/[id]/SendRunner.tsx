"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { sendStep } from "../actions";
import type { SendProgress } from "@/lib/blast";

/**
 * 발송 구동기.
 *
 * 1만 명을 한 요청에 보낼 수 없다 — 서버리스 제한 시간에 걸린다. 청크로 나눠
 * 돌리면서 진행을 보여준다. 탭을 닫아도 보낸 것은 보낸 것으로 남고, 다시
 * 들어오면 남은 지점부터 이어진다.
 *
 * 시작 버튼을 한 번 더 누르게 한다. 이 버튼은 실제로 메일이 나가는 자리다 —
 * 화면에 들어온 것만으로 나가면 안 된다.
 */
export default function SendRunner({
  blastId,
  total,
  auto,
}: {
  blastId: string;
  total: number;
  auto: boolean;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [st, setSt] = useState<{ sent: number; queued: number; blocked: number; remaining: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 상한에 걸려 멈춘 것은 오류가 아니다. 오류로 보여 주면 다시 누르게 되고,
  // 다시 눌러도 0건이 나가면서 무언가 고장난 것처럼 보인다.
  const [paced, setPaced] = useState<string | null>(null);
  const loop = useRef(false);

  useEffect(() => {
    if (!running || loop.current) return;
    loop.current = true;
    let cancelled = false;

    (async () => {
      const acc = { sent: 0, queued: 0, blocked: 0, remaining: total };
      try {
        for (let guard = 0; guard < 2000; guard++) {
          const r: SendProgress = await sendStep(blastId);
          if (cancelled) return;
          acc.sent += r.sent;
          acc.queued += r.queued;
          acc.blocked += r.blocked;
          acc.remaining = r.remaining;
          setSt({ ...acc });
          if (r.done) {
            router.push(`/blast/${blastId}?step=5`);
            return;
          }
          // 오늘 몫을 다 썼으면 이어 돌리지 않는다. 계속 호출해도 0건이다.
          if (r.paced) {
            setPaced(r.paced);
            return;
          }
        }
        setErr("발송이 끝나지 않습니다. 남은 대상을 확인하세요.");
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        loop.current = false;
      }
    })();

    return () => { cancelled = true; };
  }, [running, blastId, total, router]);

  const doneCount = (st?.sent ?? 0) + (st?.queued ?? 0) + (st?.blocked ?? 0);
  const pct = total > 0 ? Math.min(100, Math.round((doneCount / total) * 100)) : 0;

  if (!running) {
    return (
      <div className="card-b">
        <p className="lede" style={{ margin: "0 0 14px" }}>
          대상 <b>{total.toLocaleString("ko-KR")}명</b>{auto
            ? " 에게 지금 실제로 메일이 나갑니다."
            : " 의 문안이 작업 큐에 쌓입니다. 사람이 폼에 붙여넣는 채널입니다."}
        </p>
        <button className="btn pri" type="button" onClick={() => setRunning(true)}>
          {auto ? `${total.toLocaleString("ko-KR")}명에게 발송 시작` : `${total.toLocaleString("ko-KR")}건 작업 큐에 넣기`}
        </button>
        {auto && (
          <p className="subnote" style={{ marginTop: 10 }}>
            시작하면 중간에 멈출 수 없습니다. 3단계에서 테스트 발송으로 문안을 먼저 확인하세요.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="card-b">
      <div className="prog"><i style={{ width: `${pct}%` }} /></div>
      <div className="mono" style={{ fontSize: 12.5, marginTop: 10 }}>
        {st
          ? `발송 ${st.sent.toLocaleString("ko-KR")} · 큐 ${st.queued.toLocaleString("ko-KR")} · 건너뜀 ${st.blocked.toLocaleString("ko-KR")} · 남음 ${st.remaining.toLocaleString("ko-KR")}`
          : "시작 중…"}
      </div>
      {err && <p className="bad" style={{ marginTop: 10 }}>{err}</p>}
      {paced && (
        <div className="pacestop">
          <b>오늘 발송을 여기서 멈췄습니다.</b>
          <p>{paced}</p>
          <p className="subnote">
            도메인 평판을 지키려고 일부러 멈추는 것입니다. 내일 이 화면에 다시 들어와
            같은 버튼을 누르면 남은 대상부터 이어집니다.
          </p>
        </div>
      )}
      {!err && !paced && <p className="subnote" style={{ marginTop: 8 }}>이 탭을 닫아도 보낸 것은 남습니다.</p>}
    </div>
  );
}
