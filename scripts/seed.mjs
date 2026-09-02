#!/usr/bin/env node
/**
 * 데모 시드.
 *
 * 프로토타입의 상세 샘플 12명을 그대로 넣고, 그 위에 세 소스 합집합 추정 규모
 * (크리에이터 1,742명)를 결정론적으로 생성한다. 시드가 같으면 항상 같은 모집단이 나온다.
 * 핸들·브랜드는 가상 값이며 실제 계정이 아니다.
 */
import crypto from "node:crypto";
import pg from "pg";
import { CREATORS, BRANDS, DEALS, CAMPAIGNS, THREADS, TASKS, EVENTS, IMPORT_HISTORY, REVIEW_ROWS, TODAY } from "./seed-data.mjs";

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "postgres://postgres@127.0.0.1:5433/gong";
const ssl = /neon\.tech|vercel-storage|supabase|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined;
const db = new pg.Client({ connectionString: url, ssl });
await db.connect();

const existing = (await db.query("SELECT count(*)::int n FROM creator")).rows[0].n;
if (existing > 0 && !process.argv.includes("--force")) {
  console.log(`[seed] 이미 시드됨 (creator ${existing}건). --force 로 재생성.`);
  await db.end();
  process.exit(0);
}
if (process.argv.includes("--force")) {
  await db.query(`TRUNCATE creator, brand, deal, campaign, import_batch, change_event, message,
                  outreach_task, campaign_member, suppression, source_ref, audit_log, gate_block RESTART IDENTITY CASCADE`);
}

const uid = () => crypto.randomUUID();
const JAY = "00000000-0000-0000-0000-0000000000aa";

// 결정론 PRNG
let _s = 20260901;
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/^@/, "").replace(/[^a-z0-9._]/g, "");
const cmpKey = (s) => norm(s).replace(/[._]/g, "");
const normName = (s) => String(s ?? "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{N}]+/gu, "");
const shiftDays = (base, n) => {
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - n));
  return dt.toISOString().slice(0, 10);
};
const IG = (h) => `https://www.instagram.com/${h}`;

