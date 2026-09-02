// 프로토타입의 샘플 레코드를 실제 행으로 옮긴 것.
// 12명은 상세 데이터를 손으로 넣었고, 나머지 모집단은 generate.mjs 가 결정론적으로 만든다.

export const TODAY = "2026-09-01";

export const CREATORS = [
  { h: "livingnote_k", n: "리빙노트", f: 62000, fl: 842, p: 1204, d30: 5, cad: 9, last: 10, cat: "리빙",
    sh: [["리빙", 61], ["주방·청소", 22], ["생활/장보기", 11], ["가전", 6]], reach: "email",
    em: "living***@gmail.com", src: ["맘", "팡", "인"], st: "contacted", tier: "micro", curated: 0, region: "서울" },
  { h: "mom_dailylog", n: "소소한하루", f: 108000, fl: 812, p: 699, d30: 6, cad: 11, last: 19, cat: "육아/키즈",
    sh: [["육아/키즈", 52], ["생활/장보기", 24], ["식품", 14], ["리빙", 10]], reach: "email",
    em: "daily***@naver.com", src: ["맘", "팡", "인"], st: "confirmed", tier: "micro", curated: 1, region: "경기" },
  { h: "nara_home", n: "나라홈", f: 34000, fl: 401, p: 512, d30: 4, cad: 13, last: 8, cat: "리빙",
    sh: [["리빙", 74], ["주방·청소", 18], ["생활/장보기", 8]], reach: "inpock",
    em: null, src: ["맘", "인"], st: null, tier: "nano", curated: 1, region: "부산" },
  { h: "jinny_kitchen", n: "지니키친", f: 81000, fl: 923, p: 1876, d30: 7, cad: 8, last: 6, cat: "리빙",
    sh: [["주방·청소", 68], ["식품", 19], ["리빙", 13]], reach: "email",
    em: "jinny***@naver.com", src: ["맘", "팡", "인"], st: "negotiating", tier: "micro", curated: 0, region: "서울" },
  { h: "sooyeon.living", n: "수연리빙", f: 55000, fl: 610, p: 988, d30: 3, cad: 15, last: 12, cat: "리빙",
    sh: [["리빙", 58], ["가전", 21], ["육아/키즈", 21]], reach: "email",
    em: "sooyeon***@gmail.com", src: ["팡", "인"], st: "replied", tier: "micro", curated: 0, region: "인천" },
  { h: "beauty.log_h", n: "뷰티로그", f: 98000, fl: 1204, p: 2210, d30: 5, cad: 12, last: 14, cat: "뷰티",
    sh: [["뷰티", 71], ["건강", 18], ["패션", 11]], reach: "email",
    em: "beauty***@gmail.com", src: ["팡", "인"], st: "running", tier: "micro", curated: 0, region: "서울" },
  { h: "kids_room_j", n: "키즈룸제이", f: 41000, fl: 388, p: 604, d30: 4, cad: 14, last: 16, cat: "육아/키즈",
    sh: [["육아/키즈", 81], ["리빙", 12], ["식품", 7]], reach: "inpock",
    em: null, src: ["맘", "팡"], st: null, tier: "micro", curated: 0, region: "대구" },
  { h: "haru.trip", n: "하루트립", f: 73000, fl: 1502, p: 3104, d30: 2, cad: 21, last: 19, cat: "여행/숙소",
    sh: [["여행/숙소", 64], ["키즈/체험", 22], ["식품", 14]], reach: "email",
    em: "haru***@agency.kr", src: ["인"], st: "replied", tier: "micro", curated: 0, region: "제주" },
  { h: "nutri_mom", n: "뉴트리맘", f: 29000, fl: 299, p: 433, d30: 3, cad: 16, last: 21, cat: "식품",
    sh: [["식품", 66], ["건강", 24], ["육아/키즈", 10]], reach: "email",
    em: "nutri***@daum.net", src: ["맘", "팡"], st: null, tier: "nano", curated: 0, region: "광주" },
  { h: "simple_daily_k", n: "심플데일리", f: 152000, fl: 704, p: 1502, d30: 4, cad: 18, last: 22, cat: "리빙",
    sh: [["리빙", 49], ["생활/장보기", 31], ["가전", 20]], reach: "email",
    em: "simple***@gmail.com", src: ["팡", "인"], st: "contacted", tier: "mid", curated: 0, region: "서울" },
  { h: "babyroom_diary", n: "베이비룸다이어리", f: 47000, fl: 522, p: 812, d30: 2, cad: 22, last: 31, cat: "육아/키즈",
    sh: [["육아/키즈", 88], ["식품", 12]], reach: "blocked",
    em: null, src: ["맘"], st: "dropped", tier: "micro", curated: 0, region: "경기" },
  { h: "pet_and_home", n: "펫앤홈", f: 38000, fl: 455, p: 702, d30: 3, cad: 17, last: 15, cat: "리빙",
    sh: [["반려동물", 57], ["리빙", 28], ["생활/장보기", 15]], reach: "dm",
    em: null, src: ["인"], st: null, tier: "nano", curated: 0, region: "대전" },
];

