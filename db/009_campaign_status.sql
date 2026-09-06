-- 009: 캠페인 상태를 스키마로 못 박는다
--
-- status 는 draft|running|closed 셋뿐인데 CHECK 이 없어서 무엇이든 들어갔다.
-- 실제로 'active' 로 만든 캠페인이 화면에서 조용히 사라졌다 — defaultCampaign 이
-- 'running' 만 보는데, 넣는 쪽은 그걸 알 방법이 없었다. 오타 하나가 "캠페인이
-- 안 보인다" 로 나타나면 원인을 찾는 데 한나절이 든다.
--
-- 값을 고르는 곳이 화면 하나뿐이어도 스키마로 막는다. SQL 로 직접 넣는 경로가
-- 남아 있는 한, 화면의 <select> 는 방어가 아니다.

-- 이미 들어간 값부터 정리한다. 제약을 먼저 걸면 기존 행 때문에 실패한다.
UPDATE campaign SET status = 'running' WHERE status IN ('active', 'live', 'open');
UPDATE campaign SET status = 'closed'  WHERE status IN ('done', 'finished', 'ended');
UPDATE campaign SET status = 'draft'   WHERE status NOT IN ('draft', 'running', 'closed');

ALTER TABLE campaign DROP CONSTRAINT IF EXISTS campaign_status_valid;
ALTER TABLE campaign ADD CONSTRAINT campaign_status_valid
  CHECK (status IN ('draft', 'running', 'closed'));

-- 판매 기간이 뒤집힌 캠페인은 만들 수 없다. 마감이 시작보다 빠르면 타이밍 점수와
-- 캘린더가 조용히 이상해진다.
UPDATE campaign SET sale_to = NULL WHERE sale_from IS NOT NULL AND sale_to < sale_from;

ALTER TABLE campaign DROP CONSTRAINT IF EXISTS campaign_sale_range;
ALTER TABLE campaign ADD CONSTRAINT campaign_sale_range
  CHECK (sale_from IS NULL OR sale_to IS NULL OR sale_to >= sale_from);
