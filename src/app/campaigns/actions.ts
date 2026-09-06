"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { one, run } from "@/lib/db";
import { CATEGORIES, STATUSES } from "./fields";
import { josa } from "@/lib/format";
import { normName } from "@/lib/parse";

/**
 * 캠페인 생성·수정.
 *
 * 여태 캠페인은 SQL 로만 만들 수 있었다. 데이터가 다 들어와도 대상을 묶을 그릇이
 * 없으면 한 통도 못 보낸다.
 *
 * 고를 수 있는 값은 fields.ts 에 있다. 화면의 select 만으로는 방어가 되지 않으므로
 * 여기서 다시 검사한다 — 폼은 우회할 수 있고, SQL 로 직접 넣는 경로도 남아 있다.
 */

const JAY = "00000000-0000-0000-0000-0000000000aa";

/** 폼에 다시 채워 넣을 값. 실패했다고 입력을 날리면 같은 값을 또 타이핑하게 된다. */
const KEEP = ["name", "brand_name", "category", "commission_rate", "sale_from", "sale_to", "target_count", "status"];

function back(msg: string, kind: "ok" | "err", id?: string, form?: FormData): never {
  revalidatePath("/campaigns");
  const q = new URLSearchParams({ kind, msg });
  if (id) q.set("id", id);
  if (form) {
    // 실패한 폼은 펼친 채로, 값을 그대로 되돌려준다.
    q.set("edit", id ? "1" : "new");
    for (const k of KEEP) {
      const val = String(form.get(k) ?? "").trim();
      if (val) q.set(`f_${k}`, val);
    }
  }
  redirect(`/campaigns?${q}`);
}

interface Fields {
  name: string;
  brand_name: string;
  category: string;
  commission_rate: string | null;
  sale_from: string | null;
  sale_to: string | null;
  target_count: number | null;
  status: string;
}

/** 폼 값 검사. 하나라도 틀리면 아무것도 저장하지 않는다. */
function parse(form: FormData): { fields: Fields } | { error: string } {
  const str = (k: string) => String(form.get(k) ?? "").trim();

  const name = str("name");
  if (!name) return { error: "캠페인 이름을 입력하세요." };
  if (name.length > 80) return { error: "캠페인 이름이 너무 깁니다 (80자 이내)." };

  const brand_name = str("brand_name");
  if (!brand_name) return { error: "브랜드명을 입력하세요." };

  const category = str("category");
  if (!CATEGORIES.includes(category)) {
    return { error: `카테고리는 ${CATEGORIES.join(" · ")} 중에서 고르세요. 적합도 점수가 이 값으로 매겨집니다.` };
  }

  const status = str("status") || "running";
  if (!STATUSES.has(status)) return { error: "알 수 없는 상태입니다." };

  const rateRaw = str("commission_rate");
  let commission_rate: string | null = null;
  if (rateRaw) {
    const n = Number(rateRaw);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { error: "수수료율은 0~100 사이 숫자입니다." };
    commission_rate = String(n);
  }

  const sale_from = str("sale_from") || null;
  const sale_to = str("sale_to") || null;
  if (sale_from && sale_to && sale_to < sale_from) {
    return { error: "판매 종료일이 시작일보다 빠릅니다." };
  }

  const targetRaw = str("target_count");
  let target_count: number | null = null;
  if (targetRaw) {
    const n = Number(targetRaw);
    if (!Number.isInteger(n) || n < 1) return { error: "목표 인원은 1 이상의 정수입니다." };
    target_count = n;
  }

  return { fields: { name, brand_name, category, commission_rate, sale_from, sale_to, target_count, status } };
}

export async function createCampaign(form: FormData): Promise<void> {
  const r = parse(form);
  if ("error" in r) back(r.error, "err", undefined, form);
  const f = r.fields;

  // 브랜드는 이름으로 이어 붙인다. 없으면 만든다 — 경쟁 브랜드 판정이 brand_id 를 본다.
  //
  // 매칭 키는 name 이 아니라 name_norm 이다. "락앤락"과 "락앤락 (LOCK&LOCK)" 이
  // 다른 브랜드로 갈라지면, 같은 브랜드를 최근에 진행한 크리에이터를 걸러내지 못한다.
  const brand = await one<{ id: string }>(
    `INSERT INTO brand (name, name_norm, category) VALUES ($1,$2,$3)
     ON CONFLICT (name_norm) DO UPDATE SET last_seen = now() RETURNING id`,
    [f.brand_name, normName(f.brand_name), f.category],
  );

  const row = await one<{ id: string }>(
    `INSERT INTO campaign (name, brand_id, brand_name, category, commission_rate,
                           sale_from, sale_to, target_count, status, owner_user_id)
     VALUES ($1,$2,$3,$4,$5::numeric,$6::date,$7::date,$8,$9,$10) RETURNING id`,
    [f.name, brand?.id ?? null, f.brand_name, f.category, f.commission_rate,
     f.sale_from, f.sale_to, f.target_count, f.status, JAY],
  );

  back(
    f.status === "running"
      ? `${josa(f.name, "을를")} 만들었습니다. 아래에서 대상을 담으세요.`
      : `${josa(f.name, "을를")} 초안으로 만들었습니다. 발송하려면 상태를 '진행 중' 으로 바꾸세요.`,
    "ok",
    row!.id,
  );
}

export async function updateCampaign(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) back("캠페인을 찾을 수 없습니다.", "err");

  const r = parse(form);
  if ("error" in r) back(r.error, "err", id, form);
  const f = r.fields;

  await run(
    `UPDATE campaign SET name=$2, brand_name=$3, category=$4, commission_rate=$5::numeric,
            sale_from=$6::date, sale_to=$7::date, target_count=$8, status=$9
      WHERE id=$1`,
    [id, f.name, f.brand_name, f.category, f.commission_rate,
     f.sale_from, f.sale_to, f.target_count, f.status],
  );
  back("캠페인을 수정했습니다.", "ok", id);
}
