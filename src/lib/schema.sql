-- 아웃리치 콘솔 스키마
-- 설계 원칙
--  1) 공통 자연키는 인스타 핸들 하나뿐 → handle_norm 으로 정규화해 매칭한다.
--  2) 소스별 원 PK 는 절대 매칭 키로 쓰지 않고 source_ref 에 역추적용으로 보존한다.
--  3) 원문/이미지는 저장하지 않는다. 저장하는 것은 파생 지표와 링크백뿐이다.
--  4) 임포트는 덮어쓰지 않는다. observed_at 이 찍힌 스냅샷을 쌓고 델타를 뽑는다.

PRAGMA foreign_keys = ON;

-- ---------- 크리에이터 / 계정 ----------
CREATE TABLE IF NOT EXISTS creator (
  id                INTEGER PRIMARY KEY,
  display_name      TEXT    NOT NULL,
  tier              TEXT    NOT NULL DEFAULT 'micro',   -- nano | micro | mid | mega
  primary_category  TEXT,
  region            TEXT,
  curated           INTEGER NOT NULL DEFAULT 0,          -- 맘캘린더 사람 검증 큐레이션 플래그
  note              TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS social_account (
  id           INTEGER PRIMARY KEY,
  creator_id   INTEGER NOT NULL REFERENCES creator(id) ON DELETE CASCADE,
  platform     TEXT    NOT NULL DEFAULT 'instagram',
  handle       TEXT    NOT NULL,           -- 표시용 원본 핸들
  handle_norm  TEXT    NOT NULL,           -- 매칭 키: 소문자 + 구두점 제거
  is_primary   INTEGER NOT NULL DEFAULT 1,
  status       TEXT    NOT NULL DEFAULT 'active',  -- active | renamed | inactive
  UNIQUE(platform, handle)
);
CREATE INDEX IF NOT EXISTS ix_account_norm ON social_account(handle_norm);

-- 핸들 변경 이력. 소스 PK 가 같은데 핸들이 달라지면 여기에 쌓고 병합 검토 큐로 넘긴다.
CREATE TABLE IF NOT EXISTS handle_alias (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES social_account(id) ON DELETE CASCADE,
  handle      TEXT    NOT NULL,
  handle_norm TEXT    NOT NULL,
  observed_at TEXT    NOT NULL
);

-- 팔로워 등은 시점 값이다. 덮어쓰지 않고 스냅샷으로 쌓는다.
CREATE TABLE IF NOT EXISTS account_snapshot (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES social_account(id) ON DELETE CASCADE,
  observed_at    TEXT    NOT NULL,
  followers      INTEGER,
  following      INTEGER,
  posts_count    INTEGER,
  last_active_at TEXT,
  precision      INTEGER NOT NULL DEFAULT 0,  -- "10.8만" 처럼 반올림된 값의 오차 폭(±)
  source         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_snap_acct ON account_snapshot(account_id, observed_at DESC);

-- 소스별 원 PK / 원문 URL 보존. 매칭 키가 아니라 역추적용이다.
CREATE TABLE IF NOT EXISTS source_ref (
  id          INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,               -- creator | account | deal | brand
  entity_id   INTEGER NOT NULL,
  source      TEXT NOT NULL,               -- momcal | pang | ingong
  source_pk   TEXT,
  source_url  TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, source)
);

-- 인공에서 들어오는 파생 지표. 우리 deal 테이블보다 이력이 길어 기준값으로 쓴다.
CREATE TABLE IF NOT EXISTS creator_metric (
  creator_id       INTEGER PRIMARY KEY REFERENCES creator(id) ON DELETE CASCADE,
  deals_30d        INTEGER,
  deals_90d        INTEGER,
  avg_cadence_days REAL,
  last_deal_on     TEXT,
  source           TEXT,
  computed_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS category_share (
  creator_id INTEGER NOT NULL REFERENCES creator(id) ON DELETE CASCADE,
  category   TEXT    NOT NULL,
  pct        REAL    NOT NULL,
  PRIMARY KEY (creator_id, category)
);

-- ---------- 브랜드 / 딜 ----------
CREATE TABLE IF NOT EXISTS brand (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  category      TEXT,
  in_dictionary INTEGER NOT NULL DEFAULT 1,  -- 맘캘린더 브랜드 사전에 있었는가
  alias_of      INTEGER REFERENCES brand(id),
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deal (
  id            INTEGER PRIMARY KEY,
  brand_id      INTEGER REFERENCES brand(id),
  account_id    INTEGER NOT NULL REFERENCES social_account(id) ON DELETE CASCADE,
  product_name  TEXT    NOT NULL,
  category      TEXT,
  starts_on     TEXT,                       -- is_always_on = 1 이면 NULL
  ends_on       TEXT,
  price         INTEGER,
  is_always_on  INTEGER NOT NULL DEFAULT 0, -- 상시 공구는 캘린더/D-DAY 집계에서 분리한다
  picked        INTEGER NOT NULL DEFAULT 0, -- 우리가 찜한 공구
  source        TEXT,
  source_url    TEXT,
  first_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT,
  gone_at       TEXT                        -- 원문 404/410 → tombstone
);
CREATE INDEX IF NOT EXISTS ix_deal_acct  ON deal(account_id, starts_on DESC);
CREATE INDEX IF NOT EXISTS ix_deal_brand ON deal(brand_id, starts_on DESC);

-- ---------- 연락처 / 차단 ----------
CREATE TABLE IF NOT EXISTS contact_point (
  id           INTEGER PRIMARY KEY,
  creator_id   INTEGER NOT NULL REFERENCES creator(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,            -- email | ig_dm | inpock | linktree | kakao | sms
  value        TEXT    NOT NULL,
  source_desc  TEXT    NOT NULL,            -- 개인정보 수집 출처. 문의 시 즉답할 수 있어야 한다.
  collected_at TEXT    NOT NULL,
  collected_by TEXT    NOT NULL,
  consent      TEXT    NOT NULL DEFAULT 'implied_public', -- implied_public | opt_in | none
  note         TEXT,
  UNIQUE(creator_id, kind, value)
);

-- 수신거부 / 연락 금지. 영구이며 만료일을 둘 수 없다.
CREATE TABLE IF NOT EXISTS suppression (
  id          INTEGER PRIMARY KEY,
  identifier  TEXT NOT NULL,
  kind        TEXT NOT NULL,                -- email | handle | domain
  reason      TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'all',  -- all | email
  created_at  TEXT NOT NULL,
  UNIQUE(identifier, kind)
);

-- ---------- 채널 정책 / 발신 계정 ----------
-- 코드가 아니라 이 표가 발송 워커를 통제한다.
CREATE TABLE IF NOT EXISTS channel_policy (
  channel        TEXT PRIMARY KEY,
  cold_allowed   INTEGER NOT NULL,
  execution      TEXT    NOT NULL,          -- auto | manual_queue | auto_after_consent
  night_block    TEXT,                      -- "21-08" 또는 NULL
  ad_label       INTEGER NOT NULL DEFAULT 0,
  unsub_required INTEGER NOT NULL DEFAULT 0,
  daily_cap      INTEGER,
  cooldown_days  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sender_account (
  id           INTEGER PRIMARY KEY,
  identifier   TEXT NOT NULL UNIQUE,        -- partner@dinostudio.kr 또는 @dino_partner
  channel      TEXT NOT NULL,
  daily_cap    INTEGER NOT NULL,
  sent_today   INTEGER NOT NULL DEFAULT 0,
  age_days     INTEGER NOT NULL DEFAULT 999,
  ramp_day     INTEGER,                     -- 램프업 중이면 D+n
  status       TEXT NOT NULL DEFAULT 'ok',  -- ok | ramping | suspended
  paused_until TEXT
);

-- ---------- 캠페인 ----------
CREATE TABLE IF NOT EXISTS campaign (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  brand_id       INTEGER REFERENCES brand(id),
  category       TEXT NOT NULL,
  starts_on      TEXT NOT NULL,
  ends_on        TEXT NOT NULL,
  commission_pct REAL,
  status         TEXT NOT NULL DEFAULT 'active',
  reply_token    TEXT NOT NULL UNIQUE       -- Reply-To 플러스 주소의 cm_{token}
);

CREATE TABLE IF NOT EXISTS campaign_target (
  id          INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  creator_id  INTEGER NOT NULL REFERENCES creator(id) ON DELETE CASCADE,
  stage       TEXT    NOT NULL DEFAULT 'contacted', -- contacted|replied|negotiating|confirmed|running|dropped
  gmv         INTEGER NOT NULL DEFAULT 0,
  step        INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(campaign_id, creator_id)
);

-- ---------- 커뮤니케이션 ----------
-- 회사 메일 한 개(partner@)로 돈다. Reply-To 의 +cm_{token} 이 회신을 캠페인·크리에이터에 매핑한다.
CREATE TABLE IF NOT EXISTS thread (
  id             INTEGER PRIMARY KEY,
  thread_key     TEXT NOT NULL UNIQUE,      -- Gmail threadId
  campaign_id    INTEGER REFERENCES campaign(id) ON DELETE SET NULL,
  creator_id     INTEGER NOT NULL REFERENCES creator(id) ON DELETE CASCADE,
  reply_to       TEXT NOT NULL,             -- partner+cm_{token}.{creator}@dinostudio.kr
  classification TEXT,                      -- 아래 CLASSIFICATIONS 참고
  assignee       TEXT,
  sequence_state TEXT NOT NULL DEFAULT 'running', -- running | stopped_by_reply
  last_at        TEXT NOT NULL,
  sla_due_at     TEXT
);

CREATE TABLE IF NOT EXISTS message (
  id         INTEGER PRIMARY KEY,
  thread_id  INTEGER NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL,                 -- out | in
  sender     TEXT NOT NULL,
  body       TEXT NOT NULL,
  sent_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_msg_thread ON message(thread_id, sent_at);

-- ---------- 작업 큐 (사람이 처리하는 채널) ----------
CREATE TABLE IF NOT EXISTS task (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,               -- ig_dm | inpock | reply_check
  creator_id   INTEGER NOT NULL REFERENCES creator(id) ON DELETE CASCADE,
  campaign_id  INTEGER REFERENCES campaign(id) ON DELETE SET NULL,
  sender_id    INTEGER REFERENCES sender_account(id) ON DELETE SET NULL,
  body         TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | done | recalled
  done_at      TEXT
);

-- ---------- 발송 기록 ----------
CREATE TABLE IF NOT EXISTS outreach_log (
  id          INTEGER PRIMARY KEY,
  creator_id  INTEGER NOT NULL REFERENCES creator(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaign(id) ON DELETE SET NULL,
  channel     TEXT NOT NULL,
  sent_at     TEXT NOT NULL,
  result      TEXT NOT NULL DEFAULT 'sent'  -- sent | replied | bounced | no_reply
);
CREATE INDEX IF NOT EXISTS ix_log_creator ON outreach_log(creator_id, channel, sent_at DESC);

CREATE TABLE IF NOT EXISTS send_run (
  id          INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,
  planned     INTEGER NOT NULL,
  queued      INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  eta         TEXT,
  status      TEXT NOT NULL DEFAULT 'queued'
);

-- ---------- 임포트 ----------
CREATE TABLE IF NOT EXISTS import_batch (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,
  filename    TEXT NOT NULL,
  rows        INTEGER NOT NULL DEFAULT 0,
  created     INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  review      INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT NOT NULL DEFAULT 'jay',
  status      TEXT NOT NULL DEFAULT 'analyzed', -- analyzed | applied
  created_at  TEXT NOT NULL,
  applied_at  TEXT,
  mapping     TEXT                              -- 확정된 컬럼 매핑 JSON
);

CREATE TABLE IF NOT EXISTS import_row (
  id          INTEGER PRIMARY KEY,
  batch_id    INTEGER NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  line_no     INTEGER NOT NULL,
  raw         TEXT NOT NULL,                    -- 원본 행 JSON
  handle_norm TEXT,
  verdict     TEXT NOT NULL,                    -- new | merge | review | error
  score       REAL,
  reason      TEXT,
  match_id    INTEGER,                          -- social_account.id
  decision    TEXT                              -- merge | split | null(미처리)
);

-- ---------- 변화 감지 ----------
CREATE TABLE IF NOT EXISTS delta_event (
  id         INTEGER PRIMARY KEY,
  batch_id   INTEGER REFERENCES import_batch(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,   -- new|conflict|brand|timing|gone|handle|price|surge|dead
  title      TEXT NOT NULL,
  subject    TEXT NOT NULL,
  detail     TEXT NOT NULL,
  handle     TEXT,
  created_at TEXT NOT NULL,
  seen       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS watchlist (
  id          INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL,  -- brand | seller | keyword | category
  target      TEXT NOT NULL,
  condition   TEXT NOT NULL,
  last_hit_at TEXT,
  UNIQUE(target_type, target)
);

-- ---------- 서킷브레이커 ----------
CREATE TABLE IF NOT EXISTS circuit_metric (
  key        TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  value      REAL NOT NULL,
  warn_at    REAL NOT NULL,
  stop_at    REAL,
  unit       TEXT NOT NULL DEFAULT '%',
  action     TEXT NOT NULL
);

-- ---------- 적합도 캐시 ----------
-- 1,742명을 매 요청마다 점수화하면 정렬 한 번에 수천 쿼리가 된다.
-- 캠페인별로 한 번 계산해 두고, 딜·수신거부·연락처가 바뀌면 무효화한다.
CREATE TABLE IF NOT EXISTS fit_cache (
  campaign_id    INTEGER NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  creator_id     INTEGER NOT NULL REFERENCES creator(id) ON DELETE CASCADE,
  score          INTEGER NOT NULL,
  excluded       INTEGER NOT NULL,
  exclude_reason TEXT,
  reasons        TEXT NOT NULL,
  computed_at    TEXT NOT NULL,
  PRIMARY KEY (campaign_id, creator_id)
);
CREATE INDEX IF NOT EXISTS ix_fit_score ON fit_cache(campaign_id, score DESC);
