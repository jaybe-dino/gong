"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as B from "@/lib/blast";

/**
 * 발송 마법사의 서버 액션.
 *
 * 단계마다 저장하고 다음으로 넘긴다. 중간에 나가도 draft 로 남아 목록에서 다시
 * 열 수 있다 — 문안을 쓰다 만 것이 사라지면 아무도 이 화면을 쓰지 않는다.
 */

const JAY = "00000000-0000-0000-0000-0000000000aa";

function go(id: string, step: number, msg?: string, kind: "ok" | "err" = "ok"): never {
  revalidatePath(`/blast/${id}`);
  const q = new URLSearchParams({ step: String(step) });
  if (msg) { q.set("msg", msg); q.set("kind", kind); }
  redirect(`/blast/${id}?${q}`);
}

const num = (v: FormDataEntryValue | null): number | null => {
  const n = Number(String(v ?? "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** 1단계 — 채널을 고르면 발송이 만들어진다. */
export async function create(form: FormData): Promise<void> {
  const channel = String(form.get("channel") ?? "");
  const name = String(form.get("name") ?? "").trim();
  let id: string;
  try {
    id = await B.createBlast(name, channel, JAY);
  } catch (e) {
    revalidatePath("/blast");
    redirect(`/blast?kind=err&msg=${encodeURIComponent((e as Error).message)}`);
  }
  go(id, 2);
}

/** 2단계 — 필터 저장. 대상 수는 화면이 다시 세어 보여준다. */
export async function saveTargets(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  const filters: B.Filters = {
    category: String(form.get("category") ?? "") || null,
    minFollowers: num(form.get("minFollowers")),
    tiers: form.getAll("tiers").map(String).filter(Boolean),
    gongguOnly: form.get("gongguOnly") === "1",
    cooldownDays: num(form.get("cooldownDays")),
    limit: num(form.get("limit")),
  };
  const mailbox = String(form.get("mailbox") ?? "") || null;
  await B.saveFilters(id, filters, mailbox);
  const n = await B.countTargets(String(form.get("channel") ?? "email"), filters);
  go(id, 2, `조건에 맞는 대상 ${n.toLocaleString("ko-KR")}명. 아래 목록을 확인하고 확정하세요.`);
}

/**
 * 2단계 확정 — 대상을 굳힌다. 이후 필터를 바꿔도 흔들리지 않는다.
 *
 * redirect() 는 NEXT_REDIRECT 예외를 던져 동작한다. 그래서 try 안에서 부르면
 * 그 자리의 catch 가 자기 리다이렉트를 잡아 "NEXT_REDIRECT" 를 오류 메시지로
 * 보여준다 (실제로 그렇게 나갔다). try 는 실패할 수 있는 일만 감싸고, 이동은
 * 밖에서 한다.
 */
export async function confirmTargets(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  let n: number;
  try {
    n = await B.materialize(id);
  } catch (e) {
    go(id, 2, (e as Error).message, "err");
  }
  if (n === 0) go(id, 2, "조건에 맞는 대상이 없습니다. 필터를 넓혀 보세요.", "err");
  go(id, 3, `대상 ${n.toLocaleString("ko-KR")}명을 확정했습니다. 이제 보낼 내용을 씁니다.`);
}

/** 3단계 — 문안 저장. */
export async function saveContent(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  const body = String(form.get("body") ?? "");
  const subject = String(form.get("subject") ?? "").trim() || null;
  if (!body.trim()) go(id, 3, "본문을 입력하세요.", "err");
  await B.saveContent(id, subject, body);
  go(id, 3, "문안을 저장했습니다.");
}

/** 3단계 — 테스트 발송. 우리가 받아본다. */
export async function testSend(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  const to = String(form.get("to") ?? "").trim();
  if (!to) go(id, 3, "테스트로 받을 주소를 입력하세요.", "err");

  // 저장하지 않은 문안으로 테스트하면 "보낸 것과 다른 것" 을 보게 된다.
  const body = String(form.get("body") ?? "");
  const subject = String(form.get("subject") ?? "").trim() || null;
  if (body.trim()) await B.saveContent(id, subject, body);

  const r = await B.sendTest(id, to);
  go(id, 3, r.detail, r.ok ? "ok" : "err");
}

/** 4단계 — 청크 하나 발송. 화면이 남은 수를 보고 이어 부른다. */
export async function sendStep(blastId: string): Promise<B.SendProgress> {
  return await B.sendChunk(blastId);
}

export async function goStep(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  go(id, Number(form.get("step") ?? 1));
}
