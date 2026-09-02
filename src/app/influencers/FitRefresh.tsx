"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fitStep } from "@/lib/actions";

/**
 * 적합도 점수 계산 배너.
 *
 * 점수가 없는 크리에이터를 조용히 목록 뒤로 밀면 목록이 완전해 보이는데 실제로는
 * 아니다. 몇 명이 빠져 있는지 드러내고 여기서 채운다. 2만 명을 한 요청에 다
 * 계산할 수 없어서 청크로 이어 돌린다.
 */
export default function FitRefresh({
  campaignId,
  unscored,
  campaignName,
}: {
  campaignId: string;
  unscored: number;
  campaignName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(unscored);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (!campaignId) return setErr("기준 캠페인이 없습니다.");
    setBusy(true);
    setErr(null);
    try {
      for (let guard = 0; guard < 500; guard++) {
        const r = await fitStep(campaignId);
        setLeft(r.remaining);
        if (r.done) break;
      }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }

  const pct = unscored > 0 ? Math.round(((unscored - left) / unscored) * 100) : 100;

  return (
    <div className="prog">
      <div className="prog-top">
        <b>적합도 미계산 {left.toLocaleString("ko-KR")}명</b>
        {busy ? <span className="mono">{pct}%</span> : null}
      </div>
      {busy ? <div className="prog-bar"><i style={{ width: `${pct}%` }} /></div> : null}
      <p className="prog-note">
        {campaignName ? `'${campaignName}'` : "기준 캠페인"} 기준 점수가 아직 없는 크리에이터입니다.
        점수가 없으면 목록 뒤로 밀리므로 적합도순 정렬이 이들을 건너뜁니다.
        임포트로 새 데이터가 들어오면 해당 크리에이터의 점수는 다시 계산 대상이 됩니다.
      </p>
      {err ? <p className="prog-note bad">{err}</p> : null}
      <div>
        <button className="btn pri sm" type="button" onClick={run} disabled={busy}>
          {busy ? "계산 중…" : "지금 계산"}
        </button>
      </div>
    </div>
  );
}
