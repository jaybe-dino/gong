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
| `CRON_SECRET` | `openssl rand -hex 32` 결과 | 크론 엔드포인트 Bearer |
| `MAIL_BASE_ADDRESS` | `partner@dinostudio.kr` | Reply-To 플러스 주소의 기준 |
| `MAIL_ORG_NAME` | `Dinostudio (주)` | 메일 푸터 |
| `MAIL_POSTAL` | 사업장 주소 | 정보통신망법상 필수 |
| `MAIL_PHONE` | 연락처 | 〃 |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | Gmail OAuth | **비우면 dry-run**(콘솔 출력)으로 동작 |
| `SLACK_WEBHOOK_URL` | 내부 알림 | 비우면 콘솔 |

`UNSUB_BASE_URL` 은 발송 메일의 `List-Unsubscribe` 헤더에 그대로 들어간다.
틀리면 수신거부 링크가 죽는다 — 도메인 확정 후 반드시 다시 확인할 것.

## 4. DB 스키마 + 시드

로컬에서 프로덕션 DB를 향해 한 번만 실행한다.

```bash
export DATABASE_URL='postgres://...-pooler.../DB?sslmode=require'
npm run db:setup          # 34개 테이블 + 정책 시드
npm run db:seed           # 크리에이터 1,742 / 공구 5,258 / 캠페인 멤버 342
```

시드 없이 빈 DB로 띄우려면 `db:setup` 만 돌린다.
`db:setup --drop` 은 public 스키마를 통째로 재생성한다. 프로덕션에서는 주의.

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
