"use server";

import { redirect } from "next/navigation";

const num = (n: number) => n.toLocaleString("ko-KR");
// @ts-expect-error — .mjs 스크립트에는 타입 선언이 없다. CLI 와 같은 코드를 쓰기 위해 그대로 가져온다.
import { setupDb } from "../../../scripts/setup-db.mjs";
// @ts-expect-error — 위와 같다.
import { seed } from "../../../scripts/seed.mjs";

/**
 * 초기화 화면의 서버 액션.
 *
 * CRON_SECRET 을 폼으로 받아 확인한다. 시크릿이 URL 에 남지 않게 POST 로만 오간다.
 * 결과 문구만 쿼리로 넘긴다.
 */
function back(kind: "ok" | "err", msg: string): never {
  redirect(`/setup?kind=${kind}&msg=${encodeURIComponent(msg)}`);
}

function checkSecret(form: FormData) {
  const secret = process.env.CRON_SECRET;
  if (!secret) back("err", "CRON_SECRET 이 설정돼 있지 않습니다. Vercel 환경 변수에 추가하고 재배포하세요.");
  if (String(form.get("secret") ?? "") !== secret) back("err", "CRON_SECRET 이 맞지 않습니다.");
}

export async function setupAction(form: FormData) {
  checkSecret(form);
  let msg: string;
  try {
    const r = await setupDb({});
    msg = r.skipped
      ? `스키마가 이미 있습니다 (테이블 ${num(r.tables)}개). 그대로 두었습니다.`
      : `스키마를 적용했습니다. 테이블 ${num(r.tables)}개.`;
  } catch (e) {
    back("err", `스키마 적용 실패: ${(e as Error).message}`);
  }
  back("ok", msg);
}

export async function seedAction(form: FormData) {
  checkSecret(form);
  const force = form.get("force") === "1";
  let msg: string;
  try {
    const r = await seed({ force });
    msg = r.skipped
      ? `데이터가 이미 있습니다 (크리에이터 ${num(r.creator)}명). 그대로 두었습니다.`
      : `데모 데이터를 넣었습니다. 크리에이터 ${num(r.creator)}명 · 공구 ${num(r.deal)}건 · 캠페인 대상 ${num(r.campaign_member)}건.`;
  } catch (e) {
    back("err", `데이터 적재 실패: ${(e as Error).message}`);
  }
  back("ok", msg);
}
