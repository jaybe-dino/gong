import crypto from "node:crypto";
import { run } from "../db";
import { defaultMailbox, isConfigured as saConfigured, listMessages, mailboxes, sendRaw } from "../google-sa";

/**
 * Gmail 어댑터 — 회사 메일 한 개로 발송·회신을 모두 처리한다.
 *
 * 자체 SMTP 를 쓰지 않는 이유: 크리에이터 아웃리치는 회사 도메인 신뢰가 자산이다.
 * 사용자의 Gmail 을 OAuth 로 붙이는 방식이 콜드 세일즈 툴과 반대 선택이지만 여기선 맞다.
 *
 * 스레드 매핑의 핵심은 Reply-To 의 플러스 주소다.
 *   partner+cm_{token}@dinostudio.kr
 * 회신이 오면 To/Delivered-To 헤더에서 토큰을 뽑아 어느 campaign_member 인지 즉시 안다.
 *
 * 인증은 서비스 계정 + 도메인 전체 위임이다 (google-sa.ts). 사용자 동의 화면도,
 * 저장해 둘 리프레시 토큰도 없다. 키가 없으면 dry-run 으로 동작한다 —
 * 콘솔에 찍히고 실제로 나가지 않는다.
 *
 * googleapis SDK 를 쓰지 않는다. JWT 서명 + REST 두 단계뿐이라 의존성을 늘릴
 * 이유가 없고, 선택 의존성이 없을 때 조용히 dry-run 으로 떨어지던 경로도 사라진다.
 */

export function isConfigured(): boolean {
  return saConfigured();
}

/** 저장된 토큰이 이미 cm_ 접두사를 갖고 있을 수 있다. 어느 쪽이 와도 한 번만 붙인다. */
export function bareToken(token: string): string {
  return String(token).replace(/^cm_/, "");
}

/** 회신 매핑용 플러스 주소. cm_ 토큰이 campaign_member 를 가리킨다. */
export function replyToAddress(baseAddress: string, token: string): string {
  const [local, domain] = baseAddress.split("@");
  return `${local}+cm_${bareToken(token)}@${domain}`;
}

export function parseReplyToken(address: string | null | undefined): string | null {
  const m = String(address ?? "").match(/\+cm_([A-Za-z0-9]{6,40})@/);
  return m ? m[1] : null;
}

export function newReplyToken(): string {
  return crypto.randomBytes(8).toString("hex");
}

const b64 = (s: string) => Buffer.from(String(s), "utf8").toString("base64");

export interface OutboundMessage {
  from: string;
  fromName?: string | null;
  to: string;
  replyTo?: string | null;
  subject?: string | null;
  body: string;
  headers?: Record<string, string>;
  threadKey?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}

/**
 * RFC 2047 인코딩 워드. 한글 제목·표시명을 base64 로 싣는다.
 *
 * 한 워드는 75자를 넘을 수 없다(§2). 넘으면 여러 워드로 쪼개고 CRLF+공백으로
 * 잇는다. 쪼갤 때 UTF-8 멀티바이트 문자를 가로지르면 안 되므로 3바이트 배수로
 * 자른다 — 한글이 3바이트라 딱 맞는다.
 *
 * 전에는 제목을 워드 하나로 만들어 117자가 나갔다. 규격 위반이고, 받는 쪽
 * 필터가 헤더 이상을 점수에 넣는다.
 */
function encodeWords(text: string): string {
  const buf = Buffer.from(text, "utf8");
  // "=?UTF-8?B?" (10) + "?=" (2) = 12. 75 - 12 = 63자 → base64 63자는 원문 45바이트.
  const CHUNK = 45;
  if (buf.length <= CHUNK) return `=?UTF-8?B?${buf.toString("base64")}?=`;

  const words: string[] = [];
  for (let i = 0; i < buf.length; i += CHUNK) {
    words.push(`=?UTF-8?B?${buf.subarray(i, i + CHUNK).toString("base64")}?=`);
  }
  return words.join("\r\n ");
}

/**
 * base64 본문을 76자로 접는다.
 *
 * RFC 2045 §6.8 이 76자 상한을 정한다. 전에는 본문 전체를 한 줄로 내보냈다 —
 * 600자가 넘는 줄이었고, 네이버·다음처럼 엄격한 수신 서버가 이걸 점수에 넣는다.
 */
function foldBase64(b64text: string): string {
  const out: string[] = [];
  for (let i = 0; i < b64text.length; i += 76) out.push(b64text.slice(i, i + 76));
  return out.join("\r\n");
}

/**
 * RFC 5322 날짜. Gmail API 가 없으면 채워 주지만, 우리가 넣는 편이 낫다 —
 * 규격에 맞는 메일을 만들어 놓고 받는 쪽 관용에 기대지 않는다.
 */
function rfc5322Date(d = new Date()): string {
  return d.toUTCString().replace("GMT", "+0000");
}

