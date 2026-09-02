-- =====================================================================
--  Dinostudio 공동구매 아웃리치 OS — PostgreSQL 15+
--  psql "$DATABASE_URL" -f db/001_schema.sql
--
--  설계 원칙
--   1. 상태는 사람(creator)이 아니라 관계(campaign_member)에 붙는다.
--   2. 엔진 상태 / 파이프라인 스테이지 / 회신 의미를 3축으로 분리한다.
--   3. 수집 출처를 진술할 수 없는 연락처는 저장 자체를 막는다 (NOT NULL).
--   4. 컴플라이언스는 코드가 아니라 channel_policy 테이블이 통제한다.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- 핸들 유사도(dedupe)

-- ---------------------------------------------------------------------
-- 0. 사용자 / 감사
-- ---------------------------------------------------------------------
CREATE TABLE app_user (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  name        text NOT NULL,
  role        text NOT NULL DEFAULT 'member',   -- owner | member | viewer
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES app_user(id),
  actor_kind  text NOT NULL DEFAULT 'user',     -- user | system | worker
  entity      text NOT NULL,
  entity_id   text NOT NULL,
  action      text NOT NULL,
  before      jsonb,
  after       jsonb,
  reason      text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (entity, entity_id, occurred_at DESC);

-- ---------------------------------------------------------------------
-- 1. 아이덴티티
-- ---------------------------------------------------------------------
CREATE TABLE creator (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name     text        NOT NULL,
  primary_platform text        NOT NULL DEFAULT 'instagram',
  tier             text,                                   -- nano|micro|mid|macro|mega|agency
  home_region      text,
  gb_experience    text        NOT NULL DEFAULT 'unknown',  -- unknown|none|occasional|regular|pro
  is_agency        boolean     NOT NULL DEFAULT false,
  agency_name      text,
  is_curated       boolean     NOT NULL DEFAULT false,      -- 맘캘린더 큐레이션 플래그
  dedupe_score     numeric(3,2),
  merged_into      uuid REFERENCES creator(id),             -- 병합되면 여기로
  owner_user_id    uuid REFERENCES app_user(id),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON creator (merged_into) WHERE merged_into IS NOT NULL;

-- 지표는 사람이 아니라 계정에 붙는다.
CREATE TABLE social_account (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id        uuid        NOT NULL REFERENCES creator(id) ON DELETE CASCADE,
  platform          text        NOT NULL DEFAULT 'instagram',
  platform_user_id  text,                    -- 불변 ID. 있으면 이게 1순위 키.
  handle            text        NOT NULL,    -- 정규화된 소문자 핸들
  handle_raw        text,
  profile_url       text        NOT NULL,
  bio_text          text,
  link_in_bio       text,
  is_active         boolean     NOT NULL DEFAULT true,
  deactivated_at    timestamptz,
  last_verified_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, handle)
);
CREATE UNIQUE INDEX social_account_pid_uq
  ON social_account (platform, platform_user_id) WHERE platform_user_id IS NOT NULL;

-- 핸들은 바뀐다. 슬러그를 키로 쓰면 안 되는 이유이기도 하다.
CREATE TABLE handle_alias (
  id                bigserial PRIMARY KEY,
  social_account_id uuid NOT NULL REFERENCES social_account(id) ON DELETE CASCADE,
  handle            text NOT NULL,
  seen_from         timestamptz NOT NULL DEFAULT now(),
  seen_to           timestamptz,
  UNIQUE (social_account_id, handle)
);

CREATE TABLE account_snapshot (
  id                 bigserial PRIMARY KEY,
  social_account_id  uuid        NOT NULL REFERENCES social_account(id) ON DELETE CASCADE,
  captured_at        timestamptz NOT NULL DEFAULT now(),
  source             text        NOT NULL,     -- momcal | pangpang | ingong | manual
  followers          integer,
  followers_precision integer,                 -- "10.8만" -> ±500
  following          integer,
  posts_count        integer,
  avg_likes          numeric(10,1),
  avg_comments       numeric(10,1),
  engagement_rate    numeric(6,4),
  credibility        numeric(5,2),
  last_active_at     timestamptz,
  deals_30d          integer,                  -- insta-gong 고유
  deals_90d          integer,
  avg_interval_days  numeric(6,2),             -- 평균 공구 간격
  days_since_last    integer,
  category_share     jsonb NOT NULL DEFAULT '{}'::jsonb,
  sample_confidence  text                      -- green | orange | red
);
CREATE INDEX ON account_snapshot (social_account_id, captured_at DESC);

-- 컴플라이언스 심장. source_* 3종은 NOT NULL — 소급이 불가능한 유일한 데이터.
CREATE TABLE contact_point (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id     uuid        NOT NULL REFERENCES creator(id) ON DELETE CASCADE,
  channel        text        NOT NULL,   -- email|instagram_dm|inpock_offer|linktree_form|kakao|sms|phone
  value          text        NOT NULL,
  value_norm     text        NOT NULL,   -- 소문자/E.164. suppression 조회 전용
  source_type    text        NOT NULL,   -- bio_public|link_page_public|inbound_apply|business_card|referral
  source_url     text        NOT NULL,
  collected_at   timestamptz NOT NULL,
  collected_by   uuid        NOT NULL REFERENCES app_user(id),
  collect_note   text,
  consent_status text        NOT NULL DEFAULT 'none',  -- none|implied_public|opt_in|opt_out
  consent_at     timestamptz,
  consent_proof  text,
  verification   text        NOT NULL DEFAULT 'unverified', -- unverified|valid|risky|catch_all|invalid
  is_primary     boolean     NOT NULL DEFAULT false,
  last_sent_at   timestamptz,
  bounce_count   smallint    NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_id, channel, value_norm),
  CONSTRAINT consent_needs_timestamp
    CHECK (consent_status <> 'opt_in' OR consent_at IS NOT NULL)
);
CREATE INDEX ON contact_point (value_norm);
CREATE INDEX ON contact_point (creator_id, channel);