export const BRANDS = [
  { name: "알텐바흐", category: "리빙", dict: 1 },
  { name: "라누보", category: "인테리어", dict: 1 },
  { name: "마그랩", category: "육아/키즈", dict: 1 },
  { name: "오드리선", category: "뷰티", dict: 1 },
  { name: "무하브", category: "가전", dict: 1 },
  { name: "코지홈", category: "인테리어", dict: 0 },
  { name: "그린테이블", category: "식품", dict: 0 },
  { name: "펫프렌즈", category: "반려동물", dict: 1 },
];

// 공구 딜. 셀러 핸들은 인스타 링크로 연결된다. 원문은 저장하지 않고 링크만 건다.
export const DEALS = [
  { p: "알텐바흐 디펜더스S 3중 냄비 4종", b: "알텐바흐", h: "jinny_kitchen", c: "리빙", f: "2026-09-01", t: "2026-09-07", pr: 89000, pick: 1 },
  { p: "라누보 극세사 차렵이불 세트", b: "라누보", h: "sooyeon.living", c: "인테리어", f: "2026-09-02", t: "2026-09-06", pr: 54900, pick: 0 },
  { p: "마그랩 유기농 이유식 12종", b: "마그랩", h: "mom_dailylog", c: "식품", f: "2026-09-03", t: "2026-09-09", pr: 42000, pick: 1 },
  { p: "오드리선 수분 앰플 2+1 세트", b: "오드리선", h: "beauty.log_h", c: "뷰티", f: "2026-09-04", t: "2026-09-08", pr: 38000, pick: 0 },
  { p: "코지홈 워시드 린넨 커튼", b: "코지홈", h: "livingnote_k", c: "인테리어", f: "2026-09-01", t: "2026-09-05", pr: 31900, pick: 1 },
  { p: "무하브 무선 스틱청소기 2세대", b: "무하브", h: "simple_daily_k", c: "가전", f: "2026-09-01", t: "2026-09-04", pr: 189000, pick: 0 },
  { p: "그린테이블 저당 현미밥 20개입", b: "그린테이블", h: "nutri_mom", c: "식품", f: "2026-08-30", t: "2026-09-01", pr: 27900, pick: 0 },
  { p: "펫프렌즈 자동급수기 3L", b: "펫프렌즈", h: "pet_and_home", c: "반려동물", f: "2026-08-29", t: "2026-09-01", pr: 45000, pick: 0 },
  { p: "키즈룸 원목 책상·의자 세트", b: "코지홈", h: "kids_room_j", c: "육아", f: "2026-09-02", t: "2026-09-08", pr: 158000, pick: 0 },
  { p: "나라홈 원목 협탁 2종", b: "코지홈", h: "nara_home", c: "인테리어", f: "2026-09-05", t: "2026-09-11", pr: 69000, pick: 1 },
  { p: "마그랩 아기 물티슈 대용량 10팩", b: "마그랩", h: "mom_dailylog", c: "육아", f: "2026-09-06", t: "2026-09-12", pr: 23900, pick: 0 },
  { p: "라누보 극세사 러그 3종", b: "라누보", h: "livingnote_k", c: "인테리어", f: "2026-09-08", t: "2026-09-14", pr: 47000, pick: 1 },
  { p: "알텐바흐 인덕션 프라이팬 3종", b: "알텐바흐", h: "jinny_kitchen", c: "리빙", f: "2026-09-09", t: "2026-09-15", pr: 76000, pick: 0 },
  { p: "그린테이블 홍삼 스틱 60포", b: "그린테이블", h: "nutri_mom", c: "건강", f: "2026-09-10", t: "2026-09-16", pr: 59000, pick: 0 },
  { p: "오드리선 리페어 크림 2개입", b: "오드리선", h: "beauty.log_h", c: "뷰티", f: "2026-09-11", t: "2026-09-17", pr: 44000, pick: 0 },
  { p: "무하브 6인용 식기세척기", b: "무하브", h: "simple_daily_k", c: "가전", f: "2026-09-12", t: "2026-09-18", pr: 429000, pick: 0 },
  { p: "라누보 극세사 홈웨어 상하 세트", b: "라누보", h: "nara_home", c: "패션", f: "2026-09-15", t: "2026-09-21", pr: 39900, pick: 1 },
  { p: "코지홈 극세사 발매트 4종", b: "코지홈", h: "sooyeon.living", c: "인테리어", f: "2026-09-15", t: "2026-09-19", pr: 19900, pick: 0 },
  { p: "마그랩 유아 간식 세트 8종", b: "마그랩", h: "kids_room_j", c: "육아", f: "2026-09-16", t: "2026-09-22", pr: 33000, pick: 0 },
  { p: "펫프렌즈 원목 캣타워", b: "펫프렌즈", h: "pet_and_home", c: "반려동물", f: "2026-09-17", t: "2026-09-23", pr: 98000, pick: 0 },
  { p: "알텐바흐 스텐 밀폐용기 12종", b: "알텐바흐", h: "livingnote_k", c: "리빙", f: "2026-09-18", t: "2026-09-24", pr: 52000, pick: 0 },
  { p: "그린테이블 저염 반찬 10종", b: "그린테이블", h: "mom_dailylog", c: "식품", f: "2026-09-20", t: "2026-09-26", pr: 36000, pick: 0 },
  { p: "제주 풀빌라 2박 특가", b: null, h: "haru.trip", c: "여행", f: null, t: null, pr: 0, pick: 0, always: 1 },
  { p: "강원 글램핑 가을 패키지", b: null, h: "haru.trip", c: "여행", f: "2026-09-04", t: "2026-09-30", pr: 159000, pick: 0 },
  { p: "라누보 차렵이불 여름용", b: "라누보", h: "sooyeon.living", c: "인테리어", f: "2026-08-20", t: "2026-08-26", pr: 49900, pick: 0 },
  { p: "라누보 극세사 러그 2종", b: "라누보", h: "livingnote_k", c: "인테리어", f: "2026-08-22", t: "2026-08-28", pr: 44000, pick: 0 },
  { p: "무하브 수납 정리함 6종", b: "무하브", h: "livingnote_k", c: "리빙", f: "2026-08-05", t: "2026-08-11", pr: 29000, pick: 0 },
  { p: "마그랩 아기 물티슈 대용량", b: "마그랩", h: "mom_dailylog", c: "육아", f: "2026-08-13", t: "2026-08-19", pr: 23900, pick: 0 },
  { p: "알텐바흐 스텐 냄비 세트", b: "알텐바흐", h: "nara_home", c: "리빙", f: "2026-07-02", t: "2026-07-08", pr: 81000, pick: 0 },
  { p: "오드리선 수분 앰플", b: "오드리선", h: "mom_dailylog", c: "뷰티", f: "2026-06-30", t: "2026-07-06", pr: 38000, pick: 0 },
  { p: "실리콘 조리도구 8종", b: null, h: "jinny_kitchen", c: "리빙", f: "2026-08-11", t: "2026-08-17", pr: 24000, pick: 0, gone: 1 },
  { p: "유아 원목 책상", b: null, h: "kids_room_j", c: "육아", f: "2026-08-16", t: "2026-08-22", pr: 139000, pick: 0 },
  { p: "펫 자동급수기", b: null, h: "pet_and_home", c: "반려동물", f: "2026-08-18", t: "2026-08-24", pr: 39000, pick: 0 },
  { p: "무하브 무선 청소기", b: "무하브", h: "simple_daily_k", c: "가전", f: "2026-07-28", t: "2026-08-03", pr: 179000, pick: 0 },
];

