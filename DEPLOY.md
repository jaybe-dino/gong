# 배포 절차 (Vercel)

이 저장소는 GitHub 연동만으로 배포된다. CLI 토큰은 필요 없다.

## 1. Postgres 준비

Vercel 대시보드 → Storage → Create Database → **Neon (Postgres)**.
마켓플레이스 약관 동의는 사람이 직접 눌러야 한다(CLI 불가).

생성 후 연결 문자열 두 개가 나온다. **풀러(`-pooler`) 쪽**을 쓴다.

```
postgres://USER:PASS@ep-xxxx-pooler.REGION.aws.neon.tech/DB?sslmode=require
```

서버리스는 인스턴스가 자주 뜨고 지므로 직결 엔드포인트는 커넥션을 금방 소진한다.

## 2. 프로젝트 임포트

Vercel 대시보드 → Add New → Project → `jaybe-dino/gong` 임포트.

| 항목 | 값 |
|---|---|
| Framework Preset | Next.js (자동 감지) |
| Build Command | `next build` (기본) |
| Install Command | `npm install` (기본) |
| Root Directory | `./` |

빌드는 DB 없이도 통과한다. DB를 읽는 화면은 전부 dynamic 이라 요청 시점에만 접속한다.

## 3. 환경 변수

Settings → Environment Variables. Production 에 넣는다.

| 키 | 값 | 비고 |
|---|---|---|
| `DATABASE_URL` | 1단계의 풀러 문자열 | 필수 |
| `PGPOOL_MAX` | `5` | 인스턴스당 커넥션 |
| `UNSUB_BASE_URL` | `https://<배포도메인>/u` | 첫 배포 후 도메인 확정되면 채운다 |
| `CRON_SECRET` | `openssl rand -hex 32` 결과 | 크론·초기화 엔드포인트 Bearer. **반드시 설정** |
| `MAIL_BASE_ADDRESS` | `partner@dinostudio.kr` | Reply-To 플러스 주소의 기준 |
| `MAIL_ORG_NAME` | `Dinostudio (주)` | 메일 푸터 |
| `MAIL_POSTAL` | 사업장 주소 | 정보통신망법상 필수 |
| `MAIL_PHONE` | 연락처 | 〃 |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | Gmail OAuth | **비우면 dry-run**(콘솔 출력)으로 동작 |
| `SLACK_WEBHOOK_URL` | 내부 알림 | 비우면 콘솔 |

`UNSUB_BASE_URL` 은 발송 메일의 `List-Unsubscribe` 헤더에 그대로 들어간다.
틀리면 수신거부 링크가 죽는다 — 도메인 확정 후 반드시 다시 확인할 것.

## 4. DB 스키마 + 시드

서버리스에는 셸이 없어서 프로덕션에서 `npm run db:setup` 을 돌릴 수 없다.
그래서 앱 자신이 스키마를 적재하는 엔드포인트를 둔다. **로컬 터미널이 필요 없다.**

`CRON_SECRET` 으로 보호되며, 브라우저 주소창으로는 실행되지 않는다(POST 전용).

```bash
S='설정한 CRON_SECRET'
D='https://<배포도메인>'

curl -X POST -H "Authorization: Bearer $S" $D/api/admin/setup
# {"ok":true,"ms":152,"applied":["001_schema.sql","002_seed_policy.sql"],"tables":34}

curl -X POST -H "Authorization: Bearer $S" $D/api/admin/seed
# {"ok":true,"ms":855,"creator":1742,"deal":5258,"campaign_member":342, ...}
```

두 엔드포인트 모두 **두 번 호출해도 안전**하다. 이미 있으면 손대지 않고 물러난다.

```
setup 재실행 → {"ok":true,"skipped":true,"tables":34}
seed  재실행 → {"ok":true,"skipped":true,"creator":1742}
```

갈아엎어야 할 때만 명시적으로:

| 요청 | 동작 |
|---|---|
| `POST /api/admin/setup?drop=1` | public 스키마 재생성. **데이터 전부 삭제** |
| `POST /api/admin/seed?force=1` | 데이터 테이블 TRUNCATE 후 재적재 (정책 시드는 유지) |

시드 없이 빈 DB로 운영하려면 `setup` 만 호출한다. 정책·템플릿·파이프라인 단계는
`002_seed_policy.sql` 에 들어 있어서 `setup` 만으로도 앱이 동작한다.

`001_schema.sql` 은 `CREATE TABLE IF NOT EXISTS` 를 쓰지 않는다(제약과 인덱스까지
조건부로 만들면 스키마가 읽기 어려워진다). 대신 위의 가드로 재실행을 막는다.

### 로컬에서 하고 싶다면

```bash
export DATABASE_URL='postgres://...-pooler.../DB?sslmode=require'
npm run db:setup
npm run db:seed
```

CLI 와 엔드포인트는 같은 함수를 호출한다. 결과가 다르지 않다.

## 5. 크론 확인

`vercel.json` 이 10분마다 `/api/cron/worker` 를 친다.
배포 후 Settings → Cron Jobs 에 등록됐는지 확인한다.

워커 실행 순서: `resetDaily → rampUp → circuitBreaker → inboundSync → sequenceWorker`

수동 확인:

```bash
curl -s https://<도메인>/api/cron/worker                                  # 401
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<도메인>/api/cron/worker
# {"ok":true,"sequence":{"processed":..,"sent":..,"queued":..,"finished":..}}
```

Hobby 플랜은 크론이 하루 1회로 제한된다. 10분 주기를 쓰려면 Pro 가 필요하다.

## 6. 배포 후 점검

- [ ] `/dashboard` 가 시드 데이터를 보여주는가
- [ ] `/influencers` 첫 렌더가 1초 안에 끝나는가 (LATERAL 조인 1회)
- [ ] `/u/<발급된토큰>` GET 이 확인 페이지를 띄우는가
- [ ] 없는 토큰도 200 을 주는가 (열거 방지)
- [ ] 크론 잡이 Settings 에 보이는가
- [ ] `/api/admin/setup` 을 인증 없이 POST 하면 401 인가

## CLI 로 배포하려면

```bash
npm i -g vercel
vercel login
vercel link
vercel env add DATABASE_URL production
vercel deploy --prod
```

이 저장소를 개발한 원격 세션에서는 `api.vercel.com` 이 조직 이그레스 정책에
막혀 있어 CLI 배포가 불가능하다. 로컬 터미널에서 실행할 것.
