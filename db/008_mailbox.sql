-- 008: 공용 메일함 등록 (서비스 계정 + 도메인 전체 위임)
--
-- 사용자 OAuth 동의를 쓰지 않는다. Workspace 도메인 위임으로 서버가 회사 계정을
-- 대신(impersonate)한다 — 계정마다 동의를 받을 필요가 없고, 리프레시 토큰을
-- 저장·갱신할 일도 없다.
--
-- 대신 서비스 계정 키가 도메인 마스터키다. sub 에 아무 주소나 넣으면 그 계정이
-- 되므로, 코드가 impersonate 할 수 있는 주소를 이 표 안으로 제한한다.
-- 임의 입력값을 sub 에 그대로 넣으면 안 된다.

CREATE TABLE IF NOT EXISTS mailbox (
  email             text PRIMARY KEY,
  label             text,
  enabled           boolean NOT NULL DEFAULT true,   -- 수집 on/off
  is_default        boolean NOT NULL DEFAULT false,  -- 아웃바운드 기본 발신함
  sender_id         uuid REFERENCES sender(id) ON DELETE SET NULL,
  last_sync_at      timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- 기본 발신함은 하나뿐이어야 한다. 둘이면 어느 주소로 나갈지 코드가 임의로 고른다.
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_one_default ON mailbox (is_default) WHERE is_default;

-- 사용자 OAuth 방식에 쓰려던 표. 서비스 계정 방식으로 바꾸면서 쓰이지 않는다.
-- 남겨두면 "토큰이 어디 저장되지" 를 찾을 때 잘못된 곳을 보게 된다.
DROP TABLE IF EXISTS oauth_state;
DROP TABLE IF EXISTS oauth_credential;