export const CAMPAIGNS = [
  { name: "가을 홈웨어 공구", brand: "라누보", category: "리빙", from: "2026-09-15", to: "2026-09-28", commission: 18, token: "8f21a" },
  { name: "주방 리빙 3차", brand: "알텐바흐", category: "리빙", from: "2026-09-08", to: "2026-09-21", commission: 15, token: "b3c07" },
  { name: "키즈 시즌오프", brand: "마그랩", category: "육아/키즈", from: "2026-09-22", to: "2026-10-05", commission: 16, token: "d914e" },
  { name: "뷰티 앰플 런칭", brand: "오드리선", category: "뷰티", from: "2026-10-01", to: "2026-10-14", commission: 20, token: "a72f3" },
];

export const SENDERS = [
  { id: "partner@dinostudio.kr", ch: "email", cap: 75, sent: 42, age: 420, ramp: null, status: "ok" },
  { id: "hello@dino-partners.kr", ch: "email", cap: 75, sent: 61, age: 380, ramp: null, status: "ok" },
  { id: "team@dino-partners.kr", ch: "email", cap: 25, sent: 8, age: 9, ramp: 9, status: "ramping" },
  { id: "@dino_partner", ch: "ig_dm", cap: 30, sent: 12, age: 240, ramp: null, status: "ok" },
  { id: "@dino_gonggu", ch: "ig_dm", cap: 30, sent: 0, age: 95, ramp: null, status: "suspended" },
];

