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

/**
 * 전부 지우고 처음부터.
 *
 * 데모 시드를 걷어내고 실데이터를 올리려면 한 번은 비워야 한다. API 라우트에
 * drop=1 이 있지만 그건 curl 로만 부를 수 있다 — 터미널 없이 브라우저에서
 * 끝내야 하므로 화면에도 낸다.
 *
 * 되돌릴 수 없는 동작이라 시크릿만으로는 부족하다. 확인 문구를 정확히 입력하게
 * 한다 — 실수로 눌러서 19,000행이 날아가는 일은 한 번도 있으면 안 된다.
 */
export async function resetAction(form: FormData) {
  checkSecret(form);
  if (String(form.get("confirm") ?? "").trim() !== "전부 지운다") {
    back("err", '확인 문구가 다릅니다. "전부 지운다" 를 그대로 입력해야 실행됩니다.');
  }
  let msg: string;
  try {
    const r = await setupDb({ drop: true });
    msg = `전부 지우고 스키마를 새로 적용했습니다. 테이블 ${num(r.tables)}개. 이제 /import 에서 실데이터를 올리세요.`;
  } catch (e) {
    back("err", `초기화 실패: ${(e as Error).message}`);
  }
  back("ok", msg);
}
