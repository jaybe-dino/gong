"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as sa from "@/lib/google-sa";
import * as settings from "@/lib/settings";
import { gmail } from "@/lib/channels";
import { tick as inboundTick } from "@/lib/jobs/inbound-sync";
import { checkDomain } from "@/lib/jobs/dns-check";
import { josa } from "@/lib/format";

/**
 * 설정 화면의 서버 액션.
 *
 * 서비스 계정 키는 여기서 다루지 않는다. 도메인 전 계정을 열 수 있는 값이라
 * 화면에서 입력받지 않고 환경 변수(GOOGLE_SA_KEY_JSON)로만 들어온다.
 * 화면이 하는 일은 "어느 메일함을 대신할지" 를 정하는 것뿐이다.
 */

const JAY = "00000000-0000-0000-0000-0000000000aa";

/**
 * 결과를 배너로 돌려준다.
 *
 * revalidatePath 만 하면 실패가 조용히 사라진다 — 등록을 거부해 놓고 화면은
 * 아무 말도 하지 않으면, 사용자는 버튼이 안 눌린 줄 알고 같은 값을 다시 넣는다.
 */
function done(msg?: string, kind: "ok" | "err" = "ok"): never {
  revalidatePath("/settings");
  redirect(msg ? `/settings?kind=${kind}&msg=${encodeURIComponent(msg)}` : "/settings");
}

export async function saveSettings(form: FormData): Promise<void> {
  const values: Record<string, string> = {};
  for (const spec of settings.SPECS) values[spec.key] = String(form.get(spec.key) ?? "");
  const errors = await settings.save(values, JAY);
  done(errors.length ? errors.map((e) => e.message).join(" · ") : "설정을 저장했습니다.",
       errors.length ? "err" : "ok");
}

export async function addMailbox(form: FormData): Promise<void> {
  const email = String(form.get("email") ?? "").trim();
  const domain = await settings.get("mail.domain");
  const r = await sa.addMailbox(email, String(form.get("label") ?? ""), domain);
  done(r.ok ? `${josa(email.toLowerCase(), "을를")} 등록했습니다.` : r.error!, r.ok ? "ok" : "err");
}

export async function removeMailbox(form: FormData): Promise<void> {
  const email = String(form.get("email") ?? "");
  await sa.removeMailbox(email);
  done(`${josa(email, "을를")} 삭제했습니다.`);
}

export async function toggleMailbox(form: FormData): Promise<void> {
  const email = String(form.get("email") ?? "");
  const on = form.get("enabled") === "1";
  await sa.setEnabled(email, on);
  done(`${email} 수집을 ${on ? "켰습니다" : "껐습니다"}.`);
}

export async function makeDefault(form: FormData): Promise<void> {
  const email = String(form.get("email") ?? "");
  await sa.setDefaultMailbox(email);
  done(`기본 발신함을 ${email} 로 바꿨습니다.`);
}

/** 연결 점검. 메일을 보내지 않고 프로필만 읽는다 — 위임이 붙었는지 먼저 확인한다. */
export async function probeMailbox(form: FormData): Promise<void> {
  const email = String(form.get("email") ?? "");
  const r = await sa.probe(email);
  await settings.testLog("probe", r.ok, { detail: r.detail }, null, email);
  done(r.detail, r.ok ? "ok" : "err");
}

/**
 * 발송 테스트. 진짜로 한 통 보낸다.
 *
 * dry-run 으로 끝나면 테스트가 아니다 — "보냈는데 안 온다" 를 잡으려면 실제
 * 스코프(compose)까지 통과해야 한다. 그래서 결과에 dryRun 여부를 그대로 남긴다.
 */
export async function sendTest(form: FormData): Promise<void> {
  const to = String(form.get("to") ?? "").trim();
  if (!to) done("받는 주소를 입력하세요.", "err");
  const from = (await sa.defaultMailbox()) ?? (await settings.get("mail.address"));
  let msg: string;
  let ok = false;
  try {
    const res = await gmail.send({
      from,
      fromName: await settings.get("mail.org"),
      to,
      subject: "[아웃리치 콘솔] 발송 테스트",
      body:
        "이 메일이 보이면 서비스 계정 + 도메인 전체 위임 연동이 정상입니다.\n\n" +
        `발신함: ${from}\n보낸 시각: ${new Date().toLocaleString("ko-KR")}\n`,
    });
    ok = !res.dryRun;
    msg = res.dryRun
      ? "키가 없거나 기본 발신함이 없어 dry-run 으로 처리했습니다. 메일은 나가지 않았습니다."
      : `${from} → ${to} 로 발송했습니다.`;
    await settings.testLog("send", ok, { from, message_id: res.providerMessageId, detail: msg }, null, to);
  } catch (e) {
    msg = (e as Error).message;
    await settings.testLog("send", false, { from, detail: msg }, null, to);
  }
  done(msg, ok ? "ok" : "err");
}

/** 수신 테스트. 등록된 메일함을 한 번 훑어 몇 통을 읽었는지 본다. */
export async function receiveTest(): Promise<void> {
  let msg: string;
  let ok = false;
  try {
    const r = await inboundTick();
    ok = !r.dryRun;
    msg = r.dryRun
      ? "키가 없거나 활성 메일함이 없어 수집을 건너뛰었습니다."
      : `연결 ${r.processed}건 · 매핑 실패 ${r.unmapped}건 · 중복·오류 ${r.skipped}건`;
    await settings.testLog("receive", ok, { detail: msg });
  } catch (e) {
    msg = (e as Error).message;
    await settings.testLog("receive", false, { detail: msg });
  }
  done(msg, ok ? "ok" : "err");
}

/** DNS 점검. 결과를 기록에 남겨야 "어제는 됐는데" 를 확인할 수 있다. */
export async function dnsTest(): Promise<void> {
  const domain = await settings.get("mail.domain");
  const r = await checkDomain(domain);
  const detail = r.checks.map((c) => `${c.label}: ${c.status}`).join(" · ");
  await settings.testLog("dns", r.ok, { detail }, null, domain);
  done(detail, r.ok ? "ok" : "err");
}
