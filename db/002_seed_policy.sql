-- =====================================================================
--  정책 시드 — 이 파일이 컴플라이언스의 실체다.
--  psql "$DATABASE_URL" -f db/002_seed_policy.sql
-- =====================================================================

-- 채널 정책 -----------------------------------------------------------
-- allows_cold=false 는 "시스템이 이 채널을 콜드 자동 발송에 쓰지 않는다"는 선언.
-- 실행은 automation_mode='manual_task' 가 outreach_task 로 강제 라우팅한다.
INSERT INTO channel_policy
 (channel, allows_cold, automation_mode, night_block, requires_ad_label, requires_optout, default_daily_cap, cooldown_days)
VALUES
 ('email',         true,  'auto',        false, true,  true,  75,   90),
 ('instagram_dm',  false, 'manual_task', true,  false, false, 30,   120),
 ('inpock_offer',  false, 'manual_task', true,  false, false, NULL, 120),
 ('linktree_form', false, 'manual_task', true,  false, false, NULL, 120),
 ('kakao',         false, 'auto',        true,  true,  true,  NULL, 30),
 ('sms',           false, 'auto',        true,  true,  true,  NULL, 30)
ON CONFLICT (channel) DO NOTHING;

-- 서킷브레이커 --------------------------------------------------------
INSERT INTO circuit_breaker (metric, warn_at, halt_at, action) VALUES
 ('spam_rate',       0.0010, 0.0030, 'halt_all_sending'),
 ('bounce_rate',     0.0300, 0.0500, 'reduce_volume_50'),
 ('inbox_rate',      0.8500, 0.7000, 'pause_sending'),
 ('ig_action_block', 1,      1,      'pause_sender_24h')
ON CONFLICT (metric) DO NOTHING;

-- 파이프라인 스테이지 -------------------------------------------------
-- 필수 3개(live/complete/dropped)는 비활성화 불가.
INSERT INTO pipeline_stage (key, label, phase, sort_order, is_terminal, is_required) VALUES
 ('prospect',    '발굴',      'prospect', 1,  false, false),
 ('qualified',   '검증 완료', 'prospect', 2,  false, false),
 ('contacted',   '컨택 발송', 'outreach', 3,  false, false),
 ('replied',     '회신',      'outreach', 4,  false, false),
 ('negotiating', '조건 협의', 'deal',     5,  false, false),
 ('agreed',      '확정',      'deal',     6,  false, false),
 ('sampling',    '샘플 발송', 'delivery', 7,  false, false),
 ('live',        '진행중',    'delivery', 8,  false, true),
 ('settling',    '정산',      'closed',   9,  false, false),
 ('complete',    '완료',      'closed',   10, true,  true),
 ('dropped',     '이탈',      'closed',   11, true,  true)
ON CONFLICT (key) DO NOTHING;

-- 카테고리 매핑 (소스별 표기 → 우리 표준) ------------------------------
INSERT INTO category_map (source, source_category, canonical) VALUES
 ('momcal','육아','육아'), ('momcal','리빙','리빙'), ('momcal','식품','식품'),
 ('momcal','가전','가전'), ('momcal','뷰티','뷰티'), ('momcal','건강','건강'),
 ('momcal','패션','패션'), ('momcal','여행','여행'), ('momcal','생필품','리빙'),
 ('momcal','반려동물','반려동물'),
 ('pangpang','홈리빙','인테리어'), ('pangpang','주방용품','리빙'),
 ('pangpang','식품','식품'), ('pangpang','건강식품','건강'),
 ('pangpang','뷰티','뷰티'), ('pangpang','패션잡화','패션'),
 ('pangpang','유아동','육아'), ('pangpang','가전디지털','가전'),
 ('pangpang','반려동물','반려동물'), ('pangpang','여행','여행'),
 ('ingong','생활/장보기','리빙'), ('ingong','가전/가구','가전'),
 ('ingong','건강/뷰티','뷰티'), ('ingong','주방/청소','리빙'),
 ('ingong','여행/숙소','여행'), ('ingong','키즈용품','육아'),
 ('ingong','키카/체험','육아'), ('ingong','반려동물','반려동물')
ON CONFLICT (source, source_category) DO NOTHING;

-- 기본 시퀀스 (4스텝 / 12일) ------------------------------------------
INSERT INTO app_user (id, email, name, role) VALUES
 ('00000000-0000-0000-0000-0000000000aa', 'jay@dinostudio.kr', 'jay', 'owner'),
 ('00000000-0000-0000-0000-0000000000bb', 'system@dinostudio.kr', 'system', 'owner')
ON CONFLICT (email) DO NOTHING;