-- 3튜플. 문자열 하나로는 부족하다.
CREATE TABLE suppression (
  id              bigserial PRIMARY KEY,
  scope           text NOT NULL DEFAULT 'global',   -- global | campaign
  scope_ref       uuid,
  identifier_type text NOT NULL,   -- email|email_domain|phone|ig_handle|creator_id
  identifier_val  text NOT NULL,
  channels        text[] NOT NULL DEFAULT '{}',     -- 빈 배열 = 전 채널
  reason          text NOT NULL,   -- unsubscribe|dnc_request|hard_bounce|complaint|manual|legal
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,                      -- 수신거부는 반드시 NULL(영구)
  CONSTRAINT unsub_is_permanent
    CHECK (reason NOT IN ('unsubscribe','dnc_request') OR expires_at IS NULL)
);
CREATE UNIQUE INDEX suppression_uq
  ON suppression (scope, COALESCE(scope_ref,'00000000-0000-0000-0000-000000000000'::uuid),
                  identifier_type, identifier_val);

-- ---------------------------------------------------------------------
-- 2. 공구 도메인 (브랜드 / 제품 / 딜)
-- ---------------------------------------------------------------------
CREATE TABLE brand (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  name_norm    text NOT NULL UNIQUE,       -- 공백/기호 제거 소문자
  aliases      text[] NOT NULL DEFAULT '{}',
  category     text,
  source_slug  text,                       -- momcalendar /g/{slug}
  is_verified  boolean NOT NULL DEFAULT false,  -- 브랜드 사전에 있던 이름인가
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id       uuid REFERENCES brand(id),
  name           text NOT NULL,
  name_norm      text NOT NULL,
  recurrence_cnt integer NOT NULL DEFAULT 1   -- momcalendar "여러 번 진행된 제품"
);
CREATE UNIQUE INDEX product_uq
  ON product (COALESCE(brand_id,'00000000-0000-0000-0000-000000000000'::uuid), name_norm);

