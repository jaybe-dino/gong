import Link from "next/link";
import type { ReactNode } from "react";
import { navGroups } from "@/lib/nav";
import { one } from "@/lib/db";
import { krDate, today } from "@/lib/clock";

/** 앱 셸. 사이드바 배지와 발신 계정 사용량은 매 요청마다 DB 에서 읽는다. */
export default function Shell({
  path,
  title,
  sub,
  children,
}: {
  path: string;
  title: string;
  sub?: string;
  children: ReactNode;
}) {
  const groups = navGroups();
  const sender = one<{ identifier: string; sent_today: number; daily_cap: number }>(
    `SELECT identifier, sent_today, daily_cap FROM sender_account WHERE channel='email' AND status='ok' ORDER BY id LIMIT 1`,
  );
  const account = one<{ identifier: string }>(
    `SELECT identifier FROM sender_account WHERE channel='email' ORDER BY id LIMIT 1`,
  );

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <b>아웃리치 콘솔</b>
          <small>Dinostudio</small>
        </div>
        <nav className="navwrap">
          {groups.map((g) => (
            <div className="navgrp" key={g.title}>
              <span>{g.title}</span>
              {g.items.map((it) => (
                <Link
                  key={it.href}
                  href={it.href}
                  className="navbtn"
                  aria-current={path === it.href || path.startsWith(it.href + "/") ? "page" : undefined}
                >
                  <span>{it.label}</span>
                  {it.count != null && <em className="cnt mono">{it.count.toLocaleString("ko-KR")}</em>}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidefoot">
          <span className="dot" />
          {account?.identifier ?? "partner@dinostudio.kr"}
          <br />
          <span style={{ color: "var(--ink-3)", fontSize: 11 }}>Google Workspace 연동됨</span>
        </div>
      </aside>

      <main>
        <div className="topbar">
          <h1>{title}</h1>
          <span className="sub">{sub || krDate(today())}</span>
          <span className="spacer" />
          <span className="demo">샘플 데이터</span>
          {sender && (
            <span className="senderchip">
              <i /> 오늘 발송 {sender.sent_today} / {sender.daily_cap}
            </span>
          )}
        </div>
        {children}
      </main>
    </div>
  );
}
