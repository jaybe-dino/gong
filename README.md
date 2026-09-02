# 아웃리치 콘솔

공구 인플루언서 **발굴 → 컨택 → 협의 → 정산**을 한 곳에서 돌리는 내부 웹 콘솔.

정적 목업이 아니다. 화면의 모든 수치는 요청 시점에 Postgres 를 훑어 계산하고,
버튼은 실제로 DB 를 바꾼다. 배경은 흰색으로 고정하고 다크 모드는 두지 않는다.

- **Next.js App Router** — 12개 화면 전부 서버 컴포넌트. 필터·정렬·페이지·드로어는 URL 상태이고,
  변경 동작은 폼 + 서버 액션이다. 새로고침해도 상태가 유지되고 링크로 공유된다.
- **PostgreSQL** — `db/001_schema.sql` 한 파일에 34개 테이블. 이 파일 하나로 설계가 다 읽힌다.
- **워커** — 시퀀스 배급 · 수신 동기화 · 변화 감지 · 서킷브레이커. Gmail 미설정이면 dry-run.
- **테스트 84개** — 로직 41 · 통합 31(실제 Postgres) · E2E 12(Playwright).

## 실행

```bash
npm install
cp .env.example .env          # DATABASE_URL 만 맞추면 된다

npm run db:setup              # 스키마 + 정책 시드
npm run db:seed               # 데모 데이터 (크리에이터 1,742 · 딜 5,258)
npm run dev                   # http://localhost:3000
```

| 명령 | 하는 일 |
| --- | --- |
| `npm run db:setup` | `db/001_schema.sql` + `002_seed_policy.sql` 적용 |
| `npm run db:seed` | 데모 데이터. `--force` 로 재생성 |
| `npm run db:reset` | 스키마부터 전부 다시 |
| `npm test` | 로직 + 통합 (Postgres 필요) |
| `npm run test:e2e` | 브라우저 E2E (Playwright) |
| `npm run worker` | 워커 루프 (시퀀스 · 수신 · 브레이커) |
| `npm run worker:once` | 한 번만 돌린다. 크론에서 쓴다 |
| `npm run typecheck` | `tsc --noEmit` |

## 화면

| 경로 | 화면 | 핵심 동작 |
| --- | --- | --- |
| `/plan` | 설계 개요 | 메일링 · 데이터 유입 · 매칭 세 축 |
| `/dashboard` | 대시보드 | 오늘 처리할 큐, 파이프라인 퍼널, 발신 계정 건강도, 서킷브레이커 |
| `/feed` | 공구 캘린더 | 날짜별 진행·예정·마감. 리스트 / 캘린더 뷰, 셀러 인스타 링크백 |
| `/watch` | 변화 감지 | 스냅샷 간 델타 9종, 워치리스트 |
| `/influencers` | 인플루언서 DB | 통합 필터 · 적합도/타이밍 정렬 · 통합 프로필 드로어 |
| `/deals` | 딜 · 브랜드 탐색 | 브랜드별 공구 이력, 캠페인 대상 브랜드 충돌 검사 |
| `/import` | 데이터 임포트 | CSV → 컬럼 매핑 → 중복 검사(dry-run) → 커밋 |
| `/campaigns` | 캠페인 | 타깃 추천, 스테이지 칸반, GMV |
| `/send` | 제안 발송 | 대상 산출 → 문안 → 8단계 정책 게이트 → 발송 |
| `/queue` | 작업 큐 | DM · 인포크 수동 발송 배급, 계정 상한, 액션 블록 신고 |
| `/inbox` | 통합 인박스 | 회사 메일 한 개의 스레드, 회신 분류 + 부수효과 |
| `/policy` | 채널 정책 | 채널별 정책, 발신 계정, 수신거부, 발송 차단 기록, 수집 출처 조회 |
| `/u/{token}` | 원클릭 수신거부 | 모든 발송 메일의 List-Unsubscribe 목적지 (RFC 8058) |

## 설계에서 지킨 것

### 1. 상태는 3축으로 분리한다

한 컬럼에 "발송됨"과 "협의 중"과 "수신거부"를 같이 넣으면 반드시 망가진다.

| 축 | 컬럼 | 누가 쓰나 |
| --- | --- | --- |
| 엔진 | `campaign_member.engine_state` | 워커만. 부호로 인코딩 (양수=진행, 음수=종결) |
| 파이프라인 | `campaign_member.stage_id` | 사람이 읽는 축. `pipeline_stage` 11단계 |
| 회신 의미 | `campaign_member.interest_status` | 회신 분류 10종 |

