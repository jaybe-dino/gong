"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { beginUpload, endUpload, uploadChunk } from "@/lib/actions";
import { splitRecords } from "@/lib/csv";

/** 한 요청에 보낼 레코드 수. 1.9만 행 CSV 가 2.8 MB 였으니 약 300 KB 짜리 조각이 된다. */
const CHUNK = 2000;

/**
 * CSV 업로더.
 *
 * 파일을 브라우저에서 레코드 단위로 잘라 여러 번 올린다. 서버 액션 하나로 파일을
 * 넘기면 Next 의 본문 한도(1 MB)와 Vercel 의 요청 한도(4.5 MB)에 걸린다.
 * 자르기는 따옴표를 인식한다 — 자유 텍스트 안의 개행이 행을 쪼개지 않는다.
 */
export default function Uploader({ source }: { source: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const form = new FormData(e.currentTarget);
    const src = String(form.get("source") ?? source);
    const file = fileRef.current?.files?.[0];
    if (!file) return setErr("CSV 파일을 선택하세요.");

    setBusy(true);
    try {
      const recs = splitRecords(await file.text());
      if (recs.length < 2) throw new Error("데이터 행이 없습니다. 헤더만 있는 파일입니다.");
      const [header, ...rows] = recs;
      setTotal(rows.length);

      const batchId = await beginUpload(src, file.name, header);
      for (let i = 0; i < rows.length; i += CHUNK) {
        await uploadChunk(batchId, header, rows.slice(i, i + CHUNK), i + 2);
        setSent(Math.min(i + CHUNK, rows.length));
      }
      await endUpload(batchId);
      router.push(`/import?step=3&batch=${batchId}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const pct = total ? Math.round((sent / total) * 100) : 0;

  return (
    <form onSubmit={submit}>
      <input type="hidden" name="source" value={source} />
      <label className="dropzone">
        <b>CSV 파일 선택</b>
        <span>
          헤더가 있는 UTF-8 CSV. 원문·이미지는 저장하지 않고 파생 지표와 링크백만 보관합니다. 큰 파일은
          {" "}{CHUNK.toLocaleString("ko-KR")}행씩 나눠 올립니다.
        </span>
        <input ref={fileRef} type="file" name="file" accept=".csv,text/csv" required style={{ marginTop: 12 }} disabled={busy} />
      </label>

      {busy ? (
        <div className="prog" style={{ marginTop: 14 }} role="status" aria-live="polite">
          <div className="prog-top">
            <b>업로드 중</b>
            <span className="mono">
              {sent.toLocaleString("ko-KR")} / {total.toLocaleString("ko-KR")}행
            </span>
          </div>
          <div className="prog-bar"><i style={{ width: `${pct}%` }} /></div>
        </div>
      ) : null}

      {err ? <p className="prog-note bad" style={{ marginTop: 10 }}>{err}</p> : null}

      <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn pri" type="submit" disabled={busy}>
          {busy ? "올리는 중…" : "업로드 후 중복 검사 (dry-run)"}
        </button>
      </div>
    </form>
  );
}
