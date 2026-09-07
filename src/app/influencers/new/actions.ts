"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createManual, type ManualInput } from "@/lib/manual-creator";

/**
 * 직접 등록의 서버 액션.
 *
 * 실패하면 입력한 값을 그대로 되돌려준다. 열몇 칸을 채우다 한 칸이 틀려서 전부
 * 다시 쓰게 되면 아무도 이 화면을 쓰지 않는다.
 */

const JAY = "00000000-0000-0000-0000-0000000000aa";

const KEEP = [
  "handle", "displayName", "email", "phone", "kakao", "linkInBio", "inlinkUrl",
  "dmUrl", "followers", "category", "tier", "contactGrade", "note", "sourceType", "sourceUrl",
];

export async function addCreator(form: FormData): Promise<void> {
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const input: ManualInput = {
    handle: str("handle"),
    displayName: str("displayName"),
    email: str("email"),
    phone: str("phone"),
    kakao: str("kakao"),
    linkInBio: str("linkInBio"),
    inlinkUrl: str("inlinkUrl"),
    dmUrl: str("dmUrl"),
    followers: str("followers"),
    category: str("category"),
    tier: str("tier"),
    contactGrade: str("contactGrade"),
    hasGonggu: form.get("hasGonggu") === "1",
    note: str("note"),
    sourceType: str("sourceType"),
    sourceUrl: str("sourceUrl"),
  };

  const r = await createManual(input, JAY);
  revalidatePath("/influencers");

  if (r.ok) {
    // 성공하면 폼을 비운다 — 연달아 여러 명 넣는 게 이 화면의 주 용도다.
    redirect(`/influencers/new?kind=ok&msg=${encodeURIComponent(`@${r.handle} 을 등록했습니다.`)}`);
  }

  const q = new URLSearchParams({ kind: "err", msg: r.error ?? "등록에 실패했습니다." });
  if (r.existingId) q.set("dup", r.existingId);
  for (const k of KEEP) {
    const v = str(k);
    if (v) q.set(`f_${k}`, v);
  }
  if (input.hasGonggu) q.set("f_hasGonggu", "1");
  redirect(`/influencers/new?${q}`);
}