부호 규칙 덕분에 살아 있는 발송 대상이 인덱스 하나로 나온다:
`CREATE INDEX ON campaign_member (next_action_at) WHERE engine_state > 0`.

**자동화는 절대 크리에이터를 뒤로 옮기지 않는다.** 스테이지 역행은 사람만 할 수 있고,
사유가 없으면 거부한다. 이 규칙이 없으면 늦게 도착한 웹훅 하나가 협의 중인 건을 되돌린다.

### 2. 메일링 — 주소는 하나, 매핑은 자동

발송·수신 모두 `partner@dinostudio.kr` 하나다. 담당자별 주소를 만들지 않는다.

```
From:     지은 (Dinostudio) <partner@dinostudio.kr>
Reply-To: partner+cm_8f21a3b2@dinostudio.kr      ← 이게 열쇠
```

회신이 오면 `cm_8f21a3b2` 로 어느 캠페인의 어느 크리에이터인지 즉시 알 수 있다.
매핑 순서는 ① 플러스 주소 토큰 ② Gmail `threadId` ③ 발신자 이메일.

**부재중 자동응답은 답장이 아니다.** 수신 동기화가 헤더와 본문으로 자동응답을 가려내고,
시퀀스를 끝내는 대신 `PAUSED_OOO` 로 두고 본문에서 복귀일을 뽑아 그날 09시로 재스케줄한다.
답장으로 세면 회신율이 부풀고 살아 있는 대상이 조용히 죽는다.

**수신거부는 실제로 눌리는 링크여야 한다.** 모든 발송 메일의 `List-Unsubscribe` 가
`/u/{reply_token}` 을 가리킨다. `POST` 는 RFC 8058 원클릭으로 즉시 처리하고, `GET` 은
확인 버튼만 보여준다 — 메일 스캐너가 링크를 미리 열어보는 것만으로 해지되면 안 되기 때문이다.
처리되면 `creator_id` · 핸들 · 이메일을 모두 등재하고, 진행 중 시퀀스와 배급된 작업까지 회수한다.

### 3. 데이터 유입 — 원문은 저장하지 않는다

세 소스(맘캘린더 · 공구팡팡 · 인공) 모두 약관에서 자동 수집을 금지한다. 그래서 크롤러가 없고
CSV 업로드 경로만 있다. 저장하는 것은 파생 지표와 링크백뿐이다.

- 공통 자연키는 인스타 핸들 하나뿐. 결정론 매칭 순서는
  ① `platform_user_id` ② 정규화 핸들 ③ 구분자 제거 비교 키 ④ 퍼지 점수
- **맘캘 슬러그를 매칭 키로 쓰면 안 된다.** `de-elisa-shop` 은 `.` 과 `_` 를 모두 `-` 로
  치환한 결과라 역변환이 불가능하다. 임포터는 슬러그만 있는 행을 **저장하지 않고 오류로 넘긴다**
- 소스 PK 가 같은데 핸들이 다르면 **핸들 변경**으로 보고 검토 큐에 올린 뒤 `handle_alias` 에 이력을 남긴다
- 팔로워는 덮어쓰지 않고 `account_snapshot` 으로 쌓는다. `"10.8만"` 은 108,000 + 정밀도 ±500
- 겹치는 필드는 **소스별 우선순위**로 판정한다 — 팔로워는 공구팡팡, 케이던스는 인공, 브랜드는 맘캘린더

중복 판정: `≥0.95` 자동 병합 / `0.80~0.95` 검토 큐 / 미만 신규.
업로드는 항상 dry-run 이고, 사람이 검토 큐를 처리한 뒤에야 커밋된다.

### 4. 적합도 — 팔로워는 점수 축이 아니라 분류 축

```
공구 실적    40   최근 30일 건수. 마지막 공구 120일 초과면 50% 감쇠
참여 품질    25   ER 백분위 × credibility. 진성 50% 미만이면 0으로 클램프
카테고리     20   완전일치 20 / 인접 12 / 무관 0
도달 가능성  15   이메일 검증 15 / 인포크 10 / DM만 5
────────────────
경쟁 브랜드 30일 이내 → 제외 · 60일 −15 · 90일 −5
진행·예정 3건 이상 → −8
```

**타이밍이 이 시스템의 차별점이다.** 평균 공구 간격 대비 마지막 공구 경과일이
0.8~2.2배 구간이면 "지금이 적기"다. 2.2배를 넘으면 휴면으로 본다.

### 5. 컴플라이언스는 코드가 아니라 데이터가 통제한다