INSERT INTO template (id, channel, name, target_tier, subject, body, is_ad_content) VALUES
 ('00000000-0000-0000-0000-00000000e001','email','공구 제안 · 마이크로 A','micro',
  '{{name}}님, {{brand}} {{product}} 공동구매 제안드립니다',
$$안녕하세요 {{name}}님, {{sender_name}}입니다.

{{last_gb_brand}} 공구를 인상 깊게 봤습니다. {{category}} 카테고리에서 꾸준히 {{cadence}}일 간격으로 공구를 열어오신 걸 보고 연락드립니다.

{{sale_from}}부터 진행하는 **{{brand}} {{product}}** 공동구매를 함께 하실 수 있을지 여쭙습니다.

· 수수료 {{commission}}%
· 샘플 무상 제공, 상세페이지·소재 일체 제공
· 정산은 판매 종료 후 10일 이내

관심 있으시면 이 메일에 회신만 주셔도 됩니다. 조건은 조정 가능합니다.

감사합니다.$$, true),

 ('00000000-0000-0000-0000-00000000e002','email','공구 제안 · 폴로업 1','micro',
  NULL,
$${{name}}님, 지난 메일 확인하셨을까 싶어 한 번 더 남깁니다.

같은 {{category}} 카테고리에서 최근 진행한 공구는 평균 판매 {{social_proof}}를 기록했습니다.

일정만 맞으면 조건은 맞춰드릴 수 있습니다. 편하실 때 회신 부탁드립니다.$$, true),

 ('00000000-0000-0000-0000-00000000e003','instagram_dm','DM 제안 · 마이크로','micro',
  NULL,
$${{RANDOM|안녕하세요|반갑습니다}}! {{category}} 공구 {{RANDOM|꾸준히 보고 있었습니다|잘 보고 있었습니다}}.
{{sale_from}} 오픈하는 {{brand}} {{product}} 공구 함께 하실 수 있을지 여쭤봅니다.
조건은 수수료 {{commission}}%에 샘플 제공입니다. 관심 있으시면 편하게 답 주세요!$$, false),

 ('00000000-0000-0000-0000-00000000e004','inpock_offer','인포크 제안 · 공동구매',NULL,
  NULL,
$$제안 유형: 공동구매
기간: {{sale_from}} ~ {{sale_to}}
카테고리: {{category}}
제안 가격: 수수료 {{commission}}%
내용: {{brand}} {{product}} 공동구매를 제안드립니다. 샘플과 소재 일체 제공, 정산은 판매 종료 후 10일 이내입니다.$$, false),

 ('00000000-0000-0000-0000-00000000e005','email','브레이크업','micro',
  '{{name}}님, 이번 건은 여기서 마무리하겠습니다',
$${{name}}님, 회신이 없으셔서 이번 {{brand}} 건은 여기서 마무리하겠습니다.

다음에 더 맞는 상품으로 다시 인사드리겠습니다. 좋은 하루 보내세요.$$, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO sequence (id, name, target_tier) VALUES
 ('00000000-0000-0000-0000-00000000f001','기본 4스텝 · 마이크로','micro')
ON CONFLICT (id) DO NOTHING;

INSERT INTO sequence_step (id, sequence_id, step_no, channel, execution, delay_minutes) VALUES
 ('00000000-0000-0000-0000-00000000f101','00000000-0000-0000-0000-00000000f001',1,'email','auto',0),
 ('00000000-0000-0000-0000-00000000f102','00000000-0000-0000-0000-00000000f001',2,'email','auto',4320),
 ('00000000-0000-0000-0000-00000000f103','00000000-0000-0000-0000-00000000f001',3,'instagram_dm','manual_task',10080),
 ('00000000-0000-0000-0000-00000000f104','00000000-0000-0000-0000-00000000f001',4,'email','auto',17280)
ON CONFLICT (id) DO NOTHING;

INSERT INTO step_variant (step_id, label, template_id, weight, is_approved) VALUES
 ('00000000-0000-0000-0000-00000000f101','제목 A','00000000-0000-0000-0000-00000000e001',50,true),
 ('00000000-0000-0000-0000-00000000f102','기본',  '00000000-0000-0000-0000-00000000e002',100,true),
 ('00000000-0000-0000-0000-00000000f103','기본',  '00000000-0000-0000-0000-00000000e003',100,true),
 ('00000000-0000-0000-0000-00000000f104','기본',  '00000000-0000-0000-0000-00000000e005',100,true)
ON CONFLICT DO NOTHING;

-- 발신 자원 -----------------------------------------------------------
INSERT INTO sender (channel, identifier, display_name, provider, daily_cap, current_cap, account_age_d) VALUES
 ('email','partner@dinostudio.kr','Dinostudio 파트너십','google',75,75,400),
 ('email','hello@dino-partners.kr','Dinostudio','google',75,75,180),
 ('email','team@dino-partners.kr','Dinostudio','google',75,25,9),
 ('instagram_dm','@dino_partner','Dinostudio','native',30,30,220),
 ('instagram_dm','@dino_gonggu','Dinostudio','native',30,30,95)
ON CONFLICT (identifier) DO NOTHING;

-- 워치리스트 ----------------------------------------------------------
INSERT INTO watchlist (kind, target, condition, threshold) VALUES
 ('brand','라누보','new_deal',NULL),
 ('brand','알텐바흐','new_seller',NULL),
 ('seller','livingnote_k','timing_ready',NULL),
 ('seller','mom_dailylog','new_deal',NULL),
 ('keyword','극세사','keyword_match',NULL),
 ('category','인테리어','surge',5)
ON CONFLICT (kind, target, condition) DO NOTHING;