CREATE TABLE deal (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id     uuid REFERENCES creator(id) ON DELETE SET NULL,
  social_account_id uuid REFERENCES social_account(id) ON DELETE SET NULL,
  brand_id       uuid REFERENCES brand(id),
  product_id     uuid REFERENCES product(id),
  title          text NOT NULL,
  title_norm     text NOT NULL,
  category_l1    text,
  category_l2    text,
  region         text,
  open_at        timestamptz,
  close_at       timestamptz,
  open_date      date,
  close_date     date,
  is_always_on   boolean NOT NULL DEFAULT false,   -- 상시 공구. 캘린더 집계에서 분리.
  price_krw      integer,
  discount_rate  numeric(5,2),
  hashtags       text[] NOT NULL DEFAULT '{}',
  permalink      text,                              -- 인스타 원문. 저장은 링크만.
  is_curated     boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active',    -- active | gone
  first_seen     timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT always_on_has_no_close
    CHECK (NOT is_always_on OR close_date IS NULL)
);
-- 중복 제거 복합키: (셀러, 정규화 제품명, 오픈일)
CREATE UNIQUE INDEX deal_natural_uq
  ON deal (COALESCE(creator_id,'00000000-0000-0000-0000-000000000000'::uuid),
           title_norm, COALESCE(open_date,'1900-01-01'::date));
CREATE INDEX ON deal (open_date, close_date);
CREATE INDEX ON deal (brand_id, open_date DESC);
CREATE INDEX ON deal (creator_id, open_date DESC);

-- 같은 딜을 여러 소스가 보고한다. 소스별 원 PK는 버리지 않는다.
CREATE TABLE deal_source (
  id          bigserial PRIMARY KEY,
  deal_id     uuid NOT NULL REFERENCES deal(id) ON DELETE CASCADE,
  source      text NOT NULL,           -- momcal | pangpang | ingong
  source_pk   text,
  source_url  text,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  http_status smallint,                -- 410이면 원문 소멸
  UNIQUE (deal_id, source)
);

-- 소스별 원 식별자를 크리에이터에도 붙여둔다 (역추적용, 매칭 키 아님)
CREATE TABLE source_ref (
  id          bigserial PRIMARY KEY,
  entity      text NOT NULL,           -- creator | brand | deal
  entity_id   uuid NOT NULL,
  source      text NOT NULL,
  source_pk   text NOT NULL,
  source_url  text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity, source, source_pk)
);

CREATE TABLE category_map (
  id               bigserial PRIMARY KEY,
  source           text NOT NULL,
  source_category  text NOT NULL,
  canonical        text NOT NULL,
  UNIQUE (source, source_category)
);

