-- 015: 개선 제보
--
-- 화면을 쓰다가 발견한 것을 그 자리에서 적어 두는 곳. 슬랙이나 구두로 흘리면
-- 무엇이 남았는지 아무도 모르고, 같은 제보가 반복된다. 화면·브라우저 상태를
-- 같이 담는 이유도 같다 — "그 화면에서 안 돼요" 만으로는 재현할 수 없다.

CREATE TABLE IF NOT EXISTS feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  kind        text NOT NULL DEFAULT 'improve'
              CHECK (kind IN ('bug', 'improve', 'question')),
  -- 요청 → 확인됨 → 개발중 → 완료. 보류는 "안 하기로 했다" 는 결정이고,
  -- 조용히 사라지는 것과 구분되어야 한다.
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'planned', 'doing', 'done', 'wontfix')),
  page_path   text,
  page_title  text,
  -- 브라우저·화면·최근 이동 경로·자바스크립트 오류. 재현에 필요한 것만 담는다.
  context     jsonb NOT NULL DEFAULT '{}'::jsonb,
  note        text,                       -- 처리하는 사람이 남기는 답
  created_by  uuid REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz,
  -- 완료·보류면 끝난 시각이 있어야 하고, 그 전이면 없어야 한다. 목록에서
  -- "완료인데 언제 됐는지 모르는" 행이 생기지 않게 스키마가 막는다.
  CONSTRAINT feedback_done_at_matches_status CHECK (
    (status IN ('done', 'wontfix')) = (done_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS feedback_open_idx ON feedback (status, created_at DESC);

-- 첨부는 행 안에 둔다. 파일 저장소를 붙이면 그것부터 운영해야 하고, 제보용
-- 스크린샷 몇 장에 그럴 이유가 없다. 대신 업로드 쪽에서 크기를 줄여 받는다.
CREATE TABLE IF NOT EXISTS feedback_image (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id uuid NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  mime        text NOT NULL,
  bytes       bytea NOT NULL,
  filename    text,
  size_bytes  integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_image_fk_idx ON feedback_image (feedback_id);
