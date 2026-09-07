"use client";

import { useState } from "react";
import { completeTask } from "@/lib/actions";

/**
 * 작업 하나. 붙여넣는 순서 그대로 놓는다.
 *
 * 전에는 표 한 줄에 문안을 160자로 잘라 보여주고 「복사 후 완료」 버튼이
 * 완료 처리만 했다 — 복사는 하지 않았고, 붙여넣을 곳(인포크·인링크 폼) 주소도
 * 화면에 없었다. 라벨이 거짓말을 하고 있었고, 실제로는 이 화면으로 일을 할 수
 * 없었다.
 *
 * 그래서 세 동작을 눈에 보이는 순서로 나눈다: 복사 → 열기 → 완료.
 * 완료는 마지막에 사람이 누른다 — 눌렀다고 보낸 것이 아니라, 보냈으니 누르는 것이다.
 */
export default function TaskCard({
  id,
  channel,
  channelLabel,
  handle,
  displayName,
  followers,
  campaign,
  subject,
  body,
  targetUrl,
  dueAt,
}: {
  id: string;
  channel: string;
  channelLabel: string;
  handle: string;
  displayName: string;
  followers: string;
  campaign: string;
  subject: string | null;
  body: string;
  targetUrl: string | null;
  dueAt: string;
}) {
  const [copied, setCopied] = useState<"" | "body" | "subject" | "fail">("");

  async function copy(text: string, what: "body" | "subject") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      // 클립보드가 막힌 환경(권한·비보안 컨텍스트)에서도 손으로 복사할 수 있어야 한다.
      setCopied("fail");
    }
  }

  const openLabel = channel === "instagram_dm" ? "DM 창 열기" : `${channelLabel} 열기`;

  // 저장된 주소에 스킴이 없는 경우가 많다 (inpock.link/handle). 그대로 href 에
  // 넣으면 상대 경로로 읽혀 우리 사이트 안쪽으로 간다 — 링크가 죽는다.
  const href = targetUrl && !/^[a-z][a-z0-9+.-]*:/i.test(targetUrl)
    ? `https://${targetUrl.replace(/^\/+/, "")}`
    : targetUrl;

  return (
    <div className="taskcard">
      <div className="tc-h">
        <div>
          <a className="iglink" href={`https://www.instagram.com/${handle}`} target="_blank" rel="noopener noreferrer">
            <b>@{handle}</b>
          </a>
          <span className="tc-sub">{displayName} · {followers} · {campaign}</span>
        </div>
        <span className="tc-meta">{channelLabel} · {dueAt}</span>
      </div>

      {subject && (
        <div className="tc-field">
          <div className="tc-label">
            제목
            <button type="button" className="btn sm" onClick={() => copy(subject, "subject")}>
              {copied === "subject" ? "복사됨" : "복사"}
            </button>
          </div>
          <div className="tc-subject">{subject}</div>
        </div>
      )}

      <div className="tc-field">
        <div className="tc-label">
          본문 <span className="tc-len">{body.length}자</span>
          <button type="button" className="btn sm" onClick={() => copy(body, "body")}>
            {copied === "body" ? "복사됨" : "문안 복사"}
          </button>
        </div>
        {/* 전문을 보여준다. 잘라 놓으면 무엇을 보내는지 확인할 수 없다. */}
        <pre className="tc-body">{body}</pre>
      </div>

      {copied === "fail" && (
        <p className="tc-warn">
          이 브라우저에서 자동 복사가 막혀 있습니다. 위 본문을 직접 선택해 복사하세요.
        </p>
      )}

      <div className="tc-foot">
        <button type="button" className="btn pri" onClick={() => copy(body, "body")}>
          1 · 문안 복사
        </button>
        {href ? (
          <a className="btn" href={href} target="_blank" rel="noopener noreferrer">
            2 · {openLabel} ↗
          </a>
        ) : (
          <span className="tc-nourl">붙여넣을 주소가 없습니다 — 연락처를 확인하세요</span>
        )}
        <form action={completeTask}>
          <input type="hidden" name="id" value={id} />
          <button className="btn" type="submit">3 · 보냈음</button>
        </form>
        <span className="tc-hint">
          보낸 뒤에 <b>3번</b>을 누르세요. 누르면 발신 사용량이 올라가고 기록이 남습니다.
        </span>
      </div>
    </div>
  );
}