/** 다중 행 INSERT. 파라미터 상한(65535)을 넘지 않도록 잘라 넣는다. */
async function insertMany(table, cols, rows, extra = "") {
  if (!rows.length) return;
  const perRow = cols.length;
  const chunk = Math.max(1, Math.floor(60000 / perRow));
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const values = [];
    const params = [];
    slice.forEach((r, ri) => {
      values.push(`(${cols.map((_, ci) => `$${ri * perRow + ci + 1}`).join(",")})`);
      params.push(...r);
    });
    await db.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values.join(",")} ${extra}`, params);
  }
}

const stageIds = Object.fromEntries((await db.query("SELECT key,id FROM pipeline_stage")).rows.map((r) => [r.key, r.id]));
const senderIds = Object.fromEntries((await db.query("SELECT identifier,id FROM sender")).rows.map((r) => [r.identifier, r.id]));
const SEQ = "00000000-0000-0000-0000-00000000f001";

// ---------- 브랜드 ----------
const brandId = {};
await insertMany(
  "brand",
  ["id", "name", "name_norm", "category", "is_verified", "first_seen", "last_seen"],
  BRANDS.map((b) => {
    const id = uid();
    brandId[b.name] = id;
    return [id, b.name, normName(b.name), b.category, b.dict === 1, TODAY, TODAY];
  }),
);

// ---------- 크리에이터 ----------
const creatorRows = [];
const accountRows = [];
const snapRows = [];
const contactRows = [];
const srefRows = [];
const byHandle = {};

function addCreator(o) {
  const cid = uid();
  const aid = uid();
  byHandle[o.handle] = { creatorId: cid, accountId: aid, ...o };
  creatorRows.push([cid, o.name, "instagram", o.tier, o.region, o.gbExp ?? "regular", false, o.curated === 1, null, JAY, TODAY]);
  accountRows.push([aid, cid, "instagram", o.platformUserId ?? null, o.handle, o.handleRaw ?? `@${o.handle}`, IG(o.handle), o.active !== false, TODAY]);
  snapRows.push([
    aid, `${TODAY} 10:22+09`, o.source ?? "pangpang", o.followers, o.followersPrecision ?? 500,
    o.following, o.posts, o.er ?? null, o.credibility ?? null,
    o.lastActive ?? `${shiftDays(TODAY, int(0, 3))} 09:00+09`,
    o.deals30, o.deals90, o.cadence, o.lastDealDays, JSON.stringify(o.share ?? {}),
  ]);
  for (const s of o.sources ?? []) {
    srefRows.push(["creator", cid, s, `${s}-${o.handle}`, IG(o.handle), TODAY]);
  }
  return { cid, aid };
}

const SRC = { 맘: "momcal", 팡: "pangpang", 인: "ingong" };

for (const c of CREATORS) {
  const { cid } = addCreator({
    handle: c.h, name: c.n, tier: c.tier, region: c.region, curated: c.curated,
    followers: c.f, following: c.fl, posts: c.p, deals30: c.d30, deals90: c.d30 * 3 - 1,
    cadence: c.cad, lastDealDays: c.last, share: Object.fromEntries(c.sh),
    er: c.er ?? 0.032, credibility: c.credibility ?? 78,
    sources: c.src.map((s) => SRC[s]), platformUserId: c.pk ?? null,
    active: c.h !== "babyroom_diary",
  });
  if (c.em) {
    contactRows.push([uid(), cid, "email", c.em, c.em.toLowerCase(), "bio_public", IG(c.h), "2026-07-14", JAY,
      'bio에 "공구문의" 명시', "implied_public", null, "valid", true]);
  }
  if (c.reach === "inpock") {
    contactRows.push([uid(), cid, "inpock_offer", `inpock.link/${c.h}`, `inpock.link/${c.h}`, "link_page_public",
      IG(c.h), "2026-08-02", JAY, "링크페이지 제안 폼", "implied_public", null, "unverified", true]);
  }
  if (c.reach === "dm") {
    contactRows.push([uid(), cid, "instagram_dm", `@${c.h}`, `@${c.h}`, "bio_public", IG(c.h), "2026-08-02", JAY,
      "DM 문의만 표기", "implied_public", null, "unverified", true]);
  }
}

// ---------- 모집단 생성 ----------
const CATS = [
  { cat: "리빙", w: 26, share: { 리빙: 55, 인테리어: 20, 가전: 15, 식품: 10 } },
  { cat: "육아", w: 22, share: { 육아: 62, 식품: 18, 리빙: 12, 건강: 8 } },
  { cat: "식품", w: 14, share: { 식품: 58, 건강: 24, 육아: 18 } },
  { cat: "뷰티", w: 12, share: { 뷰티: 66, 패션: 20, 건강: 14 } },
  { cat: "패션", w: 8, share: { 패션: 63, 뷰티: 22, 리빙: 15 } },
  { cat: "인테리어", w: 7, share: { 인테리어: 61, 리빙: 28, 가전: 11 } },
  { cat: "건강", w: 5, share: { 건강: 64, 식품: 26, 뷰티: 10 } },
  { cat: "여행", w: 3, share: { 여행: 70, 육아: 18, 식품: 12 } },
  { cat: "반려동물", w: 3, share: { 반려동물: 72, 리빙: 16, 식품: 12 } },
];
const catPool = CATS.flatMap((c) => Array(c.w).fill(c));
const A = ["mom","daily","living","cozy","haru","sora","mint","olive","namu","bom","hue","sol","jane","moa","rumi","toy","kids","table","salt","onul","yeon","hana","ruda","gaon","nari","seol","danbi","miso","rok","dodam"];
const B = ["home","log","diary","life","room","table","kitchen","store","market","note","days","story","pick","shop","mom","living","style","care","food","trip"];
const C = ["","_k","_official",".kr","_daily","01","_2",".log","_shop","_mom","_room","_e","88","_v"];
const NK1 = ["소소한","슬기로운","달콤한","포근한","정갈한","하루","봄날","초록","따뜻한","심플","느린","단정한","맑은","고운"];
const NK2 = ["하루","살림","주방","육아","일상","테이블","집","기록","마켓","라이프","다이어리","노트","홈","키친"];

const TARGET = 1742;
const used = new Set(Object.keys(byHandle).map(cmpKey));
const generated = [];
let pangPk = 9000; // 공구팡팡 account_id 는 유일해야 한다

while (used.size < TARGET) {
  const handle = `${pick(A)}${rnd() < 0.55 ? "_" : rnd() < 0.5 ? "." : ""}${pick(B)}${pick(C)}`;
  if (!norm(handle) || used.has(cmpKey(handle))) continue;
  used.add(cmpKey(handle));

  const c = pick(catPool);
  const r = rnd();
  const followers = r < 0.42 ? int(3000, 9900) : r < 0.86 ? int(10000, 99000) : r < 0.97 ? int(100000, 299000) : int(300000, 820000);
  const tier = followers < 10000 ? "nano" : followers < 100000 ? "micro" : followers < 500000 ? "mid" : "macro";
  const cadence = int(7, 26);
  const lastDealDays = int(0, Math.round(cadence * 2.6));
  const deals30 = Math.max(0, Math.round(30 / cadence) + int(-1, 1));
  const sources = ["맘", "팡", "인"].filter(() => rnd() < 0.62);
  if (!sources.length) sources.push(pick(["맘", "팡", "인"]));

  // 점유율에 개체별 흔들림
  const share = {};
  let rest = 100;
  const keys = Object.keys(c.share);
  keys.forEach((k, i) => {
    const v = i === keys.length - 1 ? rest : Math.max(2, Math.min(rest - (keys.length - i - 1) * 2, c.share[k] + int(-8, 8)));
    share[k] = v;
    rest -= v;
  });

  const { cid } = addCreator({
    handle, name: `${pick(NK1)}${pick(NK2)}`, tier,
    region: pick(["서울","경기","인천","부산","대구","광주","대전","제주","강원","충북"]),
    curated: rnd() < 0.18 ? 1 : 0,
    followers, following: int(180, 2400), posts: int(120, 4200),
    deals30, deals90: deals30 * 3, cadence, lastDealDays, share,
    er: Number((0.008 + rnd() * 0.055).toFixed(4)),
    credibility: Number((45 + rnd() * 50).toFixed(1)),
    sources: sources.map((s) => SRC[s]),
    platformUserId: sources.includes("팡") ? String(++pangPk) : null,
    lastActive: `${shiftDays(TODAY, int(0, 9))} ${String(int(6, 22)).padStart(2, "0")}:00+09`,
  });

  const rr = rnd();
  if (rr < 0.62) {
    const dom = pick(["gmail.com", "naver.com", "daum.net", "kakao.com"]);
    const addr = `${cmpKey(handle).slice(0, 8)}@${dom}`;
    contactRows.push([uid(), cid, "email", addr, addr, "bio_public", IG(handle),
      shiftDays(TODAY, int(10, 120)), JAY, "bio 이메일 표기", "implied_public", null,
      rnd() < 0.75 ? "valid" : "unverified", true]);
  } else if (rr < 0.82) {
    contactRows.push([uid(), cid, "inpock_offer", `inpock.link/${handle}`, `inpock.link/${handle}`, "link_page_public",
      IG(handle), shiftDays(TODAY, int(10, 120)), JAY, null, "implied_public", null, "unverified", true]);
  } else if (rr < 0.93) {
    contactRows.push([uid(), cid, "instagram_dm", `@${handle}`, `@${handle}`, "bio_public", IG(handle),
      shiftDays(TODAY, int(10, 120)), JAY, "DM 문의만 표기", "implied_public", null, "unverified", true]);
  }

  generated.push({ handle, creatorId: cid, cat: c.cat, cadence, lastDealDays });
}

await insertMany("creator", ["id","display_name","primary_platform","tier","home_region","gb_experience","is_agency","is_curated","agency_name","owner_user_id","created_at"], creatorRows);
await insertMany("social_account", ["id","creator_id","platform","platform_user_id","handle","handle_raw","profile_url","is_active","created_at"], accountRows);
await insertMany("account_snapshot", ["social_account_id","captured_at","source","followers","followers_precision","following","posts_count","engagement_rate","credibility","last_active_at","deals_30d","deals_90d","avg_interval_days","days_since_last","category_share"], snapRows);
await insertMany("contact_point", ["id","creator_id","channel","value","value_norm","source_type","source_url","collected_at","collected_by","collect_note","consent_status","consent_at","verification","is_primary"], contactRows, "ON CONFLICT DO NOTHING");
await insertMany("source_ref", ["entity","entity_id","source","source_pk","source_url","observed_at"], srefRows, "ON CONFLICT DO NOTHING");

// ---------- 딜 ----------
const dealRows = [];
const dealSrcRows = [];
function addDeal({ handle, brand, title, cat, from, to, price, always, curated, gone }) {
  const acc = byHandle[handle];
  if (!acc) return;
  const id = uid();
  dealRows.push([
    id, acc.creatorId, acc.accountId, brand ? brandId[brand] : null, title, normName(title),
    cat, from ? `${from} 10:00+09` : null, to ? `${to} 23:59+09` : null, from, to,
    !!always, price ?? null, !!curated, gone ? "gone" : "active", IG(handle), from ?? TODAY, TODAY,
  ]);
  dealSrcRows.push([id, "pangpang", `pang-${id.slice(0, 8)}`, IG(handle), gone ? 410 : 200]);
}

for (const d of DEALS) {
  addDeal({ handle: d.h, brand: d.b, title: d.p, cat: d.c, from: d.f, to: d.t, price: d.pr, always: d.always, curated: d.pick, gone: d.gone });
}

const PRODUCT = {
  리빙: ["극세사 러그","스텐 밀폐용기","수납 정리함","원목 협탁","다용도 선반"],
  육아: ["아기 물티슈","유아 간식 세트","원목 책상","아기 욕조","이유식 용기"],
  식품: ["저당 현미밥","저염 반찬","냉동 만두","유기농 이유식","국산 견과"],
  뷰티: ["수분 앰플","리페어 크림","클렌징 폼","선쿠션","헤어 에센스"],
  패션: ["극세사 홈웨어","니트 가디건","기모 레깅스","코튼 파자마"],
  인테리어: ["워시드 린넨 커튼","차렵이불 세트","발매트","무드등"],
  건강: ["홍삼 스틱","유산균","루테인","단백질 쉐이크"],
  여행: ["풀빌라 특가","글램핑 패키지","호텔 2인 패키지"],
  반려동물: ["자동급수기","원목 캣타워","펫 방석","간식 세트"],
};
const brandNames = BRANDS.map((b) => b.name);
const seenDealKey = new Set(dealRows.map((r) => `${r[1]}|${r[5]}|${r[10]}`));

for (const g of generated) {
  const n = int(1, 5);
  for (let k = 0; k < n; k++) {
    const startAgo = g.lastDealDays + k * (g.cadence + int(-2, 4)) - int(0, 6);
    const from = shiftDays(TODAY, Math.max(-24, startAgo));
    const to = shiftDays(TODAY, Math.max(-30, startAgo - int(4, 7)));
    const bn = rnd() < 0.55 ? pick(brandNames) : null;
    const title = `${bn ? bn + " " : ""}${pick(PRODUCT[g.cat] ?? PRODUCT["리빙"])}`;
    const key = `${g.creatorId}|${normName(title)}|${from}`;
    if (seenDealKey.has(key)) continue;
    seenDealKey.add(key);
    addDeal({ handle: g.handle, brand: bn, title, cat: g.cat, from, to, price: int(9, 220) * 1000 });
  }
}

await insertMany("deal", ["id","creator_id","social_account_id","brand_id","title","title_norm","category_l1","open_at","close_at","open_date","close_date","is_always_on","price_krw","is_curated","status","permalink","first_seen","last_seen"], dealRows, "ON CONFLICT DO NOTHING");
await insertMany("deal_source", ["deal_id","source","source_pk","source_url","http_status"], dealSrcRows, "ON CONFLICT DO NOTHING");

// ---------- 캠페인 ----------
const campaignId = {};
await insertMany(
  "campaign",
  ["id","name","brand_id","brand_name","category","commission_rate","sale_from","sale_to","status","owner_user_id"],
  CAMPAIGNS.map((c) => {
    const id = uid();
    campaignId[c.name] = id;
    return [id, c.name, brandId[c.brand], c.brand, c.category, c.commission, c.from, c.to, "running", JAY];
  }),
);

// ---------- 캠페인 멤버 (상태 3축) ----------
const ENGINE = { QUEUED:1, IN_SEQUENCE:3, REPLIED:-1, NO_REPLY:-2, DROPPED:-6, OPTED_OUT:-4 };
const memberRows = [];
const msgRows = [];
const homewear = campaignId["가을 홈웨어 공구"];

function addMember({ campaign, handle, stage, engine, interest, step, gmv, sentDaysAgo, repliedDaysAgo, dropReason }) {
  const acc = byHandle[handle];
  if (!acc) return null;
  const id = uid();
  memberRows.push([
    id, campaign, acc.creatorId, stageIds[stage], engine, interest ?? 0, SEQ, step ?? 1,
    engine > 0 ? `${shiftDays(TODAY, -1)} 10:00+09` : null, JAY, null, null,
    `cm_${id.slice(0, 8)}`,
    sentDaysAgo != null ? `${shiftDays(TODAY, sentDaysAgo)} 10:00+09` : null,
    sentDaysAgo != null ? `${shiftDays(TODAY, Math.max(0, sentDaysAgo - (step ?? 1) * 3))} 10:00+09` : null,
    repliedDaysAgo != null ? `${shiftDays(TODAY, repliedDaysAgo)} 12:00+09` : null,
    ["agreed","live","settling","complete"].includes(stage) ? `${shiftDays(TODAY, 2)} 12:00+09` : null,
    stage === "live" ? `${shiftDays(TODAY, 1)} 09:00+09` : null,
    engine < 0 && stage === "dropped" ? `${shiftDays(TODAY, 2)} 09:00+09` : null,
    dropReason ?? null, gmv ?? 0,
  ]);
  return id;
}

const STAGE_OF = {
  contacted: ["contacted", ENGINE.IN_SEQUENCE, 0],
  replied: ["replied", ENGINE.REPLIED, 2],
  negotiating: ["negotiating", ENGINE.REPLIED, 2],
  confirmed: ["agreed", ENGINE.REPLIED, 3],
  running: ["live", ENGINE.REPLIED, 3],
  dropped: ["dropped", ENGINE.DROPPED, -2],
};
for (const c of CREATORS) {
  if (!c.st) continue;
  const camp = c.h === "jinny_kitchen" ? "주방 리빙 3차" : c.h === "babyroom_diary" ? "키즈 시즌오프" : "가을 홈웨어 공구";
  const [stage, engine, interest] = STAGE_OF[c.st];
  addMember({
    campaign: campaignId[camp], handle: c.h, stage,
    engine: c.h === "babyroom_diary" ? ENGINE.OPTED_OUT : engine,
    interest: c.h === "babyroom_diary" ? -4 : interest,
    step: c.st === "contacted" ? 2 : 1,
    gmv: c.st === "confirmed" ? 1240000 : c.st === "running" ? 820000 : 0,
    sentDaysAgo: 4, repliedDaysAgo: c.st === "contacted" ? null : 2,
    dropReason: c.h === "babyroom_diary" ? "연락 금지 요청" : null,
  });
}

const pipeline = generated.filter((g) => ["리빙","인테리어","육아"].includes(g.cat)).slice(0, 320);
pipeline.forEach((g, i) => {
  const spec = i < 12 ? ["agreed", ENGINE.REPLIED, 3, int(400,2200)*1000]
    : i < 20 ? ["live", ENGINE.REPLIED, 3, int(200,1600)*1000]
    : i < 48 ? ["negotiating", ENGINE.REPLIED, 2, 0]
    : i < 96 ? ["replied", ENGINE.REPLIED, 1, 0]
    : i < 130 ? ["dropped", ENGINE.DROPPED, -2, 0]
    : ["contacted", ENGINE.IN_SEQUENCE, 0, 0];
  const replied = spec[1] === ENGINE.REPLIED;
  addMember({
    campaign: homewear, handle: g.handle, stage: spec[0], engine: spec[1], interest: spec[2],
    step: replied ? int(1,2) : 4, gmv: spec[3],
    sentDaysAgo: int(4,22), repliedDaysAgo: replied ? int(1,10) : null,
    dropReason: spec[0] === "dropped" ? "무응답" : null,
  });
});

await insertMany("campaign_member", ["id","campaign_id","creator_id","stage_id","engine_state","interest_status","sequence_id","current_step","next_action_at","owner_user_id","fit_score","fit_breakdown","reply_token","first_sent_at","last_sent_at","replied_at","agreed_at","live_at","dropped_at","drop_reason","gmv"], memberRows, "ON CONFLICT DO NOTHING");

// ---------- 메시지 (통합 인박스) ----------
const memberByHandle = {};
for (const row of (await db.query(
  `SELECT cm.id, sa.handle FROM campaign_member cm
     JOIN social_account sa ON sa.creator_id = cm.creator_id`)).rows) {
  memberByHandle[row.handle] ??= row.id;
}
for (const t of THREADS) {
  const mid = memberByHandle[t.who];
  if (!mid) continue;
  for (const m of t.msgs) {
    msgRows.push([mid, m.d === "out" ? senderIds["partner@dinostudio.kr"] : null, "email", m.d,
      t.key, m.d === "out" ? `msg-${uid().slice(0,8)}` : `in-${uid().slice(0,8)}`,
      m.w, m.d === "out" ? "(광고) 공동구매 제안드립니다" : "RE: 공동구매 제안", m.b, `${m.t}+09`]);
  }
  const last = t.msgs[t.msgs.length - 1];
  await db.query(
    `UPDATE campaign_member SET interest_status=$1, replied_at=$2 WHERE id=$3`,
    [t.interest ?? 0, last.d === "in" ? `${last.t}+09` : null, mid],
  );
}
await insertMany("message", ["campaign_member_id","sender_id","channel","direction","thread_key","provider_msg_id","from_name","subject","body","sent_at"], msgRows);

// 모집단 발송 기록 — 4스텝 시퀀스. 회신율이 실제 값으로 나오도록 스텝을 쌓는다.
const bulkMsg = [];
for (const row of (await db.query(
  `SELECT cm.id, cm.engine_state, cm.current_step, cm.first_sent_at
     FROM campaign_member cm WHERE cm.first_sent_at IS NOT NULL`)).rows) {
  const replied = row.engine_state === -1;
  const steps = replied ? Math.max(1, row.current_step) : 4;
  for (let k = 0; k < steps; k++) {
    const at = new Date(new Date(row.first_sent_at).getTime() + k * 3 * 864e5);
    bulkMsg.push([row.id, senderIds["partner@dinostudio.kr"], "email", "out", `gm-${row.id.slice(0,8)}`,
      `seq-${row.id.slice(0,8)}-${k}`, "지은 (Dinostudio)", "(광고) 공동구매 제안드립니다",
      `스텝 ${k + 1} 발송 본문`, at.toISOString()]);
  }
}
await insertMany("message", ["campaign_member_id","sender_id","channel","direction","thread_key","provider_msg_id","from_name","subject","body","sent_at"], bulkMsg, "ON CONFLICT DO NOTHING");

// ---------- 작업 큐 ----------
// 작업 큐 대상도 캠페인 멤버여야 한다 — outreach_task 는 campaign_member 에 매달린다.
const queueTargets = [
  ...TASKS.map((t) => ({ handle: t.who, camp: campaignId[t.camp] ?? homewear })),
  ...generated.filter((g) => ["리빙", "육아"].includes(g.cat)).slice(400, 412).map((g) => ({ handle: g.handle, camp: homewear })),
];
const extraMembers = [];
for (const q of queueTargets) {
  if (memberByHandle[q.handle]) continue;
  const acc = byHandle[q.handle];
  if (!acc) continue;
  const id = uid();
  extraMembers.push([id, q.camp, acc.creatorId, stageIds["qualified"], ENGINE.QUEUED, 0, SEQ, 0,
    `${TODAY} 12:00+09`, JAY, null, null, `cm_${id.slice(0, 8)}`, null, null, null, null, null, null, null, 0]);
  memberByHandle[q.handle] = id;
}
await insertMany("campaign_member", ["id","campaign_id","creator_id","stage_id","engine_state","interest_status","sequence_id","current_step","next_action_at","owner_user_id","fit_score","fit_breakdown","reply_token","first_sent_at","last_sent_at","replied_at","agreed_at","live_at","dropped_at","drop_reason","gmv"], extraMembers, "ON CONFLICT DO NOTHING");

const taskRows = [];
for (const t of TASKS) {
  const mid = memberByHandle[t.who];
  if (!mid) continue;
  taskRows.push([mid, t.kind === "ig_dm" ? "instagram_dm" : t.kind === "inpock" ? "inpock_offer" : "email",
    t.sender ? senderIds[t.sender] : null, null, t.body, IG(t.who), "queued", `${t.at}+09`]);
}
for (const g of generated.filter((x) => ["리빙", "육아"].includes(x.cat)).slice(400, 412)) {
  const mid = memberByHandle[g.handle];
  if (!mid) continue;
  const dm = taskRows.length % 2 === 0;
  taskRows.push([mid, dm ? "instagram_dm" : "inpock_offer", dm ? senderIds["@dino_partner"] : null, null,
    dm ? "안녕하세요! 공구 꾸준히 보고 있었습니다. 9월 중순 라누보 홈웨어 공구 함께 하실 수 있을지 여쭙습니다."
       : "제안 유형: 공동구매 / 기간: 09-15~09-28 / 카테고리: 홈리빙 / 제안 가격: 수수료 18%",
    IG(g.handle), "queued", `${TODAY} 1${taskRows.length % 8}:00+09`]);
}
await insertMany("outreach_task", ["campaign_member_id","channel","sender_id","rendered_subject","rendered_body","target_url","state","due_at"], taskRows);

// ---------- suppression ----------
const supRows = [
  ["global", null, "email", "baby@gmail.com", [], "dnc_request", `${shiftDays(TODAY, 3)}`],
  ["global", null, "ig_handle", "babyroom_diary", [], "dnc_request", `${shiftDays(TODAY, 3)}`],
  ["global", null, "email_domain", "kmarket-agency.kr", ["email"], "unsubscribe", `${shiftDays(TODAY, 11)}`],
];
for (const g of generated.slice(700, 726)) {
  supRows.push(["global", null, "ig_handle", g.handle, [], rnd() < 0.5 ? "unsubscribe" : "dnc_request", shiftDays(TODAY, int(3, 90))]);
}
await insertMany("suppression", ["scope","scope_ref","identifier_type","identifier_val","channels","reason","created_at"], supRows, "ON CONFLICT DO NOTHING");

// ---------- 변화 감지 ----------
const batchRows = IMPORT_HISTORY.map((h) => [uid(), h.source === "pang" ? "pangpang" : h.source === "ingong" ? "ingong" : "momcal",
  h.file, JAY, `${h.at}+09`, h.rows, h.created, h.updated, h.review, h.errors, h.status === "applied" ? "committed" : "dry_run", `${h.at}+09`]);
await insertMany("import_batch", ["id","source","filename","uploaded_by","observed_at","rows_read","rows_new","rows_merged","rows_review","rows_error","state","created_at"], batchRows);
const pendingBatch = batchRows.find((b) => b[10] === "dry_run")?.[0] ?? null;

await insertMany("change_event", ["batch_id","kind","handle","title","detail","severity","occurred_at"],
  EVENTS.map((e) => [pendingBatch, e.k, e.h, e.s, `${e.t} — ${e.d}`,
    ["conflict","dead"].includes(e.k) ? "alert" : ["gone","handle"].includes(e.k) ? "warn" : "info",
    `${TODAY} 10:22+09`]));

await insertMany("merge_candidate", ["batch_id","incoming","candidate_id","score","evidence","decision"],
  REVIEW_ROWS.map((r) => [pendingBatch, JSON.stringify({ handle: r.handle, match: r.match }),
    byHandle[r.match]?.creatorId ?? null, r.score, r.reason, "pending"]));

const n = async (t) => (await db.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
console.log(`[seed] creator ${await n("creator")} · account ${await n("social_account")} · deal ${await n("deal")}`);
console.log(`[seed] member ${await n("campaign_member")} · message ${await n("message")} · task ${await n("outreach_task")}`);
console.log(`[seed] suppression ${await n("suppression")} · change_event ${await n("change_event")}`);
await db.end();
