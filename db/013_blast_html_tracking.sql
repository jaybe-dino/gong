-- 013: HTML 본문 + 열람·클릭 추적
--
-- 이미지를 넣으려면 HTML 본문이 필요하다. text/plain 만으로는 방법이 없다.
-- 대신 text/plain 을 버리지 않고 multipart/alternative 로 둘 다 싣는다 —
-- HTML 만 보내면 텍스트 클라이언트에서 빈 메일이 되고, 필터 점수도 나빠진다.
--
-- 추적은 발송마다 켜고 끈다. 켜면 도달률이 떨어진다:
--   · 열람 픽셀은 1x1 이미지를 숨겨 넣는 짓이라 필터가 좋아하지 않는다.
--     Gmail 은 이미지를 자기 프록시로 받아 캐시하므로 열람 수가 부풀거나
--     반대로 이미지 차단 설정에서 아예 잡히지 않는다 — 방향만 보는 지표다.
--   · 클릭 추적은 링크를 우리 도메인으로 바꿔치기하는 것이라, 원 도메인의
--     평판을 우리 도메인 평판으로 갈아 끼운다.
-- 그래서 기본값은 둘 다 꺼 둔다.

ALTER TABLE blast ADD COLUMN IF NOT EXISTS body_html    text;
ALTER TABLE blast ADD COLUMN IF NOT EXISTS track_opens  boolean NOT NULL DEFAULT false;
ALTER TABLE blast ADD COLUMN IF NOT EXISTS track_clicks boolean NOT NULL DEFAULT false;

/*
 * 클릭 추적용 링크 표.
 *
 * 리다이렉트 대상을 URL 파라미터로 받으면 안 된다 — /t/c/{token}?u=<아무주소>
 * 는 열린 리다이렉터가 되고, 우리 도메인의 신뢰를 빌려 피싱에 쓰인다.
 * 발송할 때 본문의 링크를 이 표에 담고, 링크는 번호로만 가리킨다.
 */
CREATE TABLE IF NOT EXISTS blast_link (
  blast_id uuid    NOT NULL REFERENCES blast(id) ON DELETE CASCADE,
  idx      integer NOT NULL,
  url      text    NOT NULL,
  PRIMARY KEY (blast_id, idx)
);

-- 열람·클릭을 어느 메시지의 것으로 셀지. 메시지 id 를 URL 에 그대로 쓰지 않는다 —
-- 남의 발송 결과를 번호만 바꿔가며 훑을 수 있게 되면 안 된다.
ALTER TABLE message ADD COLUMN IF NOT EXISTS track_token text;
CREATE UNIQUE INDEX IF NOT EXISTS message_track_token ON message (track_token)
  WHERE track_token IS NOT NULL;