`channel_policy` 테이블이 채널별 `allows_cold` / `automation_mode` / `night_block` /
`requires_ad_label` / `cooldown_days` 를 들고 있고, 발송은 이 값을 읽지 않으면 아무것도 못 보낸다.

정책 게이트 8단계 (`src/lib/policy-gate.ts`) — 하나라도 실패하면 `gate_block` 에 사유를 남긴다:

| # | 검사 | 근거 |
| --- | --- | --- |
| 0 | 서킷브레이커 | 스팸률 0.30% 초과 시 전면 중단 |
| 1 | suppression 조회 | 정보통신망법 §50② · **조회 실패해도 차단**(fail-closed) |
| 2 | 동의 상태 | `allows_cold=false` 채널은 `opt_in` 만 자동 발송 |
| 3 | 채널 실행 방식 | `manual_task` 는 자동 발송기가 건드리지 못함 |
| 4 | 야간 차단 | §50③ 21–08시 KST. **이메일은 대상 아님** |
| 5 | 발신 계정 상한 | 램프업 중인 계정은 `current_cap` 적용 |
| 6 | 재접촉 쿨다운 | 이메일 90일 / DM·인포크 120일 |
| 7 | (광고) 표기 | §50④ · "광/고", "AD" 변칙은 렌더러가 거부 |
| 8 | 수신거부 수단 | RFC 8058 One-Click 헤더 |

스키마가 강제하는 것들:

- `suppression.unsub_is_permanent` — 수신거부에 만료일을 넣을 수 없다
- `contact_point.source_type / source_url / collected_by` NOT NULL — **수집 출처를 진술할 수 없는
  연락처는 저장 자체가 안 된다.** 소급이 불가능한 유일한 데이터라 스키마로 막는다
- `deal.always_on_has_no_close` — 상시 공구에 마감일을 넣을 수 없다

### 6. 워커 — engine_state 를 실제로 움직이는 것

상태 3축은 워커가 있어야 의미가 생긴다. `scripts/run-worker.mjs` 가 네 가지를 돌린다.

| 잡 | 하는 일 |
| --- | --- |
| `sequence-worker` | 만기된 살아 있는 멤버를 꺼내 렌더 → 게이트 → 발송/작업 큐 → 다음 스텝 예약 |
| `inbound-sync` | 회신을 캠페인에 매핑하고 시퀀스를 중단. 부재중은 재스케줄 |
| `circuit-breaker` | 최근 7일 지표 재계산, 임계 초과 시 계정 정지·볼륨 감축 |
| `detect-changes` | 임포트 커밋 후 델타 8종을 뽑고 브랜드 충돌은 타깃에서 자동 제외 |

시퀀스 워커가 지키는 것들:

- **채널 폴백** — 이메일이 없으면 버리지 않고 인포크 → DM 순으로 작업 큐에 분기한다
- **게이트 실패의 종류를 구분한다** — `suppression`·`consent` 는 종결(되돌릴 일이 없다),
  상한·야간 같은 일시적 실패는 한 시간 뒤 재시도
- **다음 스텝은 업무시간 안으로** — `nextBusinessSlot()` + 최대 3분 지터
- **스테이지는 앞으로만** — `GREATEST(stage_id, ...)`. 자동화는 되돌리지 않는다
- **폴로업 제목은 첫 메일에서 Re: 로 물려받는다** — 스레딩이 유지되고, 물려받을 게 없으면
  캠페인으로 짓는다 (제목 없는 메일은 스팸으로 걸린다)

Vercel 에는 상주 프로세스가 없다. `npm run worker:once` 를 Cron 에 걸어 쓴다.

### 7. 인스타 콜드 DM 자동화는 만들 수 없다

Instagram Messaging API 는 사용자가 먼저 메시지를 보낸 뒤에야 24시간 창이 열린다.
임의의 핸들에 첫 DM 을 보내는 엔드포인트가 존재하지 않는다. 그래서 IG DM · 인포크 채널은
`automation_mode='manual_task'` 로 두고 `outreach_task` 를 만든다.
시스템은 대상 선별 · 문안 생성 · 상한 강제 · 기록만 한다.

## 구조

