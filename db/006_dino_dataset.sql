-- 006: 실제 데이터셋을 담기 위한 확장
--
-- 들어온 데이터에는 우리 스키마에 자리가 없는 것들이 있다.
--   · 인스타 계정이 없는 blogpay 샵 (779건) — 사업자 정보만 있다
--   · 연락 채널이 7종 (이메일·전화·카카오·인포크·인링크·리틀리/링크트리·DM)
--   · 사람이 매긴 티어(A~F)와 연락등급, 검증 상태
--   · 사업자번호·대표자·주소
--
-- 자리를 만들지 않으면 임포트가 이 값들을 조용히 버린다.

-- 아웃리치 티어. creator.tier 는 팔로워 규모(nano~mega)라 축이 다르다 —
-- 같은 칸에 넣으면 둘 다 못 쓴다.
ALTER TABLE creator ADD COLUMN IF NOT EXISTS outreach_tier text;      -- A|B|C|D|E|F
ALTER TABLE creator ADD COLUMN IF NOT EXISTS contact_grade text;      -- A.이메일+전화 | B.이메일 | C.전화 | D.카톡 | Z.없음
ALTER TABLE creator ADD COLUMN IF NOT EXISTS has_gonggu_sign boolean NOT NULL DEFAULT false;
ALTER TABLE creator ADD COLUMN IF NOT EXISTS biz_name text;
ALTER TABLE creator ADD COLUMN IF NOT EXISTS representative text;
ALTER TABLE creator ADD COLUMN IF NOT EXISTS biz_no text;
ALTER TABLE creator ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE creator ADD COLUMN IF NOT EXISTS shop_url text;

CREATE INDEX IF NOT EXISTS creator_outreach_tier ON creator (outreach_tier, contact_grade);
CREATE INDEX IF NOT EXISTS creator_biz_no ON creator (biz_no) WHERE biz_no IS NOT NULL;

-- DM 딥링크. ig.me/m/{handle} 는 인스타 공식 링크다 — 자동 발송은 못 해도
-- 작업자가 한 번 눌러 대화창을 열 수 있다. 매번 조립하지 말고 받은 값을 보관한다.
ALTER TABLE social_account ADD COLUMN IF NOT EXISTS dm_url text;

-- 인링크(inlink.to)는 별도 채널이다. 인포크와 제안 폼 구조가 다르다.
INSERT INTO channel_policy
 (channel, allows_cold, automation_mode, night_block, requires_ad_label, requires_optout, default_daily_cap, cooldown_days)
VALUES
 ('inlink_form', false, 'manual_task', true,  false, false, NULL, 120),
 -- 전화는 콜드 금지다. 회신이 온 뒤 후속 소통용으로만 쓴다.
 ('phone',       false, 'manual_task', true,  false, false, 20,   180)
ON CONFLICT (channel) DO NOTHING;
