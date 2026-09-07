-- 011: 발송 (blast) — 한 번의 발송을 처음부터 끝까지 담는다
--
-- 기존 화면은 캠페인 중심이었다. 캠페인을 먼저 만들고, 대상을 담고, 시퀀스가
-- 돌기를 기다린다 — 여러 번에 걸쳐 관계를 쌓는 아웃리치에는 맞지만 "지금 이
-- 사람들에게 이 내용을 보낸다" 는 단순한 일에는 단계가 너무 많다.
--
-- blast 는 그 단순한 일 하나다: 채널 · 대상 · 문안 · 발송 · 결과.
--
-- 엔진을 새로 만들지 않는다. campaign_member 를 그대로 쓴다 — 정책 게이트,
-- 발신 계정 상한, 수신거부, 회신 매핑(reply_token), 메시지 기록이 전부 그
-- 표에 붙어 있다. 병렬 경로를 만들면 회신이 안 붙거나 수신거부가 새어 나간다.
-- 그래서 blast 는 캠페인 하나를 껍데기로 쥐고, 화면만 직선으로 보여준다.

CREATE TABLE IF NOT EXISTS blast (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  channel       text NOT NULL,
  campaign_id   uuid REFERENCES campaign(id) ON DELETE SET NULL,
  -- 이메일일 때 어느 발신함으로 나가는가. mailbox 에 등록된 주소만.
  mailbox_email text REFERENCES mailbox(email) ON DELETE SET NULL,
  subject       text,
  body          text,
  -- 대상 필터. 무엇으로 골랐는지 나중에 답할 수 있어야 한다.
  filters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  state         text NOT NULL DEFAULT 'draft',
  target_count  integer NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  CONSTRAINT blast_state_valid CHECK (state IN ('draft', 'targeted', 'sending', 'done'))
);

CREATE INDEX IF NOT EXISTS blast_recent ON blast (created_at DESC);

-- 어떤 발송으로 나간 메시지인지. 결과 화면이 이걸로 집계한다.
ALTER TABLE message ADD COLUMN IF NOT EXISTS blast_id uuid REFERENCES blast(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS message_blast ON message (blast_id) WHERE blast_id IS NOT NULL;

ALTER TABLE outreach_task ADD COLUMN IF NOT EXISTS blast_id uuid REFERENCES blast(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS outreach_task_blast ON outreach_task (blast_id) WHERE blast_id IS NOT NULL;
