-- 003: 임포트 행을 테이블에 담는다 + 마이그레이션 추적
--
-- 이 파일부터는 마이그레이션이다. 재실행 안전해야 한다 (IF NOT EXISTS / ON CONFLICT).
-- 001·002 는 빈 DB 에만 적용되는 기준 스키마다.
--
-- 왜: 분석 결과를 import_batch.report(jsonb) 에 담고 있었는데 2,000행에서 잘랐다.
-- commitBatch 가 그 report 를 순회했으므로 1.9만 행을 올리면 1.7만 행이
-- 조용히 유실됐다. rows_read 는 19000 이라고 보고하면서 2,000건만 저장했다.
--
-- 그리고 서버리스 함수에는 실행 시간 제한이 있다. 한 요청에 1.9만 행을 다 커밋할
-- 수 없으므로 행마다 상태를 두고 여러 요청에 나눠 처리한다(재개 가능).

CREATE TABLE IF NOT EXISTS schema_migration (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_row (
  id              bigserial PRIMARY KEY,
  batch_id        uuid NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  line            integer NOT NULL,
  handle          text,
  verdict         text NOT NULL,              -- new | merge | review | error
  score           numeric(3,2) NOT NULL DEFAULT 0,
  evidence        text,
  candidate_id    uuid REFERENCES creator(id) ON DELETE SET NULL,
  candidate_handle text,
  handle_changed  boolean NOT NULL DEFAULT false,
  raw             jsonb NOT NULL,
  state           text NOT NULL DEFAULT 'pending',  -- pending | applied | skipped
  applied_at      timestamptz,
  error           text,
  UNIQUE (batch_id, line)
);

-- 커밋 워커가 "이 배치에서 아직 처리 안 된 행"을 꺼내는 경로.
CREATE INDEX IF NOT EXISTS import_row_pending
  ON import_row (batch_id, line) WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS import_row_verdict
  ON import_row (batch_id, verdict);

-- 검토 큐를 행과 연결한다. 지금은 핸들 문자열로 이어붙이고 있어서
-- 같은 핸들이 두 줄에 나오면 결정이 뒤섞인다.
ALTER TABLE merge_candidate
  ADD COLUMN IF NOT EXISTS import_row_id bigint REFERENCES import_row(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS merge_candidate_row ON merge_candidate (import_row_id);

-- 중복 판정의 후보 조회를 위한 인덱스. 1.9만 대 1.9만 비교를 전수로 돌면
-- 121초가 걸렸다(측정값). 결정론 키는 DB 인덱스로, 퍼지는 트라이그램으로 좁힌다.
CREATE INDEX IF NOT EXISTS social_account_platform_pk
  ON social_account (platform, platform_user_id) WHERE platform_user_id IS NOT NULL;
