import { igUrl } from "../handle";
import * as gmail from "./gmail";
import type { Rendered } from "../template";

/**
 * 채널 레지스트리.
 *
 * 중요한 사실: 인스타그램 공식 API 에는 콜드 DM 엔드포인트가 없다.
 * Instagram Messaging API 는 사용자가 먼저 메시지를 보낸 뒤에야 24시간 창이 열린다.
 * 그래서 IG DM · 인포크 제안은 send() 가 아예 없고, 대신 작업 큐를 만든다.
 * "금지"가 아니라 "라우팅"이다 — 대상은 버려지지 않고 사람에게 간다.
 */

export interface SendContext {
  sender: { id: string; identifier: string; display_name?: string | null };
  contact: { value: string };
  rendered: Rendered;
  replyToken: string;
  baseAddress: string;
  threadKey?: string | null;
}

export interface TaskContext {
  rendered: Rendered;
  handle: string;
  linkInBio?: string | null;
  sender?: { id: string } | null;
  dueAt: Date;
}

export interface TaskDraft {
  channel: string;
  rendered_subject: string | null;
  rendered_body: string;
  target_url: string;
  sender_id: string | null;
  due_at: Date;
}

export interface Channel {
  key: string;
  mode: "auto" | "manual_task";
  send?(ctx: SendContext): Promise<gmail.SendResult>;
  makeTask?(ctx: TaskContext): TaskDraft;
}

const email: Channel = {
  key: "email",
  mode: "auto",
  async send(ctx) {
    return gmail.send({
      from: ctx.sender.identifier,
      fromName: ctx.sender.display_name,
      to: ctx.contact.value,
      replyTo: gmail.replyToAddress(ctx.baseAddress, ctx.replyToken),
      subject: ctx.rendered.subject,
      body: ctx.rendered.body,
      headers: ctx.rendered.headers,
      threadKey: ctx.threadKey ?? null,
    });
  },
};

/** 사람이 실행하는 채널. send() 대신 makeTask() 를 제공한다. */
function manualChannel(key: string, buildTarget: (c: TaskContext) => string): Channel {
  return {
    key,
    mode: "manual_task",
    send() {
      throw new Error(
        `'${key}' 는 자동 발송할 수 없습니다. 공식 API 에 콜드 엔드포인트가 없거나 ` +
          `플랫폼 약관상 자동 제출이 허용되지 않습니다. outreach_task 를 생성하세요.`,
      );
    },
    makeTask(ctx) {
      return {
        channel: key,
        rendered_subject: ctx.rendered.subject ?? null,
        rendered_body: ctx.rendered.body,
        target_url: buildTarget(ctx),
        sender_id: ctx.sender?.id ?? null,
        due_at: ctx.dueAt,
      };
    },
  };
}

const instagram_dm = manualChannel("instagram_dm", (c) => igUrl(c.handle));
const inpock_offer = manualChannel("inpock_offer", (c) => c.linkInBio || igUrl(c.handle));
const linktree_form = manualChannel("linktree_form", (c) => c.linkInBio || igUrl(c.handle));

/** 동의 후에만 열리는 채널. 어댑터는 프로젝트 사정에 맞게 교체한다. */
const stub = (key: string): Channel => ({
  key,
  mode: "auto",
  async send(ctx) {
    console.log(`[${key}:stub] → ${ctx.contact.value} / ${ctx.rendered.body.slice(0, 40)}…`);
    return { providerMessageId: `${key}_stub`, threadKey: null, dryRun: true };
  },
});

export const REGISTRY: Record<string, Channel> = {
  email,
  instagram_dm,
  inpock_offer,
  linktree_form,
  kakao: stub("kakao"),
  sms: stub("sms"),
};

export function get(channel: string): Channel {
  const c = REGISTRY[channel];
  if (!c) throw new Error(`알 수 없는 채널: ${channel}`);
  return c;
}

export { gmail };