export const POLICIES = [
  { ch: "email", cold: 1, exec: "auto", night: null, ad: 1, unsub: 1, cap: 75, cooldown: 90 },
  { ch: "ig_dm", cold: 0, exec: "manual_queue", night: "21-08", ad: 0, unsub: 0, cap: 30, cooldown: 120 },
  { ch: "inpock", cold: 0, exec: "manual_queue", night: "21-08", ad: 0, unsub: 0, cap: null, cooldown: 120 },
  { ch: "linktree", cold: 0, exec: "manual_queue", night: "21-08", ad: 0, unsub: 0, cap: null, cooldown: 120 },
  { ch: "kakao", cold: 0, exec: "auto_after_consent", night: "21-08", ad: 1, unsub: 1, cap: null, cooldown: 30 },
  { ch: "sms", cold: 0, exec: "auto_after_consent", night: "21-08", ad: 1, unsub: 1, cap: null, cooldown: 30 },
];

export const SUPPRESSIONS = [
  { id: "baby***@gmail.com", kind: "email", reason: "연락 금지 요청", scope: "all", at: "2026-08-29" },
  { id: "@babyroom_diary", kind: "handle", reason: "연락 금지 요청", scope: "all", at: "2026-08-29" },
  { id: "@kmarket-agency.kr", kind: "domain", reason: "수신거부", scope: "email", at: "2026-08-21" },
  { id: "jinny***@naver.com", kind: "email", reason: "하드 바운스", scope: "email", at: "2026-08-18" },
];