-- ---------------------------------------------------------------------
-- 3. 임포트 / 모니터링
-- ---------------------------------------------------------------------
CREATE TABLE import_batch (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL,
  filename      text,
  uploaded_by   uuid REFERENCES app_user(id),
  observed_at   timestamptz NOT NULL DEFAULT now(),
  rows_read     integer NOT NULL DEFAULT 0,
  rows_new      integer NOT NULL DEFAULT 0,
  rows_merged   integer NOT NULL DEFAULT 0,
  rows_review   integer NOT NULL DEFAULT 0,
  rows_error    integer NOT NULL DEFAULT 0,
  state         text NOT NULL DEFAULT 'dry_run',   -- dry_run | committed | discarded
  report        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 사람이 판단해야 하는 병합 후보
CREATE TABLE merge_candidate (
  id            bigserial PRIMARY KEY,
  batch_id      uuid REFERENCES import_batch(id) ON DELETE CASCADE,
  incoming      jsonb NOT NULL,
  candidate_id  uuid REFERENCES creator(id),
  score         numeric(3,2) NOT NULL,
  evidence      text,
  decision      text,                              -- merge | split | pending
  decided_by    uuid REFERENCES app_user(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 스냅샷 사이의 델타. "자동 수집"이 아니라 "차이 감지".
CREATE TABLE change_event (
  id          bigserial PRIMARY KEY,
  batch_id    uuid REFERENCES import_batch(id) ON DELETE SET NULL,
  kind        text NOT NULL,   -- new_deal|brand_conflict|new_brand|timing_ready
                               -- |deal_gone|handle_change|price_change|category_surge|account_dead
  entity      text,
  entity_id   uuid,
  handle      text,
  title       text NOT NULL,
  detail      text,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  severity    text NOT NULL DEFAULT 'info',   -- info | warn | alert
  is_read     boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON change_event (occurred_at DESC);
CREATE INDEX ON change_event (kind, is_read);

CREATE TABLE watchlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL,     -- brand | seller | keyword | category
  target      text NOT NULL,
  condition   text NOT NULL,     -- new_deal | new_seller | timing_ready | surge | keyword_match
  threshold   integer,
  notify      text NOT NULL DEFAULT 'slack',
  owner_user_id uuid REFERENCES app_user(id),
  last_hit_at timestamptz,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (kind, target, condition)
);

-- ---------------------------------------------------------------------
-- 4. 캠페인 / 파이프라인
-- ---------------------------------------------------------------------
CREATE TABLE campaign (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  brand_id        uuid REFERENCES brand(id),
  brand_name      text NOT NULL,
  category        text NOT NULL,
  commission_rate numeric(5,2),
  sale_from       date,
  sale_to         date,
  target_count    integer,
  status          text NOT NULL DEFAULT 'draft',   -- draft|running|closed
  owner_user_id   uuid REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 스테이지는 하드코딩 enum이 아니라 테이블. 필수 3개는 비활성화 불가.
CREATE TABLE pipeline_stage (
  id          smallserial PRIMARY KEY,
  key         text NOT NULL UNIQUE,
  label       text NOT NULL,
  phase       text NOT NULL,    -- prospect|outreach|deal|delivery|closed
  sort_order  smallint NOT NULL,
  is_terminal boolean NOT NULL DEFAULT false,
  is_required boolean NOT NULL DEFAULT false,
  is_enabled  boolean NOT NULL DEFAULT true
);

CREATE TABLE sequence (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  target_tier          text,
  stop_on_reply        boolean NOT NULL DEFAULT true,
  stop_on_auto_reply   boolean NOT NULL DEFAULT false,  -- 부재중은 답장이 아니다
  stop_on_stage_change boolean NOT NULL DEFAULT true,
  send_hour_from       smallint NOT NULL DEFAULT 9,
  send_hour_to         smallint NOT NULL DEFAULT 18,
  weekdays_only        boolean NOT NULL DEFAULT true,
  is_active            boolean NOT NULL DEFAULT true
);

CREATE TABLE template (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel       text NOT NULL,
  name          text NOT NULL,
  target_tier   text,
  subject       text,
  body          text NOT NULL,
  is_ad_content boolean NOT NULL DEFAULT true,   -- true면 (광고) 자동 주입
  locale        text NOT NULL DEFAULT 'ko',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequence_step (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id    uuid NOT NULL REFERENCES sequence(id) ON DELETE CASCADE,
  step_no        smallint NOT NULL,
  channel        text NOT NULL,
  execution      text NOT NULL DEFAULT 'auto',   -- auto | manual_task
  delay_minutes  integer NOT NULL DEFAULT 0,
  condition_expr jsonb,
  next_on_true   uuid,
  next_on_false  uuid,
  UNIQUE (sequence_id, step_no)
);

CREATE TABLE step_variant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  step_id     uuid NOT NULL REFERENCES sequence_step(id) ON DELETE CASCADE,
  label       text NOT NULL,
  template_id uuid NOT NULL REFERENCES template(id),
  weight      smallint NOT NULL DEFAULT 50,
  is_approved boolean NOT NULL DEFAULT false     -- 미승인 변형은 발송 불가
);

-- ★ 상태가 사는 곳
CREATE TABLE campaign_member (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid     NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  creator_id       uuid     NOT NULL REFERENCES creator(id),
  stage_id         smallint NOT NULL REFERENCES pipeline_stage(id),
  engine_state     smallint NOT NULL DEFAULT 1,   -- 양수=진행, 음수=종결 (lib/states.js)
  interest_status  smallint NOT NULL DEFAULT 0,
  sequence_id      uuid     REFERENCES sequence(id),
  current_step     smallint NOT NULL DEFAULT 0,
  next_action_at   timestamptz,
  owner_user_id    uuid     REFERENCES app_user(id),
  fit_score        smallint,
  fit_breakdown    jsonb,
  reply_token      text UNIQUE,       -- Reply-To 플러스 주소의 cm_xxx
  first_sent_at    timestamptz,
  last_sent_at     timestamptz,
  replied_at       timestamptz,
  agreed_at        timestamptz,
  live_at          timestamptz,
  dropped_at       timestamptz,
  drop_reason      text,
  gmv              numeric(14,0) NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, creator_id)
);
CREATE INDEX ON campaign_member (next_action_at) WHERE engine_state > 0;
CREATE INDEX ON campaign_member (campaign_id, stage_id);

-- ---------------------------------------------------------------------
-- 5. 발송 / 관측
-- ---------------------------------------------------------------------
-- 메일박스와 IG 계정을 같은 테이블로 다룬다 — 상한 로직이 동일하기 때문.
CREATE TABLE sender (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel        text NOT NULL,           -- email | instagram_dm
  identifier     text NOT NULL UNIQUE,    -- 주소 또는 @핸들
  display_name   text,
  provider       text,                    -- google | microsoft | native
  oauth_ref      text,
  account_age_d  integer,
  daily_cap      smallint NOT NULL DEFAULT 75,
  current_cap    smallint NOT NULL DEFAULT 10,
  ramp_step      smallint NOT NULL DEFAULT 1,
  sent_today     smallint NOT NULL DEFAULT 0,
  sent_date      date NOT NULL DEFAULT CURRENT_DATE,
  warmup_on      boolean NOT NULL DEFAULT true,
  health_score   numeric(4,1),
  paused_until   timestamptz,
  pause_reason   text,
  is_active      boolean NOT NULL DEFAULT true
);

-- 사람이 처리하는 큐. DM·인포크가 여기로 온다.
CREATE TABLE outreach_task (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_member_id uuid NOT NULL REFERENCES campaign_member(id) ON DELETE CASCADE,
  channel            text NOT NULL,
  contact_point_id   uuid REFERENCES contact_point(id),
  sender_id          uuid REFERENCES sender(id),
  step_id            uuid REFERENCES sequence_step(id),
  rendered_subject   text,
  rendered_body      text NOT NULL,     -- 담당자는 복사만 한다
  target_url         text,              -- instagram.com/{handle} 또는 링크페이지
  state              text NOT NULL DEFAULT 'queued',  -- queued|claimed|sent|skipped|blocked
  assigned_to        uuid REFERENCES app_user(id),
  due_at             timestamptz,
  claimed_at         timestamptz,
  completed_at       timestamptz,
  skip_reason        text,
  evidence_url       text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON outreach_task (state, due_at) WHERE state IN ('queued','claimed');

CREATE TABLE message (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_member_id uuid NOT NULL REFERENCES campaign_member(id) ON DELETE CASCADE,
  contact_point_id   uuid REFERENCES contact_point(id),
  sender_id          uuid REFERENCES sender(id),
  channel            text NOT NULL,
  direction          text NOT NULL,      -- out | in  ← 통합 인박스는 이 컬럼 하나로 성립
  step_id            uuid REFERENCES sequence_step(id),
  variant_id         uuid REFERENCES step_variant(id),
  thread_key         text,               -- Gmail threadId
  provider_msg_id    text,
  from_name          text,
  subject            text,
  body               text NOT NULL,
  sent_at            timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL DEFAULT 'sent'
);
CREATE INDEX ON message (thread_key, sent_at);
CREATE INDEX ON message (campaign_member_id, sent_at);
CREATE UNIQUE INDEX ON message (provider_msg_id) WHERE provider_msg_id IS NOT NULL;

CREATE TABLE message_event (
  id          bigserial PRIMARY KEY,
  message_id  uuid NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  type        text NOT NULL,   -- delivered|open|click|reply|bounce_hard|bounce_soft
                               -- |complaint|unsubscribe|ooo|read
  occurred_at timestamptz NOT NULL DEFAULT now(),
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ON message_event (type, occurred_at DESC);

CREATE TABLE attribution_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  creator_id  uuid NOT NULL REFERENCES creator(id),
  kind        text NOT NULL,           -- link | coupon
  token       text NOT NULL UNIQUE,
  landing_url text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, creator_id, kind)
);

CREATE TABLE conversion (
  id           bigserial PRIMARY KEY,
  token_id     uuid NOT NULL REFERENCES attribution_token(id) ON DELETE CASCADE,
  order_ref    text NOT NULL,
  gmv          numeric(14,0) NOT NULL,
  occurred_at  timestamptz NOT NULL,
  UNIQUE (token_id, order_ref)
);

-- ---------------------------------------------------------------------
-- 6. 정책 — 코드가 아니라 데이터가 발송 워커를 통제한다
-- ---------------------------------------------------------------------
CREATE TABLE channel_policy (
  channel            text PRIMARY KEY,
  allows_cold        boolean NOT NULL,
  automation_mode    text    NOT NULL,      -- auto | manual_task | disabled
  night_block        boolean NOT NULL,      -- 21:00~08:00 차단
  night_from_hour    smallint NOT NULL DEFAULT 21,
  night_to_hour      smallint NOT NULL DEFAULT 8,
  requires_ad_label  boolean NOT NULL,
  requires_optout    boolean NOT NULL,
  default_daily_cap  smallint,
  cooldown_days      smallint NOT NULL DEFAULT 90,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE circuit_breaker (
  id            smallserial PRIMARY KEY,
  metric        text NOT NULL UNIQUE,   -- spam_rate|bounce_rate|inbox_rate|ig_action_block
  warn_at       numeric(6,4),
  halt_at       numeric(6,4),
  action        text NOT NULL,
  current_value numeric(6,4),
  tripped_at    timestamptz,
  is_tripped    boolean NOT NULL DEFAULT false
);

-- 발송 차단 기록. 왜 안 나갔는지 답할 수 있어야 한다.
CREATE TABLE gate_block (
  id                 bigserial PRIMARY KEY,
  campaign_member_id uuid REFERENCES campaign_member(id) ON DELETE CASCADE,
  channel            text NOT NULL,
  failed_check       text NOT NULL,
  detail             text,
  occurred_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON gate_block (occurred_at DESC);

-- ---------------------------------------------------------------------
-- 7. 편의 뷰
-- ---------------------------------------------------------------------
CREATE VIEW v_creator_latest AS
SELECT DISTINCT ON (sa.creator_id)
       c.id AS creator_id, c.display_name, c.tier, c.gb_experience, c.is_curated,
       sa.id AS social_account_id, sa.handle, sa.profile_url, sa.is_active,
       s.followers, s.following, s.posts_count, s.engagement_rate, s.credibility,
       s.deals_30d, s.deals_90d, s.avg_interval_days, s.days_since_last,
       s.category_share, s.captured_at
FROM creator c
JOIN social_account sa ON sa.creator_id = c.id
LEFT JOIN account_snapshot s ON s.social_account_id = sa.id
WHERE c.merged_into IS NULL
ORDER BY sa.creator_id, s.captured_at DESC NULLS LAST;

CREATE VIEW v_deal_calendar AS
SELECT d.id, d.title, d.category_l1, d.open_date, d.close_date, d.is_always_on,
       d.price_krw, d.permalink,
       b.name AS brand_name,
       c.display_name AS seller_name,
       sa.handle AS seller_handle,
       'https://www.instagram.com/' || sa.handle AS instagram_url
FROM deal d
LEFT JOIN brand b ON b.id = d.brand_id
LEFT JOIN creator c ON c.id = d.creator_id
LEFT JOIN social_account sa ON sa.id = d.social_account_id
WHERE d.status = 'active';
