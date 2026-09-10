"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { submitFeedback } from "@/app/feedback/actions";

/**
 * 개선 제보 버튼.
 *
 * 화면 오른쪽 아래에 항상 떠 있고, 누르면 그 자리에서 적어 보낸다. 별도 채널로
 * 옮겨가야 하면(슬랙·구두) 대부분 그냥 넘어가고, 넘어간 것은 아무 기록도 남지
 * 않는다. 발견한 화면에서 바로 적을 수 있어야 한다.
 *
 * 재현 정보는 사람에게 묻지 않고 자동으로 담는다. "그 화면에서 안 돼요" 를
 * 받은 뒤에 되물으면 이미 그 화면이 아니다.
 */

const TRACE_KEY = "gong.trace.v1";
const ERR_KEY = "gong.errors.v1";
const TRACE_MAX = 12;
const ERR_MAX = 6;

/** 업로드 전에 줄인다. 원본 스크린샷은 몇 MB 라 서버 액션 본문 제한에 걸린다. */
const MAX_EDGE = 1600;
const MAX_FILES = 4;

interface Visit { t: string; path: string; title: string }
interface JsError { t: string; msg: string; src?: string }

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(v)); } catch { /* 저장 못 해도 제보는 된다 */ }
}

/**
 * 이미지를 캔버스로 다시 그려 줄인다.
 *
 * 원본을 그대로 보내면 서버 액션 본문 제한(기본 1MB)에 걸려 제보 자체가 실패한다.
 * 실패가 "전송 중 오류" 로만 보이면 사람은 두 번 시도하고 포기한다.
 */
async function shrink(file: File): Promise<{ blob: Blob; name: string } | null> {
  if (!file.type.startsWith("image/")) return null;
  // GIF 는 다시 그리면 첫 프레임만 남는다. 작으면 원본 그대로 보낸다.
  if (file.type === "image/gif" && file.size <= 2 * 1024 * 1024) {
    return { blob: file, name: file.name };
  }
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return { blob: file, name: file.name };

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { blob: file, name: file.name };
  // 스크린샷은 대개 흰 배경이다. 투명 PNG 를 JPEG 로 바꾸면 검게 나오므로 깔아 준다.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((res) =>
    canvas.toBlob(res, "image/jpeg", 0.85));
  if (!blob) return { blob: file, name: file.name };
  const base = (file.name || "screenshot").replace(/\.[^.]+$/, "");
  return { blob, name: `${base}.jpg` };
}

function kb(n: number) {
  return n < 1024 * 1024 ? `${Math.round(n / 1024)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`;
}

interface Shot { id: string; blob: Blob; name: string; url: string }