export const CIRCUITS = [
  { key: "spam", label: "스팸 신고율", value: 0.04, warn: 0.1, stop: 0.3, unit: "%", action: "0.30% 시 전면 중단" },
  { key: "bounce", label: "바운스율", value: 1.9, warn: 3, stop: null, unit: "%", action: "볼륨 50% 감축" },
  { key: "inbox", label: "인박스 도달률", value: 93, warn: 85, stop: null, unit: "%", action: "85% 미만 시 발송 일시 중지" },
  { key: "block", label: "IG 액션 블록", value: 1, warn: 1, stop: null, unit: "건", action: "계정 24시간 정지" },
];

export const WATCHLIST = [
  { type: "brand", target: "라누보", cond: "새 공구 열릴 때", hit: "2026-08-31" },
  { type: "brand", target: "알텐바흐", cond: "새 공구 · 새 셀러", hit: "2026-09-01" },
  { type: "seller", target: "@livingnote_k", cond: "공구 오픈 · 카테고리 이탈", hit: "2026-08-22" },
  { type: "seller", target: "@mom_dailylog", cond: "공구 오픈", hit: "2026-09-01" },
  { type: "keyword", target: "극세사", cond: "제품명 포함", hit: "2026-08-29" },
  { type: "category", target: "홈웨어 · 리빙", cond: "일 5건 이상 급증", hit: "2026-08-30" },
];

export const EVENTS = [
  { k: "new", t: "신규 공구", s: "라누보 극세사 홈웨어 상하 세트", d: "@nara_home · 09-15 오픈 예정 · 워치 브랜드 '라누보' 일치", h: "nara_home" },
  { k: "conflict", t: "경쟁 브랜드 감지", s: "@sooyeon.living 이 라누보 차렵이불 진행중", d: "가을 홈웨어 캠페인 타깃에서 자동 제외됨 · 09-02 ~ 09-06", h: "sooyeon.living" },
  { k: "brand", t: "사전에 없던 브랜드", s: "코지홈", d: "3개 딜에서 등장 · 맘캘린더 브랜드 사전에 없음 · 별칭 등록 필요", h: null },
  { k: "timing", t: "적기 도달", s: "@livingnote_k", d: "평균 간격 9일 · 마지막 공구 10일 전 · 다음 공구 준비 시점", h: "livingnote_k" },
  { k: "gone", t: "사라진 딜", s: "실리콘 조리도구 8종", d: "공구팡팡 원문 410 Gone · 마감 처리 + tombstone 기록", h: "jinny_kitchen" },
  { k: "handle", t: "핸들 변경 추정", s: "@joo0.is.happy ← @hi.iamjoo0", d: "소스 PK 9306 동일 · alias 이력에 추가하고 병합 검토 필요", h: "joo0.is.happy" },
  { k: "price", t: "가격 변경", s: "마그랩 유기농 이유식 12종", d: "46,000 → 42,000원 · 동일 셀러 재진행 3회차", h: "mom_dailylog" },
  { k: "surge", t: "카테고리 급증", s: "인테리어", d: "일 6건 · 지난 4주 평균 2.1건 대비 급증 · 가을 시즌 진입 신호", h: null },
  { k: "dead", t: "계정 비활성", s: "@babyroom_diary", d: "31일간 신규 공구 없음 + 연락 금지 등록 상태 · 재검증 대상", h: "babyroom_diary" },
];

