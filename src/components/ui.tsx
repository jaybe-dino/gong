import Link from "next/link";
import type { ReactNode } from "react";
import { igUrl } from "@/lib/handle";

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

/** 셀러 핸들은 항상 인스타 원문으로 나간다. 원문은 우리 DB에 저장하지 않고 링크로만 연결한다. */
export function IgLink({ handle, children, plain }: { handle: string; children?: ReactNode; plain?: boolean }) {
  return (
    <a
      className="iglink"
      href={igUrl(handle)}
      target="_blank"
      rel="noopener noreferrer"
      title={`instagram.com/${handle} 새 탭에서 열기`}
      style={plain ? undefined : { color: "var(--accent-ink)" }}
    >
      {children ?? `@${handle}`}
    </a>
  );
}

export function Card({
  title,
  hint,
  right,
  children,
  body,
}: {
  title?: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
  body?: boolean;
}) {
  return (
    <div className="card">
      {title && (
        <div className="card-h">
          <h3>{title}</h3>
          {hint && <span className="hint">{hint}</span>}
          {right && (
            <>
              <span className="spacer" />
              {right}
            </>
          )}
        </div>
      )}
      {body ? <div className="card-b">{children}</div> : children}
    </div>
  );
}

export function Note({ tone, children }: { tone?: "warn" | "stop"; children: ReactNode }) {
  return <div className={`note${tone ? ` ${tone}` : ""}`}>{children}</div>;
}

export function Scroller({ wide, children }: { wide?: boolean; children: ReactNode }) {
  return <div className={`scroller${wide ? " wide" : ""}`}>{children}</div>;
}

export function Funnel({ steps }: { steps: { label: string; count: number; sub?: string; strong?: boolean }[] }) {
  const max = Math.max(1, ...steps.map((s) => s.count));
  return (
    <div className="funnel">
      {steps.map((s) => (
        <div className="fstep" key={s.label}>
          <span className="fl">{s.strong ? <b>{s.label}</b> : s.label}</span>
          <div className="fbar">
            <i style={{ width: `${(s.count / max) * 100}%` }} />
          </div>
          <span className="fv">
            {s.strong ? <b>{s.count.toLocaleString("ko-KR")}</b> : s.count.toLocaleString("ko-KR")}
            {s.sub && <em>{s.sub}</em>}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SrcDots({ sources }: { sources: string[] }) {
  const map: Record<string, string> = { momcal: "맘", pang: "팡", ingong: "인" };
  return (
    <span className="srcdots">
      {(["momcal", "pang", "ingong"] as const).map((s) => (
        <b key={s} className={sources.includes(s) ? "on" : ""} title={s}>
          {map[s]}
        </b>
      ))}
    </span>
  );
}

export function FitBar({ score }: { score: number }) {
  const cls = score >= 85 ? "" : score >= 70 ? "mid" : "low";
  return (
    <div className="fitbar">
      <span className="num">{score}</span>
      <span className="t">
        <i className={cls} style={{ width: `${score}%` }} />
      </span>
    </div>
  );
}

export function Chip({ href, on, children }: { href: string; on: boolean; children: ReactNode }) {
  return (
    <Link className="chip" href={href} aria-pressed={on} scroll={false}>
      {children}
    </Link>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
