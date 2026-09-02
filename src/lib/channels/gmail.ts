import crypto from "node:crypto";

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
 * GOOGLE_* 환경변수가 없으면 dry-run 으로 동작한다 — 콘솔에 찍히고 실제로 나가지 않는다.
 */

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];

export function isConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN,
  );
}

/** googleapis 는 선택 의존성이다. 없으면 dry-run 으로 떨어진다. */
async function client(): Promise<unknown | null> {
  try {
    const mod = (await import(/* webpackIgnore: true */ "googleapis")) as unknown as {
      google: {
        auth: { OAuth2: new (a?: string, b?: string, c?: string) => { setCredentials(c: object): void } };
        gmail(o: object): unknown;
      };
    };
    const auth = new mod.google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/oauth/callback",
    );
    auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    return mod.google.gmail({ version: "v1", auth });
  } catch {
    return null;
  }
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

/** RFC 2822 조립. 한글 제목·표시명은 base64 로 인코딩한다. */
export function buildRaw(msg: OutboundMessage): string {
  const lines: string[] = [];
  lines.push(`From: ${msg.fromName ? `=?UTF-8?B?${b64(msg.fromName)}?= ` : ""}<${msg.from}>`);
  lines.push(`To: ${msg.to}`);
  if (msg.replyTo) lines.push(`Reply-To: ${msg.replyTo}`);
  if (msg.subject) lines.push(`Subject: =?UTF-8?B?${b64(msg.subject)}?=`);
  if (msg.inReplyTo) lines.push(`In-Reply-To: ${msg.inReplyTo}`);
  if (msg.references) lines.push(`References: ${msg.references}`);
  for (const [k, v] of Object.entries(msg.headers ?? {})) lines.push(`${k}: ${v}`);
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(b64(msg.body));
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

export interface SendResult {
  providerMessageId: string;
  threadKey: string | null;
  dryRun: boolean;
}

export async function send(msg: OutboundMessage): Promise<SendResult> {
  const raw = buildRaw(msg);
  const gmail = isConfigured() ? await client() : null;

  if (!gmail) {
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

  const api = gmail as {
    users: { messages: { send(o: object): Promise<{ data: { id: string; threadId: string } }> } };
  };
  const res = await api.users.messages.send({
    userId: "me",
    requestBody: { raw, ...(msg.threadKey ? { threadId: msg.threadKey } : {}) },
  });
  return { providerMessageId: res.data.id, threadKey: res.data.threadId, dryRun: false };
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

/** 수신 동기화. history API 로 증분만 가져온다. 미설정이면 빈 배열. */
export async function fetchInbound(
  { sinceHistoryId, maxResults = 50 }: { sinceHistoryId?: string | null; maxResults?: number } = {},
): Promise<{ messages: InboundMessage[]; historyId: string | null; dryRun: boolean }> {
  const gmail = isConfigured() ? await client() : null;
  if (!gmail) return { messages: [], historyId: sinceHistoryId ?? null, dryRun: true };

  const api = gmail as {
    users: {
      history: { list(o: object): Promise<{ data: { historyId?: string; history?: { messagesAdded?: { message: { id: string } }[] }[] } }> };
      messages: {
        list(o: object): Promise<{ data: { messages?: { id: string }[] } }>;
        get(o: object): Promise<{ data: Parameters<typeof normalizeInbound>[0] }>;
      };
      getProfile(o: object): Promise<{ data: { historyId: string } }>;
    };
  };

  let ids: string[] = [];
  let historyId = sinceHistoryId ?? null;

  if (sinceHistoryId) {
    const h = await api.users.history.list({ userId: "me", startHistoryId: sinceHistoryId, historyTypes: ["messageAdded"] });
    historyId = h.data.historyId ?? sinceHistoryId;
    for (const rec of h.data.history ?? []) {
      for (const m of rec.messagesAdded ?? []) ids.push(m.message.id);
    }
  } else {
    const l = await api.users.messages.list({ userId: "me", q: "in:inbox newer_than:7d", maxResults });
    ids = (l.data.messages ?? []).map((m) => m.id);
    historyId = (await api.users.getProfile({ userId: "me" })).data.historyId;
  }

  const out: InboundMessage[] = [];
  for (const id of [...new Set(ids)]) {
    const full = await api.users.messages.get({ userId: "me", id, format: "full" });
    out.push(normalizeInbound(full.data));
  }
  return { messages: out, historyId, dryRun: false };
}