export const THREADS = [
  { key: "gm-t1", interest: 3, who: "mom_dailylog", camp: "가을 홈웨어 공구", cls: "3 일정 확정", assignee: "지은", last: "2026-08-31 15:22", sla: "2026-09-01 15:22",
    msgs: [
      { d: "out", w: "지은 (Dinostudio)", t: "2026-08-28 10:12", b: "안녕하세요 소소한하루님, Dinostudio 파트너십 담당 지은입니다.\n\n마그랩 이유식 공구를 인상 깊게 봤습니다. 9월 15일부터 2주간 진행하는 라누보 극세사 홈웨어 공동구매를 함께 하실 수 있을지 여쭙습니다.\n\n· 수수료 18%\n· 샘플 무상 제공, 소재 일체 제공\n· 정산은 판매 종료 후 10일 이내" },
      { d: "in", w: "소소한하루", t: "2026-08-29 09:41", b: "안녕하세요! 관심 있습니다.\n혹시 수수료는 조정 가능할까요? 그리고 샘플은 언제쯤 받아볼 수 있나요?" },
      { d: "out", w: "지은 (Dinostudio)", t: "2026-08-29 10:05", b: "빠른 회신 감사합니다.\n\n20%까지 조정 가능하고, 샘플은 확정 주시면 2일 내 발송됩니다. 9월 8일까지 받아보실 수 있어요." },
      { d: "in", w: "소소한하루", t: "2026-08-31 15:22", b: "네 좋습니다! 9월 15일 오픈으로 진행할게요.\n주소는 DM으로 보내드릴게요." },
    ] },
  { key: "gm-t2", interest: 2, who: "sooyeon.living", camp: "가을 홈웨어 공구", cls: "2 조건 문의", assignee: "지은", last: "2026-08-31 18:02", sla: "2026-09-01 18:02",
    msgs: [
      { d: "out", w: "지은 (Dinostudio)", t: "2026-08-29 11:30", b: "안녕하세요 수연리빙님, Dinostudio 지은입니다.\n라누보 극세사 홈웨어 공동구매 제안드립니다." },
      { d: "in", w: "수연리빙", t: "2026-08-31 18:02", b: "수수료 조건이랑 정산 주기가 어떻게 되나요?\n그리고 저 이번 달에 라누보 차렵이불 공구가 이미 잡혀 있는데 괜찮을까요?" },
    ] },
  { key: "gm-t3", interest: -1, who: "jinny_kitchen", camp: "주방 리빙 3차", cls: "-1 지금은 아님", assignee: "민수", last: "2026-08-30 10:11", sla: null,
    msgs: [
      { d: "out", w: "민수 (Dinostudio)", t: "2026-08-27 14:00", b: "안녕하세요 지니키친님, 알텐바흐 주방 3차 공구 제안드립니다." },
      { d: "in", w: "지니키친", t: "2026-08-30 10:11", b: "지금 9월은 일정이 꽉 차 있어서 어렵습니다.\n10월 중순 이후에 다시 연락 주시면 좋겠습니다." },
    ] },
  { key: "gm-t4", interest: -3, who: "haru.trip", camp: "가을 홈웨어 공구", cls: "-3 담당자 아님 / 소속사", assignee: "지은", last: "2026-08-30 16:45", sla: null,
    msgs: [
      { d: "out", w: "지은 (Dinostudio)", t: "2026-08-28 09:20", b: "안녕하세요 하루트립님, 협업 제안드립니다." },
      { d: "in", w: "하루트립", t: "2026-08-30 16:45", b: "모든 협업 문의는 소속사로 부탁드립니다.\ncontact@agency-example.kr 로 연락 주세요." },
    ] },
  { key: "gm-t5", interest: -4, who: "babyroom_diary", camp: "키즈 시즌오프", cls: "-4 연락 금지", assignee: "민수", last: "2026-08-29 08:02", sla: null,
    msgs: [
      { d: "out", w: "민수 (Dinostudio)", t: "2026-08-26 13:10", b: "안녕하세요, 키즈 시즌오프 공구 제안드립니다." },
      { d: "in", w: "베이비룸다이어리", t: "2026-08-29 08:02", b: "앞으로 연락 주지 않으셨으면 합니다." },
    ] },
  { key: "gm-t6", interest: 0, who: "simple_daily_k", camp: "가을 홈웨어 공구", cls: null, assignee: null, last: "2026-09-01 06:15", sla: "2026-09-01 18:15",
    msgs: [
      { d: "out", w: "지은 (Dinostudio)", t: "2026-08-30 10:00", b: "안녕하세요 심플데일리님, 라누보 홈웨어 공구 제안드립니다." },
      { d: "in", w: "심플데일리", t: "2026-09-01 06:15", b: "자료 좀 더 볼 수 있을까요? 상세페이지랑 예상 단가요." },
    ] },
];

