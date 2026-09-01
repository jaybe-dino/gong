#!/usr/bin/env node
// DB 초기화 + 시드. `npm run dev` / `npm run build` 전에 자동 실행된다.
// 이미 시드된 DB 가 있으면 아무것도 하지 않는다. --force 로 다시 만든다.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRANDS, CAMPAIGNS, CIRCUITS, CREATORS, DEALS, EVENTS, IMPORT_HISTORY,
  POLICIES, REVIEW_ROWS, SENDERS, SUPPRESSIONS, TASKS, THREADS, TODAY, WATCHLIST,
} from "./seed-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.GONG_DB ?? path.join(root, "data", "app.db");
const force = process.argv.includes("--force");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
if (force) for (const s of ["", "-wal", "-shm"]) fs.rmSync(dbPath + s, { force: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(fs.readFileSync(path.join(root, "src", "lib", "schema.sql"), "utf8"));

const seeded = db.prepare("SELECT COUNT(*) AS n FROM creator").get().n;
if (seeded > 0 && !force) {
  console.log(`[init-db] 이미 시드됨 (creator ${seeded}건). --force 로 재생성.`);
  process.exit(0);
}

const norm = (s) => String(s ?? "").trim().replace(/^@/, "").toLowerCase().replace(/[._\-\s]/g, "");
const SRC = { 맘: "momcal", 팡: "pang", 인: "ingong" };
const daysBefore = (base, n) => {
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(y, m - 1, d - n);
  const p = (x) => String(x).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
};

// 결정론적 PRNG — 시드가 같으면 항상 같은 모집단이 나온다.
let _s = 20260901;
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pickOf = (arr) => arr[Math.floor(rnd() * arr.length)];
const intBetween = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const stmt = {};
const P = (k, sql) => (stmt[k] ??= db.prepare(sql));

db.exec("BEGIN");

// ---------- 브랜드 ----------
const brandId = {};
for (const b of BRANDS) {
  const r = P("brand", `INSERT INTO brand (name, category, in_dictionary, first_seen_at) VALUES (?,?,?,?)`)
    .run(b.name, b.category, b.dict, TODAY);
  brandId[b.name] = Number(r.lastInsertRowid);
}

// ---------- 채널 정책 / 발신 계정 / 서킷 ----------
for (const p of POLICIES) {
  P("pol", `INSERT INTO channel_policy (channel,cold_allowed,execution,night_block,ad_label,unsub_required,daily_cap,cooldown_days) VALUES (?,?,?,?,?,?,?,?)`)
    .run(p.ch, p.cold, p.exec, p.night, p.ad, p.unsub, p.cap, p.cooldown);
}
for (const s of SENDERS) {
  P("snd", `INSERT INTO sender_account (identifier,channel,daily_cap,sent_today,age_days,ramp_day,status,paused_until) VALUES (?,?,?,?,?,?,?,?)`)
    .run(s.id, s.ch, s.cap, s.sent, s.age, s.ramp, s.status, s.status === "suspended" ? `${TODAY} 23:59` : null);
}
for (const c of CIRCUITS) {
  P("cir", `INSERT INTO circuit_metric (key,label,value,warn_at,stop_at,unit,action) VALUES (?,?,?,?,?,?,?)`)
    .run(c.key, c.label, c.value, c.warn, c.stop, c.unit, c.action);
}
for (const s of SUPPRESSIONS) {
  P("sup", `INSERT INTO suppression (identifier,kind,reason,scope,created_at) VALUES (?,?,?,?,?)`)
    .run(s.id, s.kind, s.reason, s.scope, s.at);
}
for (const w of WATCHLIST) {
  P("wl", `INSERT INTO watchlist (target_type,target,condition,last_hit_at) VALUES (?,?,?,?)`)
    .run(w.type, w.target, w.cond, w.hit);
}

// ---------- 크리에이터 (상세 12명) ----------
const accountByHandle = {};
const creatorByHandle = {};

function insertCreator({ name, tier, category, region, curated, handle, followers, following, posts, sources, lastActive }) {
  const cr = P("cr", `INSERT INTO creator (display_name,tier,primary_category,region,curated,created_at) VALUES (?,?,?,?,?,?)`)
    .run(name, tier, category, region, curated, TODAY);
  const creatorId = Number(cr.lastInsertRowid);
  const ac = P("ac", `INSERT INTO social_account (creator_id,platform,handle,handle_norm,is_primary,status) VALUES (?,'instagram',?,?,1,'active')`)
    .run(creatorId, handle, norm(handle));
  const accountId = Number(ac.lastInsertRowid);

  P("snap", `INSERT INTO account_snapshot (account_id,observed_at,followers,following,posts_count,last_active_at,precision,source) VALUES (?,?,?,?,?,?,?,?)`)
    .run(accountId, `${TODAY} 10:22`, followers, following, posts, lastActive, followers >= 10000 ? 500 : 0, "pang");

  for (const s of sources) {
    const src = SRC[s] ?? s;
    for (const [type, id] of [["creator", creatorId], ["account", accountId]]) {
      P("sref", `INSERT OR IGNORE INTO source_ref (entity_type,entity_id,source,source_pk,source_url,observed_at) VALUES (?,?,?,?,?,?)`)
        .run(type, id, src, `${src}-${id}`, `https://www.instagram.com/${handle}`, TODAY);
    }
  }
  accountByHandle[handle] = accountId;
  creatorByHandle[handle] = creatorId;
  return { creatorId, accountId };
}

for (const c of CREATORS) {
  const { creatorId } = insertCreator({
    name: c.n, tier: c.tier, category: c.cat, region: c.region, curated: c.curated,
    handle: c.h, followers: c.f, following: c.fl, posts: c.p, sources: c.src,
    lastActive: `${daysBefore(TODAY, intBetween(0, 2))} 09:00`,
  });

  for (const [cat, pct] of c.sh) {
    P("cs", `INSERT INTO category_share (creator_id,category,pct) VALUES (?,?,?)`).run(creatorId, cat, pct);
  }
  P("cm", `INSERT INTO creator_metric (creator_id,deals_30d,deals_90d,avg_cadence_days,last_deal_on,source,computed_at) VALUES (?,?,?,?,?,?,?)`)
    .run(creatorId, c.d30, c.d30 * 3 - 1, c.cad, daysBefore(TODAY, c.last), "ingong", TODAY);

  if (c.em) {
    P("cp", `INSERT INTO contact_point (creator_id,kind,value,source_desc,collected_at,collected_by,consent,note) VALUES (?,?,?,?,?,?,?,?)`)
      .run(creatorId, "email", c.em, `공개 bio (instagram.com/${c.h})`, "2026-07-14", "jay", "implied_public", 'bio에 "공구문의" 명시');
  }
  if (c.reach === "inpock") {
    P("cp", `INSERT INTO contact_point (creator_id,kind,value,source_desc,collected_at,collected_by,consent,note) VALUES (?,?,?,?,?,?,?,?)`)
      .run(creatorId, "inpock", `inpock.link/${c.h}`, "공개 프로필 링크페이지", "2026-08-02", "jay", "implied_public", "링크페이지 제안 폼");
  }
  if (c.reach === "dm") {
    P("cp", `INSERT INTO contact_point (creator_id,kind,value,source_desc,collected_at,collected_by,consent,note) VALUES (?,?,?,?,?,?,?,?)`)
      .run(creatorId, "ig_dm", `@${c.h}`, "공개 프로필", "2026-08-02", "jay", "implied_public", "DM 문의만 표기");
  }
}

// ---------- 딜 ----------
for (const d of DEALS) {
  P("deal", `INSERT INTO deal (brand_id,account_id,product_name,category,starts_on,ends_on,price,is_always_on,picked,source,source_url,first_seen_at,last_seen_at,gone_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(d.b ? brandId[d.b] : null, accountByHandle[d.h], d.p, d.c, d.f, d.t, d.pr || null,
         d.always ? 1 : 0, d.pick, "pang", `https://www.instagram.com/${d.h}`, d.f ?? TODAY, TODAY,
         d.gone ? `${TODAY} 10:22` : null);
}

// ---------- 모집단 생성 ----------
// 세 소스 합집합 추정치(약 1,700~2,000명) 규모를 맞춘다.
const CATS = [
  { cat: "리빙", w: 26, shares: [["리빙", 55], ["주방·청소", 20], ["생활/장보기", 15], ["가전", 10]] },
  { cat: "육아/키즈", w: 22, shares: [["육아/키즈", 62], ["생활/장보기", 18], ["식품", 12], ["리빙", 8]] },
  { cat: "식품", w: 14, shares: [["식품", 58], ["건강", 24], ["생활/장보기", 18]] },
  { cat: "뷰티", w: 12, shares: [["뷰티", 66], ["패션", 20], ["건강", 14]] },
  { cat: "패션", w: 8, shares: [["패션", 63], ["뷰티", 22], ["리빙", 15]] },
  { cat: "인테리어", w: 7, shares: [["인테리어", 61], ["리빙", 28], ["생활/장보기", 11]] },
  { cat: "건강", w: 5, shares: [["건강", 64], ["식품", 26], ["뷰티", 10]] },
  { cat: "여행/숙소", w: 3, shares: [["여행/숙소", 70], ["키즈/체험", 18], ["식품", 12]] },
  { cat: "반려동물", w: 3, shares: [["반려동물", 72], ["리빙", 16], ["생활/장보기", 12]] },
];
const catPool = CATS.flatMap((c) => Array(c.w).fill(c));

const A = ["mom", "daily", "living", "cozy", "haru", "sora", "mint", "olive", "namu", "bom", "hue", "sol", "jane", "moa", "rumi", "toy", "kids", "table", "salt", "pang", "onul", "yeon", "hana", "ruda", "gaon", "nari", "seol", "danbi", "miso", "rok"];
const B = ["home", "log", "diary", "life", "room", "table", "kitchen", "store", "market", "note", "days", "story", "pick", "shop", "mom", "living", "style", "care", "food", "trip"];
const C = ["", "_k", "_official", ".kr", "_daily", "01", "_2", ".log", "_shop", "_mom", "_room", "_e", "88", "_v"];
const NK1 = ["소소한", "슬기로운", "달콤한", "포근한", "정갈한", "하루", "봄날", "초록", "따뜻한", "심플", "느린", "단정한", "맑은", "고운"];
const NK2 = ["하루", "살림", "주방", "육아", "일상", "테이블", "집", "기록", "마켓", "라이프", "다이어리", "노트", "홈", "키친"];

const TARGET = 1742;
const used = new Set(Object.keys(accountByHandle).map(norm));
const generated = [];

for (let i = 0; used.size < TARGET; i++) {
  const handle = `${pickOf(A)}${rnd() < 0.55 ? "_" : rnd() < 0.5 ? "." : ""}${pickOf(B)}${pickOf(C)}`;
  if (used.has(norm(handle)) || !norm(handle)) continue;
  used.add(norm(handle));

  const c = pickOf(catPool);
  // 팔로워는 로그 정규에 가깝게. 대부분 마이크로, 소수 메가.
  const r = rnd();
  const followers = r < 0.42 ? intBetween(3000, 9900)
    : r < 0.86 ? intBetween(10000, 99000)
    : r < 0.97 ? intBetween(100000, 299000)
    : intBetween(300000, 820000);
  const tier = followers < 10000 ? "nano" : followers < 100000 ? "micro" : followers < 300000 ? "mid" : "mega";
  const cad = intBetween(7, 26);
  const last = intBetween(0, Math.round(cad * 2.6));
  const d30 = Math.max(0, Math.round(30 / cad) + intBetween(-1, 1));
  const sources = ["맘", "팡", "인"].filter(() => rnd() < 0.62);
  if (!sources.length) sources.push(pickOf(["맘", "팡", "인"]));

  const { creatorId, accountId } = insertCreator({
    name: `${pickOf(NK1)}${pickOf(NK2)}`,
    tier, category: c.cat, region: pickOf(["서울", "경기", "인천", "부산", "대구", "광주", "대전", "제주", "강원", "충북"]),
    curated: rnd() < 0.18 ? 1 : 0,
    handle, followers, following: intBetween(180, 2400), posts: intBetween(120, 4200),
    sources, lastActive: `${daysBefore(TODAY, intBetween(0, 9))} ${String(intBetween(6, 22)).padStart(2, "0")}:00`,
  });

  // 카테고리 점유율에 개체별 흔들림을 준다.
  let rest = 100;
  const shares = c.shares.map(([k, v], idx) => {
    const val = idx === c.shares.length - 1 ? rest : Math.max(2, Math.min(rest - (c.shares.length - idx - 1) * 2, v + intBetween(-8, 8)));
    rest -= val;
    return [k, val];
  });
  for (const [cat, pct] of shares) {
    P("cs", `INSERT INTO category_share (creator_id,category,pct) VALUES (?,?,?)`).run(creatorId, cat, pct);
  }
  P("cm", `INSERT INTO creator_metric (creator_id,deals_30d,deals_90d,avg_cadence_days,last_deal_on,source,computed_at) VALUES (?,?,?,?,?,?,?)`)
    .run(creatorId, d30, d30 * 3, cad, daysBefore(TODAY, last), "ingong", TODAY);

  // 연락 경로 — 약 62%가 이메일, 20%가 인포크, 나머지는 DM 만.
  const rr = rnd();
  if (rr < 0.62) {
    const dom = pickOf(["gmail.com", "naver.com", "daum.net", "kakao.com"]);
    P("cp", `INSERT INTO contact_point (creator_id,kind,value,source_desc,collected_at,collected_by,consent,note) VALUES (?,?,?,?,?,?,?,?)`)
      .run(creatorId, "email", `${norm(handle).slice(0, 6)}***@${dom}`, `공개 bio (instagram.com/${handle})`,
           daysBefore(TODAY, intBetween(10, 120)), "jay", "implied_public", "bio 이메일 표기");
  } else if (rr < 0.82) {
    P("cp", `INSERT INTO contact_point (creator_id,kind,value,source_desc,collected_at,collected_by,consent,note) VALUES (?,?,?,?,?,?,?,?)`)
      .run(creatorId, "inpock", `inpock.link/${handle}`, "공개 프로필 링크페이지", daysBefore(TODAY, intBetween(10, 120)), "jay", "implied_public", null);
  } else if (rr < 0.93) {
    P("cp", `INSERT INTO contact_point (creator_id,kind,value,source_desc,collected_at,collected_by,consent,note) VALUES (?,?,?,?,?,?,?,?)`)
      .run(creatorId, "ig_dm", `@${handle}`, "공개 프로필", daysBefore(TODAY, intBetween(10, 120)), "jay", "implied_public", "DM 문의만 표기");
  }

  generated.push({ creatorId, accountId, handle, cat: c.cat, cad, last });
}

// 생성된 셀러에게도 공구 이력을 붙인다. 브랜드 충돌 검사가 실제로 작동해야 한다.
const PRODUCT = {
  리빙: ["극세사 러그", "스텐 밀폐용기", "수납 정리함", "원목 협탁", "다용도 선반"],
  "육아/키즈": ["아기 물티슈", "유아 간식 세트", "원목 책상", "아기 욕조", "이유식 용기"],
  식품: ["저당 현미밥", "저염 반찬", "냉동 만두", "유기농 이유식", "국산 견과"],
  뷰티: ["수분 앰플", "리페어 크림", "클렌징 폼", "선쿠션", "헤어 에센스"],
  패션: ["극세사 홈웨어", "니트 가디건", "기모 레깅스", "코튼 파자마"],
  인테리어: ["워시드 린넨 커튼", "차렵이불 세트", "발매트", "무드등"],
  건강: ["홍삼 스틱", "유산균", "루테인", "단백질 쉐이크"],
  "여행/숙소": ["풀빌라 특가", "글램핑 패키지", "호텔 2인 패키지"],
  반려동물: ["자동급수기", "원목 캣타워", "펫 방석", "간식 세트"],
};
const brandNames = BRANDS.map((b) => b.name);

for (const g of generated) {
  const n = intBetween(1, 5);
  for (let k = 0; k < n; k++) {
    const startAgo = g.last + k * (g.cad + intBetween(-2, 4)) - intBetween(0, 6);
    const from = daysBefore(TODAY, Math.max(-24, startAgo));
    const to = daysBefore(TODAY, Math.max(-30, startAgo - intBetween(4, 7)));
    const useBrand = rnd() < 0.55;
    const bn = useBrand ? pickOf(brandNames) : null;
    P("dealGen", `INSERT INTO deal (brand_id,account_id,product_name,category,starts_on,ends_on,price,is_always_on,picked,source,source_url,first_seen_at,last_seen_at)
               VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?)`)
      .run(bn ? brandId[bn] : null, g.accountId,
           `${bn ? bn + " " : ""}${pickOf(PRODUCT[g.cat] ?? PRODUCT["리빙"])}`,
           g.cat, from, to, intBetween(9, 220) * 1000, rnd() < 0.04 ? 1 : 0,
           "pang", `https://www.instagram.com/${g.handle}`, from, TODAY);
  }
}

// ---------- 캠페인 ----------
const campaignId = {};
for (const c of CAMPAIGNS) {
  const r = P("camp", `INSERT INTO campaign (name,brand_id,category,starts_on,ends_on,commission_pct,status,reply_token) VALUES (?,?,?,?,?,?,?,?)`)
    .run(c.name, brandId[c.brand], c.category, c.from, c.to, c.commission, "active", c.token);
  campaignId[c.name] = Number(r.lastInsertRowid);
}

const STAGE_OF = { contacted: "contacted", replied: "replied", negotiating: "negotiating", confirmed: "confirmed", running: "running", dropped: "dropped" };
for (const c of CREATORS) {
  if (!c.st) continue;
  const camp = c.h === "jinny_kitchen" ? "주방 리빙 3차" : c.h === "babyroom_diary" ? "키즈 시즌오프" : "가을 홈웨어 공구";
  P("ct", `INSERT OR IGNORE INTO campaign_target (campaign_id,creator_id,stage,gmv,step,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(campaignId[camp], creatorByHandle[c.h], STAGE_OF[c.st], c.st === "confirmed" ? 1240000 : c.st === "running" ? 820000 : 0,
         c.st === "contacted" ? 2 : 1, TODAY);
}

// 모집단 일부를 가을 홈웨어 캠페인 파이프라인에 올린다.
const homewear = campaignId["가을 홈웨어 공구"];
const pipeline = generated.filter((g) => g.cat === "리빙" || g.cat === "인테리어" || g.cat === "육아/키즈").slice(0, 320);
pipeline.forEach((g, i) => {
  const stage = i < 12 ? "confirmed" : i < 20 ? "running" : i < 48 ? "negotiating" : i < 96 ? "replied" : i < 130 ? "dropped" : "contacted";
  P("ct", `INSERT OR IGNORE INTO campaign_target (campaign_id,creator_id,stage,gmv,step,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(homewear, g.creatorId, stage,
         stage === "confirmed" ? intBetween(400, 2200) * 1000 : stage === "running" ? intBetween(200, 1600) * 1000 : 0,
         intBetween(1, 4), TODAY);
  // 발송 기록은 4스텝 시퀀스다. 회신이 오면 그 지점에서 멈춘다.
  // 회신율은 "회신 / 발송 건" 이므로 스텝을 제대로 쌓아야 실제 값이 나온다.
  const replied = !["contacted", "dropped"].includes(stage);
  const steps = replied ? intBetween(1, 2) : 4;
  const first = intBetween(4, 22);
  for (let k = 0; k < steps; k++) {
    P("log", `INSERT INTO outreach_log (creator_id,campaign_id,channel,sent_at,result) VALUES (?,?,?,?,?)`)
      .run(g.creatorId, homewear, "email", `${daysBefore(TODAY, Math.max(0, first - k * 4))} 10:00`,
           replied && k === steps - 1 ? "replied" : "no_reply");
  }
});

// 지난 캠페인 흔적 — 쿨다운에 걸리는 대상을 만든다.
generated.slice(400, 640).forEach((g) => {
  const ch = rnd() < 0.75 ? "email" : "ig_dm";
  const base = intBetween(5, 85);
  const steps = ch === "email" ? intBetween(2, 4) : 1;
  for (let k = 0; k < steps; k++) {
    P("log", `INSERT INTO outreach_log (creator_id,campaign_id,channel,sent_at,result) VALUES (?,?,?,?,?)`)
      .run(g.creatorId, null, ch, `${daysBefore(TODAY, Math.max(0, base - k * 4))} 11:00`,
           rnd() < 0.05 && k === steps - 1 ? "replied" : "no_reply");
  }
});

// 모집단 일부는 수신거부 상태 — 게이트가 실제로 걷어낸다.
generated.slice(700, 726).forEach((g) => {
  P("sup", `INSERT OR IGNORE INTO suppression (identifier,kind,reason,scope,created_at) VALUES (?,?,?,?,?)`)
    .run(`@${g.handle}`, "handle", rnd() < 0.5 ? "수신거부" : "연락 금지 요청", "all", daysBefore(TODAY, intBetween(3, 90)));
});

// ---------- 스레드 / 메시지 ----------
for (const t of THREADS) {
  const cid = creatorByHandle[t.who];
  const camp = campaignId[t.camp];
  const token = CAMPAIGNS.find((c) => c.name === t.camp)?.token ?? "0000";
  const r = P("th", `INSERT INTO thread (thread_key,campaign_id,creator_id,reply_to,classification,assignee,sequence_state,last_at,sla_due_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(t.key, camp, cid, `partner+cm_${token}.${norm(t.who)}@dinostudio.kr`, t.cls, t.assignee,
         t.msgs.some((m) => m.d === "in") ? "stopped_by_reply" : "running", t.last, t.sla);
  const tid = Number(r.lastInsertRowid);
  for (const m of t.msgs) {
    P("msg", `INSERT INTO message (thread_id,direction,sender,body,sent_at) VALUES (?,?,?,?,?)`).run(tid, m.d, m.w, m.b, m.t);
  }
}

// ---------- 작업 큐 ----------
const senderId = {};
for (const s of db.prepare("SELECT id, identifier FROM sender_account").all()) senderId[s.identifier] = s.id;
for (const t of TASKS) {
  P("task", `INSERT INTO task (kind,creator_id,campaign_id,sender_id,body,scheduled_at,status) VALUES (?,?,?,?,?,?, 'pending')`)
    .run(t.kind, creatorByHandle[t.who], campaignId[t.camp], t.sender ? senderId[t.sender] : null, t.body, t.at);
}
// 인포크·DM 대상이 더 있다. 큐는 17건이다.
const queueExtra = generated.filter((g) => g.cat === "리빙" || g.cat === "육아/키즈").slice(600, 612);
queueExtra.forEach((g, i) => {
  const kind = i % 2 === 0 ? "ig_dm" : "inpock";
  P("task", `INSERT INTO task (kind,creator_id,campaign_id,sender_id,body,scheduled_at,status) VALUES (?,?,?,?,?,?, 'pending')`)
    .run(kind, g.creatorId, homewear, kind === "ig_dm" ? senderId["@dino_partner"] : null,
         kind === "ig_dm"
           ? "안녕하세요! 공구 꾸준히 보고 있었습니다. 9월 중순 라누보 홈웨어 공구 함께 하실 수 있을지 여쭙습니다. 수수료 18%, 샘플 무상 제공입니다."
           : "제안 유형: 공동구매 / 기간: 09-15~09-28 / 카테고리: 홈리빙 / 제안가: 수수료 18% / 정산: 종료 후 10일 이내",
         `${TODAY} ${String(12 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);
});

// ---------- 임포트 이력 / 검토 큐 ----------
let pendingBatch = null;
for (const h of IMPORT_HISTORY) {
  const r = P("ib", `INSERT INTO import_batch (source,filename,rows,created,updated,review,errors,uploaded_by,status,created_at,applied_at) VALUES (?,?,?,?,?,?,?, 'jay', ?,?,?)`)
    .run(h.source, h.file, h.rows, h.created, h.updated, h.review, h.errors, h.status, h.at, h.status === "applied" ? h.at : null);
  if (h.status === "analyzed") pendingBatch = Number(r.lastInsertRowid);
}
if (pendingBatch) {
  for (const r of REVIEW_ROWS) {
    const match = db.prepare("SELECT id FROM social_account WHERE handle_norm = ?").get(norm(r.match));
    P("ir", `INSERT INTO import_row (batch_id,line_no,raw,handle_norm,verdict,score,reason,match_id) VALUES (?,?,?,?, 'review', ?,?,?)`)
      .run(pendingBatch, r.line, JSON.stringify({ handle: r.handle, match: r.match }), norm(r.handle), r.score, r.reason, match?.id ?? null);
  }
}

// ---------- 변화 감지 이벤트 ----------
for (const e of EVENTS) {
  P("ev", `INSERT INTO delta_event (batch_id,kind,title,subject,detail,handle,created_at,seen) VALUES (?,?,?,?,?,?,?,0)`)
    .run(pendingBatch, e.k, e.t, e.s, e.d, e.h, `${TODAY} 10:22`);
}

db.exec("COMMIT");

const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log(`[init-db] ${dbPath}`);
console.log(`  creator ${n("creator")} · account ${n("social_account")} · deal ${n("deal")} · brand ${n("brand")}`);
console.log(`  campaign ${n("campaign")} · target ${n("campaign_target")} · thread ${n("thread")} · task ${n("task")}`);
console.log(`  suppression ${n("suppression")} · outreach_log ${n("outreach_log")} · delta_event ${n("delta_event")}`);