/** RFC 5322 조립. */
export function buildRaw(msg: OutboundMessage, now = new Date()): string {
  const lines: string[] = [];
  lines.push(`From: ${msg.fromName ? `${encodeWords(msg.fromName)} ` : ""}<${msg.from}>`);
  lines.push(`To: ${msg.to}`);
  lines.push(`Date: ${rfc5322Date(now)}`);
  if (msg.replyTo) lines.push(`Reply-To: ${msg.replyTo}`);
  if (msg.subject) lines.push(`Subject: ${encodeWords(msg.subject)}`);
  if (msg.inReplyTo) lines.push(`In-Reply-To: ${msg.inReplyTo}`);
  if (msg.references) lines.push(`References: ${msg.references}`);
  for (const [k, v] of Object.entries(msg.headers ?? {})) lines.push(`${k}: ${v}`);
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  // 본문 줄바꿈도 CRLF 여야 한다. text/plain 의 정규 형식이 그렇고, LF 만
  // 들어가면 일부 수신 서버가 본문을 한 줄로 붙여 버린다.
  lines.push(foldBase64(b64(msg.body.replace(/\r?\n/g, "\r\n"))));
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

export interface SendResult {
  providerMessageId: string;
  threadKey: string | null;
  dryRun: boolean;
}

export async function send(msg: OutboundMessage): Promise<SendResult> {
  const raw = buildRaw(msg);
  // 등록된 기본 발신함이 없으면 보낼 곳이 정해지지 않은 것이다 — dry-run 으로 둔다.
  const from = isConfigured() ? await defaultMailbox() : null;

  if (!from) {
    console.log(
      `[gmail:dry-run] → ${msg.to}\n  Reply-To: ${msg.replyTo}\n  Subject: ${msg.subject}\n` +
        msg.body.split("\n").map((l) => "  | " + l).join("\n"),
    );
    return {
      providerMessageId: "dry_" + crypto.randomBytes(8).toString("hex"),
      threadKey: msg.threadKey ?? "thr_" + crypto.randomBytes(6).toString("hex"),
      dryRun: true,
    };
  }

  const res = await sendRaw(from, raw);
  return { providerMessageId: res.id, threadKey: res.threadId, dryRun: false };
}

export interface InboundMessage {
  providerMessageId: string;
  threadKey: string | null;
  from: string;
  to: string;
  subject: string;
  body: string;
  receivedAt: Date;
  isAutoReply: boolean;
  replyToken: string | null;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

export function extractText(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64").toString("utf8");
  }
  for (const p of part.parts ?? []) {
    const t = extractText(p);
    if (t) return t;
  }
  if (part.body?.data) return Buffer.from(part.body.data, "base64").toString("utf8");
  return "";
}

export function normalizeInbound(m: {
  id: string; threadId: string; internalDate: string;
  payload: GmailPart & { headers?: { name: string; value: string }[] };
}): InboundMessage {
  const h = Object.fromEntries((m.payload.headers ?? []).map((x) => [x.name.toLowerCase(), x.value]));
  return {
    providerMessageId: m.id,
    threadKey: m.threadId,
    from: h.from ?? "",
    to: h.to ?? "",
    subject: h.subject ?? "",
    body: extractText(m.payload),
    receivedAt: new Date(Number(m.internalDate)),
    isAutoReply: /auto-?(submitted|reply)|vacation|out of office|부재중|자동\s*응답/i.test(
      `${h.subject ?? ""} ${h["auto-submitted"] ?? ""} ${h["x-autoreply"] ?? ""}`,
    ),
    replyToken: parseReplyToken(h["delivered-to"] ?? h.to),
  };
}

/**
 * 수신 동기화 — 등록·활성화된 메일함을 순회해 최근 메일을 가져온다.
 *
 * history API 의 증분 경로를 쓰지 않는다. 그쪽은 startHistoryId 가 만료되면
 * 조용히 구멍이 나고, 읽음 표시(gmail.modify)로 커서를 대신할 수도 없다 —
 * 스코프를 readonly + compose 로 묶어 뒀기 때문이다. 대신 최근 구간을 통째로
 * 다시 읽고 provider_msg_id 로 중복을 막는다 (inbound-sync.ingest). 겹쳐 읽는
 * 비용보다 놓치지 않는 쪽이 싸다.
 */
export async function fetchInbound(
  { query, maxResults = 50 }: { query?: string; maxResults?: number } = {},
): Promise<{ messages: InboundMessage[]; dryRun: boolean }> {
  if (!isConfigured()) return { messages: [], dryRun: true };

  const boxes = (await mailboxes()).filter((m) => m.enabled);
  if (boxes.length === 0) return { messages: [], dryRun: true };

  const q = query ?? "in:inbox newer_than:7d -in:spam -in:trash";
  const out: InboundMessage[] = [];
  for (const box of boxes) {
    // 한 메일함이 실패해도 나머지는 계속 돈다. 원인은 그 메일함에 기록해 둔다.
    try {
      const raw = await listMessages(box.email, { query: q, limit: maxResults });
      for (const m of raw) out.push(normalizeInbound(m as Parameters<typeof normalizeInbound>[0]));
      await markSynced(box.email, null);
    } catch (e) {
      const detail = (e as Error).message;
      console.error("[gmail:inbound]", box.email, detail);
      await markSynced(box.email, detail);
    }
  }
  return { messages: out, dryRun: false };
}

async function markSynced(email: string, error: string | null): Promise<void> {
  await run(
    `UPDATE mailbox SET last_sync_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_sync_at END,
            last_error = $2 WHERE email = $1`,
    [email, error],
  ).catch(() => {});
}