export default function FeedbackWidget({ path }: { path: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("improve");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okId, setOkId] = useState<string | null>(null);
  const [showCtx, setShowCtx] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // 방문 기록. 제보에 "어디를 거쳐 여기 왔는지" 가 붙는다.
  useEffect(() => {
    const trace = readJson<Visit[]>(TRACE_KEY, []);
    const last = trace[trace.length - 1];
    if (last?.path !== pathname) {
      trace.push({ t: new Date().toISOString(), path: pathname, title: document.title });
      writeJson(TRACE_KEY, trace.slice(-TRACE_MAX));
    }
  }, [pathname]);

  // 자바스크립트 오류. 오류 제보에서 이게 있고 없고가 재현 시간을 가른다.
  useEffect(() => {
    const push = (msg: string, src?: string) => {
      const list = readJson<JsError[]>(ERR_KEY, []);
      list.push({ t: new Date().toISOString(), msg: msg.slice(0, 300), src });
      writeJson(ERR_KEY, list.slice(-ERR_MAX));
    };
    const onErr = (e: ErrorEvent) =>
      push(e.message, e.filename ? `${e.filename}:${e.lineno}` : undefined);
    const onRej = (e: PromiseRejectionEvent) =>
      push(`unhandled rejection: ${String(e.reason).slice(0, 200)}`);
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    setErr(null);
    const incoming = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!incoming.length) return;
    const room = MAX_FILES - shots.length;
    if (room <= 0) { setErr(`이미지는 최대 ${MAX_FILES}장까지 붙일 수 있습니다.`); return; }

    const next: Shot[] = [];
    for (const f of incoming.slice(0, room)) {
      const s = await shrink(f);
      if (!s) continue;
      next.push({
        id: `${Date.now()}-${next.length}`, blob: s.blob, name: s.name,
        url: URL.createObjectURL(s.blob),
      });
    }
    setShots((cur) => [...cur, ...next]);
    if (incoming.length > room) setErr(`${MAX_FILES}장까지만 담았습니다.`);
  }, [shots.length]);

  // 스크린샷은 대개 클립보드에 있다. 붙여넣기가 되면 저장 단계가 통째로 사라진다.
  useEffect(() => {
    if (!open) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const files = items.filter((i) => i.kind === "file").map((i) => i.getAsFile())
        .filter((f): f is File => Boolean(f) && f!.type.startsWith("image/"));
      if (files.length) { e.preventDefault(); void addFiles(files); }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, addFiles]);

  useEffect(() => {
    if (open) dialogRef.current?.querySelector("input")?.focus();
  }, [open]);

  // 미리보기 URL 을 놓아준다. 안 하면 탭이 살아 있는 동안 계속 쌓인다.
  useEffect(() => () => { shots.forEach((s) => URL.revokeObjectURL(s.url)); }, [shots]);

  function context() {
    return {
      url: location.href,
      path: pathname,
      title: document.title,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      screen: `${screen.width}x${screen.height}`,
      dpr: window.devicePixelRatio,
      ua: navigator.userAgent,
      lang: navigator.language,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      online: navigator.onLine,
      at: new Date().toISOString(),
      trace: readJson<Visit[]>(TRACE_KEY, []),
      errors: readJson<JsError[]>(ERR_KEY, []),
    };
  }

  function reset() {
    shots.forEach((s) => URL.revokeObjectURL(s.url));
    setTitle(""); setBody(""); setShots([]); setKind("improve");
    setErr(null); setShowCtx(false);
  }

  async function send() {
    if (!title.trim()) { setErr("제목을 적어 주세요."); return; }
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.set("title", title.trim());
      fd.set("body", body.trim());
      fd.set("kind", kind);
      fd.set("pagePath", pathname);
      fd.set("pageTitle", document.title);
      fd.set("context", JSON.stringify(context()));
      for (const s of shots) fd.append("images", s.blob, s.name);

      const r = await submitFeedback(fd);
      if (r.error) { setErr(r.error); return; }
      setOkId(r.id!);
      reset();
      setOpen(false);
      setTimeout(() => setOkId(null), 6000);
    } catch (e) {
      setErr((e as Error).message || "보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  const totalBytes = shots.reduce((a, s) => a + s.blob.size, 0);

  return (
    <>
      {!open && (
        <button type="button" className="fbbtn" onClick={() => setOpen(true)}
                aria-label="개선사항 제보">
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path fill="currentColor" d="M2 2h12v9H5.6L2 14V2z" />
          </svg>
          <span>개선사항 제보</span>
        </button>
      )}

      {okId && (
        <div className="fbtoast" role="status">
          제보를 남겼습니다 · <a href="/feedback">목록에서 보기</a>
        </div>
      )}

      {open && (
        <>
          <button type="button" className="scrim" aria-label="닫기" onClick={() => setOpen(false)} />
          <div className="fbpanel" role="dialog" aria-modal="true" aria-label="개선사항 제보"
               ref={dialogRef}
               onDragOver={(e) => e.preventDefault()}
               onDrop={(e) => { e.preventDefault(); void addFiles(e.dataTransfer.files); }}>
            <div className="fbhead">
              <b>개선사항 제보</b>
              <button type="button" className="btn sm" onClick={() => setOpen(false)}>닫기</button>
            </div>

            <div className="fbbody">
              <div className="fbkinds">
                {[["bug", "오류"], ["improve", "개선"], ["question", "문의"]].map(([k, l]) => (
                  <button key={k} type="button"
                          className={`fbkind${kind === k ? " on" : ""}`}
                          onClick={() => setKind(k)}>{l}</button>
                ))}
              </div>

              <label className="field">
                <span>제목</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)}
                       placeholder="한 줄로 — 무엇이 어떻게 되면 좋겠는지" maxLength={200} />
              </label>

              <label className="field">
                <span>내용</span>
                <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)}
                          placeholder={"오류라면: 무엇을 눌렀고, 무엇이 나오길 기대했고, 실제로 무엇이 나왔는지.\n개선이라면: 지금 어떻게 하고 있고, 어떻게 되면 좋겠는지."} />
              </label>

              <div className="field">
                <span>
                  이미지 <small style={{ color: "var(--ink-3)" }}>
                    붙여넣기(Ctrl+V) · 끌어놓기 · 최대 {MAX_FILES}장
                  </small>
                </span>
                <div className="fbshots">
                  {shots.map((s) => (
                    <div key={s.id} className="fbshot">
                      {/* 로컬 blob 미리보기 — next/image 로는 다룰 수 없다 */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.url} alt={s.name} />
                      <button type="button" aria-label="빼기"
                              onClick={() => setShots((c) => {
                                const gone = c.find((x) => x.id === s.id);
                                if (gone) URL.revokeObjectURL(gone.url);
                                return c.filter((x) => x.id !== s.id);
                              })}>×</button>
                      <em>{kb(s.blob.size)}</em>
                    </div>
                  ))}
                  {shots.length < MAX_FILES && (
                    <button type="button" className="fbadd" onClick={() => fileRef.current?.click()}>
                      + 이미지
                    </button>
                  )}
                </div>
                <input ref={fileRef} type="file" accept="image/*" multiple hidden
                       onChange={(e) => { void addFiles(e.target.files ?? []); e.target.value = ""; }} />
                {totalBytes > 0 && (
                  <small style={{ color: "var(--ink-3)", fontSize: 11.5 }}>
                    합계 {kb(totalBytes)} · 보내기 전에 긴 변 {MAX_EDGE}px 로 줄였습니다
                  </small>
                )}
              </div>

              <div className="fbctx">
                <button type="button" onClick={() => setShowCtx((v) => !v)}>
                  {showCtx ? "▾" : "▸"} 함께 보내는 정보
                </button>
                <span className="mono">{path}</span>
                {showCtx && (
                  <pre className="mono">{JSON.stringify(context(), null, 2)}</pre>
                )}
              </div>

              {err && <p className="bad" style={{ margin: "4px 0 0" }}>{err}</p>}
            </div>

            <div className="fbfoot">
              <button className="btn pri" type="button" onClick={() => void send()} disabled={busy}>
                {busy ? "보내는 중…" : "제보 보내기"}
              </button>
              <a className="btn" href="/feedback">제보 목록 →</a>
            </div>
          </div>
        </>
      )}
    </>
  );
}