export const TASKS = [
  { kind: "ig_dm", who: "livingnote_k", camp: "가을 홈웨어 공구", sender: "@dino_partner", at: "2026-09-01 10:40",
    body: "안녕하세요! 리빙 공구 꾸준히 보고 있었습니다. 9월 중순 라누보 홈웨어 공구 함께 하실 수 있을지 여쭙고 싶어 연락드립니다. 수수료 18%, 샘플 무상 제공입니다." },
  { kind: "inpock", who: "nara_home", camp: "가을 홈웨어 공구", sender: null, at: "2026-09-01 10:52",
    body: "제안 유형: 공동구매 / 기간: 09-15~09-28 / 카테고리: 홈리빙 / 제안가: 수수료 18% / 샘플 무상 제공 / 정산: 종료 후 10일 이내" },
  { kind: "reply_check", who: "haru.trip", camp: "가을 홈웨어 공구", sender: "partner@dinostudio.kr", at: "2026-09-01 11:05",
    body: "소속사 담당자 메일 주소를 받았습니다. contact_point 신규 등록이 필요합니다." },
  { kind: "ig_dm", who: "beauty.log_h", camp: "뷰티 앰플 런칭", sender: "@dino_partner", at: "2026-09-01 11:20",
    body: "반갑습니다! 앰플 런칭 공구 관련해 제안드리고 싶어 연락드립니다. 10월 1일부터 2주간, 수수료 20% 조건입니다." },
  { kind: "inpock", who: "kids_room_j", camp: "키즈 시즌오프", sender: null, at: "2026-09-01 11:35",
    body: "제안 유형: 공동구매 / 기간: 09-22~10-05 / 카테고리: 키즈용품 / 제안가: 수수료 16%" },
];

export const IMPORT_HISTORY = [
  { at: "2026-09-01 10:22", source: "pang", file: "09pangpang_influencers_20260901.csv", rows: 1564, created: 218, updated: 1203, review: 37, errors: 106, status: "analyzed" },
  { at: "2026-08-25 09:14", source: "ingong", file: "instagong_metrics_20260825.csv", rows: 510, created: 63, updated: 441, review: 0, errors: 6, status: "applied" },
  { at: "2026-08-18 16:40", source: "momcal", file: "momcalendar_sellers_20260818.csv", rows: 1105, created: 1105, updated: 0, review: 0, errors: 0, status: "applied" },
  { at: "2026-08-18 16:31", source: "momcal", file: "momcalendar_brands_20260818.csv", rows: 3992, created: 3992, updated: 0, review: 0, errors: 0, status: "applied" },
];

// 임포트 검토 큐에 남아 있는 실제 행. 화면에서 병합/분리를 눌러 처리한다.
export const REVIEW_ROWS = [
  { line: 41, handle: "sooyeon.living", match: "sooyeon_living", score: 0.91, reason: "핸들 유사 + 표시명 동일 + 팔로워 오차 2%" },
  { line: 118, handle: "joo0.is.happy", match: "hi.iamjoo0", score: 0.88, reason: "핸들 변경 추정 — 소스 PK 동일(9306)" },
  { line: 355, handle: "haru.trip", match: "haru_trip_official", score: 0.84, reason: "표시명 유사, 팔로워 차 41% — 주의" },
  { line: 602, handle: "livingnote_k", match: "livingnote.k", score: 0.93, reason: "구두점 차이만" },
  { line: 907, handle: "mom_dailylog", match: "momdailylog", score: 0.82, reason: "표시명 불일치 — 동명이인 가능" },
];
