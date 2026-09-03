-- 005: 크리에이터 유효성 상태 + 이메일 도메인 확인 캐시
--
-- 왜 상태 테이블인가:
-- 변화 감지(change_event)는 임포트할 때 델타를 흘려보내는 스트림이다. "지금 이
-- 크리에이터가 쓸 수 있는 상태인가" 를 물으면 답할 수 없다 — 이벤트를 거슬러
-- 재구성해야 한다. 발송 대상을 고를 때마다 그걸 할 수는 없다.
--
-- 상태는 우리가 가진 데이터에서만 도출한다. CSV 업로드가 유일한 입력이므로
-- 인스타그램을 직접 들여다보는 판정(계정 정지, 게시물 삭제)은 할 수 없다.
-- 대신 "우리 데이터가 낡았다" 를 상태로 드러낸다 — 조용히 낡는 것보다 낫다.

CREATE TABLE IF NOT EXISTS creator_health (
  creator_id  uuid PRIMARY KEY REFERENCES creator(id) ON DELETE CASCADE,
  state       text NOT NULL,              -- ok|dormant|stale|unreachable|bounced|dead|suppressed
  severity    text NOT NULL DEFAULT 'info', -- info|warn|alert
  reasons     jsonb NOT NULL DEFAULT '[]'::jsonb,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creator_health_state ON creator_health (state, severity);
CREATE INDEX IF NOT EXISTS creator_health_checked ON creator_health (checked_at);

-- 이메일 도메인 MX 확인 캐시.
--
-- 도메인 단위로 캐시한다. 2만 개 주소가 gmail·naver 몇 개 도메인에 몰리므로
-- 주소마다 조회하면 같은 질문을 2만 번 한다.
--
-- 한계를 분명히: MX 가 있다는 건 그 도메인이 메일을 받는다는 뜻일 뿐,
-- 그 주소가 존재한다는 뜻이 아니다. exampl.com 처럼 실재하는 오타 도메인도
-- MX 를 갖는다. 없는 도메인만 확실히 걸러낸다.
CREATE TABLE IF NOT EXISTS email_domain (
  domain      text PRIMARY KEY,
  has_mx      boolean,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  note        text
);

-- 소스별 마지막 업로드. 업로드가 끊기면 모든 판정이 낡은 데이터 위에서 돈다.
CREATE OR REPLACE VIEW source_freshness AS
  SELECT b.source,
         max(b.observed_at)                                   AS last_upload,
         (CURRENT_DATE - max(b.observed_at)::date)            AS days_ago,
         sum(b.rows_read) FILTER (WHERE b.state='committed')  AS rows_total
    FROM import_batch b
   WHERE b.state = 'committed'
   GROUP BY b.source;
