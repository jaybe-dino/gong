-- 004: 적합도 점수 캐시
--
-- 왜: /influencers 가 limit 5000 으로 크리에이터를 불러와 JS 에서 점수를 매기고
-- 정렬했다. 시드 1,742명일 때는 전원이 들어왔지만 1.9만 건을 임포트한 뒤에는
-- 팔로워 상위 5,000명만 들어온다 — 팔로워는 낮지만 적합도가 높은 크리에이터가
-- 화면에서 아예 사라진다. 느린 것보다 이게 문제다. 응답도 1.2초로 늘었다.
--
-- 점수 계산식(src/lib/score.ts)을 SQL 로 옮기면 진실이 두 곳에 생긴다. 대신
-- 계산 결과를 캐시하고 정렬·페이지네이션을 DB 가 하게 한다.
--
-- 점수는 캠페인에 따라 달라진다 (카테고리 인접성 · 브랜드 충돌) — 그래서 키가
-- (campaign_id, creator_id) 다.

CREATE TABLE IF NOT EXISTS creator_fit (
  campaign_id  uuid NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  creator_id   uuid NOT NULL REFERENCES creator(id) ON DELETE CASCADE,
  score        smallint NOT NULL,
  excluded     boolean  NOT NULL DEFAULT false,
  reason       text,
  timing       text,
  breakdown    jsonb    NOT NULL DEFAULT '{}'::jsonb,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, creator_id)
);

-- 화면의 기본 정렬 경로: 캠페인 안에서 점수 높은 순.
CREATE INDEX IF NOT EXISTS creator_fit_rank
  ON creator_fit (campaign_id, score DESC, creator_id);

-- 갱신 워커가 "아직 계산 안 된 / 오래된" 크리에이터를 꺼내는 경로.
CREATE INDEX IF NOT EXISTS creator_fit_stale
  ON creator_fit (campaign_id, computed_at);

-- 타이밍 정렬(적기순)도 DB 가 해야 한다. |ratio - 1| 이 작은 순이다.
ALTER TABLE creator_fit ADD COLUMN IF NOT EXISTS timing_ratio numeric(8,3);
CREATE INDEX IF NOT EXISTS creator_fit_timing
  ON creator_fit (campaign_id, abs(timing_ratio - 1) ASC NULLS LAST);

-- 반영된 행이 어느 크리에이터를 건드렸는지 기록한다.
--
-- 적합도 캐시 무효화를 핸들 조인으로 찾고 있었는데, 커밋 중에 핸들이 바뀌는 경우
-- (소스 PK 동일 · 핸들 변경)가 있어서 정확하지 않다. 반영 시점에 id 를 남긴다.
ALTER TABLE import_row ADD COLUMN IF NOT EXISTS applied_creator_id uuid
  REFERENCES creator(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS import_row_creator ON import_row (applied_creator_id);
