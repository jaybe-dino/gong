import Link from "next/link";
import type { ReactNode } from "react";
import { navGroups } from "@/lib/nav";
import { sendingIdentity } from "@/lib/queries";
import { krDate, today } from "@/lib/clock";
import FeedbackWidget from "./FeedbackWidget";

/** 앱 셸. 사이드바 배지와 발신 계정 사용량은 매 요청마다 DB 에서 읽는다. */
export default async function Shell({
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
  // 여기 뜨는 주소는 "지금 메일이 나가고 회신이 들어오는 곳" 이어야 한다.
  // 전에는 sender 표에서 identifier 순으로 아무거나 하나 집었다 — 시드로 들어온
  // 주소가 떴고, 등록한 메일함과 아무 상관이 없었다.
  const [groups, id] = await Promise.all([navGroups(), sendingIdentity()]);

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
          <span className={`dot${id.ok ? "" : " off"}`} />
          {id.from ?? "메일함 미등록"}
          <br />
          <span style={{ color: "var(--ink-3)", fontSize: 11 }}>{id.note}</span>
        </div>
      </aside>

      <main>
        <div className="topbar">
          <h1>{title}</h1>
          <span className="sub">{sub || krDate(today())}</span>
          <span className="spacer" />
          <span className="demo">샘플 데이터</span>
          {id.budget && (
            <span className="senderchip">
              <i /> 오늘 발송 {id.budget.sentToday} / {id.budget.capToday}
              {!id.budget.enforced && " (권장)"}
            </span>
          )}
        </div>
        {children}
      </main>

      {/* 어느 화면에서든 그 자리에서 제보할 수 있어야 한다. 셸에 두면 페이지마다
          붙일 필요가 없고, 새로 만든 화면에서 빠지는 일도 없다. */}
      <FeedbackWidget path={path} />
    </div>
  );
}