```
db/
  001_schema.sql        34개 테이블. 이 파일 하나로 설계가 다 읽힌다.
  002_seed_policy.sql   채널 정책 · 서킷브레이커 · 스테이지 · 템플릿 · 시퀀스
src/
  app/u/[token]/        원클릭 수신거부 (GET 확인 · POST 처리)
  lib/
    db.ts               pg 풀. 서버리스용으로 작게 잡고 전역 재사용
    channels/gmail.ts   발송·수신. Reply-To 플러스 주소로 스레드 매핑. 미설정이면 dry-run
    channels/index.ts   채널 레지스트리 (auto vs manual_task)
    jobs/               sequence-worker · inbound-sync · detect-changes · circuit-breaker · notify
    states.ts           엔진 / 스테이지 / 회신 의미 3축
    policy-gate.ts      ★ 발송 전 8단계. 모든 발송이 여기를 지난다
    score.ts            적합도 100점 + 타이밍
    dedupe.ts           매칭 점수 + 필드 서바이버십
    handle.ts           핸들 정규화 · 맘캘 슬러그 함정
    parse.ts            "10.8만", "30일 35건", "약 1시간 전", 부재중 판별
    template.ts         spintax + (광고) 표기 + 수신거부 자동 주입
    importer.ts         CSV → 정규화 → 매칭 → dry-run → 커밋 → 델타
    outreach.ts         대상 산출 + 게이트 평가 (미리보기와 실행이 같은 코드)
    queries.ts          화면 조회 계층
    actions.ts          서버 액션
  app/                  12개 화면
scripts/                setup-db.mjs · seed.mjs · seed-data.mjs · run-worker.mjs
tests/                  logic(41) · pipeline(31) · e2e(12)
samples/                소스별 CSV 예시
```

### 성능

적합도 정렬은 모집단 전체(1,742명)를 훑어야 한다. 크리에이터마다 쿼리를 돌리면 첫 렌더가 수 초
걸린다. `loadCreators()` 가 LATERAL 조인으로 **한 번의 조회**에 필요한 필드를 다 끌어오고 점수는
메모리에서 계산한다 — 전체 214ms, 페이지 렌더 45~265ms.

## Vercel 배포

1. Vercel 프로젝트에 이 저장소를 연결한다
2. Storage 에서 Postgres(Neon)를 만들고 `DATABASE_URL` 을 프로젝트 환경변수에 넣는다
   — 서버리스이므로 **풀러(-pooler) 엔드포인트**를 쓴다
3. 한 번만 스키마와 시드를 넣는다:
   ```bash
   DATABASE_URL='<프로덕션 URL>' npm run db:setup
   DATABASE_URL='<프로덕션 URL>' npm run db:seed
   ```
4. 배포. 모든 화면이 `force-dynamic` 이라 빌드 단계에는 DB 가 필요 없다

`MAIL_*` 와 `UNSUB_BASE_URL` 도 환경변수로 넣으면 문안 렌더러가 그 값을 쓴다.
**`UNSUB_BASE_URL` 은 배포된 도메인의 `/u` 로 맞춰야 한다** — 이 값이 모든 발송 메일의
List-Unsubscribe 목적지가 된다.

워커는 상주 프로세스가 필요하므로 Vercel Cron 으로 돌린다. `vercel.json` 에:

```json
{ "crons": [{ "path": "/api/cron/worker", "schedule": "*/10 * * * *" }] }
```

또는 별도 호스트에서 `npm run worker` 를 띄운다.

## 알아두실 것

- **Gmail 은 어댑터까지 붙어 있고 기본은 dry-run 이다.** `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` 을 넣으면 실제로 나간다. 비워두면 콘솔에
  찍히고 가짜 ID 를 돌려준다 — 먼저 이 상태로 돌려보는 것을 권한다.
  필요 스코프는 `gmail.send`, `gmail.readonly`, `gmail.modify` 이고,
  수신 실시간 반영이 필요하면 Pub/Sub 토픽을 만들어 `watch` 를 걸면 된다 (없으면 2분 폴링)
- `googleapis` 는 **선택 의존성**이다. 설치하지 않아도 빌드와 dry-run 이 된다
- 샘플 데이터의 핸들·브랜드는 **가상 값**이다. 실제 계정이 아니다
- 콜드 아웃리치는 메인 도메인으로 하지 않는다. 별도 발송 도메인에 SPF + DKIM + DMARC 를 걸고,
  3주 워밍업 후 메일박스당 50~75통/일로 운영한다. 총 발송량을 늘리는 방법은 메일박스당 볼륨이
  아니라 **메일박스 개수**다
- B2B 제휴 제안이 정보통신망법상 "영리목적 광고성 정보"에 해당하는지에 대한 공식 유권해석은
  확인되지 않았다. **해당한다고 가정하고 설계했다.** 실제 발송 개시 전 변호사 검토를 권한다
- 이 문서의 법률 조항 인용은 참고용이며 법률자문이 아니다
